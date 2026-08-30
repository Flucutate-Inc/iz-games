/**
 * エゴコロクイズの部屋(サーバー権威)。
 *
 * 1人が描き手、残りが回答者。お題を絵で伝え、回答者はひらがなで当てる。
 * 原作から引き継いだ設計判断は design/oekaki-no-mori-research.md を参照:
 *   - 得点は残り時間に比例し、**描き手にも入る**(命題2: 得点は「通じた度合い」の計測器)
 *   - 誤答にペナルティはない / レート・ランキングは持たない
 *   - 「描き手拒否」で回答専門に回れる(参加ハードルを下げる装置)
 *   - 対戦の最後に**推薦コーナー**を挟む。全ラウンドの絵から1人1票で好きな絵を選び、
 *     コメントを添える。推薦は「その絵へのいいね+コメント」としてそのままギャラリーに残る。
 *     (以前は推薦→本人が投稿を選ぶゲートだったが、全作品を常時公開する方針に変えた。
 *      ギャラリーのいいね・コメントが常設になったので、推薦は審査ではなく賞賛の儀式)
 * スマホ向けに変えたのは主に**セッション長**で、原作の7枚から3枚に短縮した。
 *
 * 部屋の状態はメモリにしか置かない。永続するのはアカウントと作品(ギャラリー)だけ。
 */

import { isCorrect } from './kana.js';

export const RULES = {
  minPlayers: 2,
  maxPlayers: 6,
  /** 既定値。部屋ごとに待機画面で変えられる(下の CHOICES から選ぶ) */
  laps: 1,
  roundMs: 60_000,
  revealMs: 6_000,
  /** 推薦コーナーの持ち時間(原作は7枚構成で106秒。3枚構成に合わせて縮めた) */
  recommendMs: 25_000,
  commentMaxLen: 80,
  /**
   * 1枚あたりの上限(荒らし・事故対策)。
   * クライアントは1本が maxPointsPerStroke に近づくと自動で線を分割する
   * (public/js/draw.js の SPLIT_POINTS)ので、実際に効くのは本数と総点数の上限。
   * ぐるぐる塗りつぶしでも届きにくい値にしてある。
   */
  maxStrokes: 2000,
  maxPointsPerStroke: 400,
  maxPointsTotal: 60_000,
  /** 得点 */
  solveBase: 20,
  solveBonus: 80,
  drawerPerSolver: 30,
};

/**
 * 待機画面で選べる設定。サーバーはこの一覧にある値しか受け付けない
 * (クライアントが勝手な数値を送っても弾く)。
 * 「サクッと」を上に置く: スマホの隙間時間に1試合終わることを優先した。
 */
export const CHOICES = {
  /** 何周するか。1周 = 描き手になれる人が全員1回ずつ描く */
  laps: [1, 2, 3],
  /** 1枚に使える時間(描く=当てるの制限時間) */
  roundMs: [30_000, 60_000, 90_000],
  /** 答え合わせの表示時間 */
  revealMs: [3_000, 6_000],
};

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 紛らわしい I/O/0/1 を除く

function randomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return [...bytes].map(b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

function send(ws, obj) {
  try {
    ws.send(JSON.stringify(obj));
  } catch {
    /* 切断済み。close ハンドラで片付く */
  }
}

class Player {
  constructor(user, ws) {
    this.userId = user.id;
    this.displayName = user.display_name;
    this.ws = ws;
    this.score = 0;
    this.ready = false;
    this.connected = true;
    /** 描き手拒否(原作の同名機能)。回答専門で参加できる */
    this.noDraw = false;
  }

  publicView(room) {
    return {
      userId: this.userId,
      displayName: this.displayName,
      score: this.score,
      ready: this.ready,
      connected: this.connected,
      noDraw: this.noDraw,
      isDrawer: room.drawerId === this.userId,
      solved: room.solvers.some(s => s.userId === this.userId),
    };
  }
}

class Room {
  constructor(code, open, rooms) {
    this.code = code;
    this.open = open; // ランダムマッチの対象にするか
    this.rooms = rooms;
    this.players = new Map(); // userId -> Player
    this.state = 'waiting'; // waiting | playing | reveal | recommend | ended
    this.roundIndex = -1;
    this.drawerId = null;
    this.topic = null;
    this.strokes = [];
    this.pointCount = 0;
    /** 描き手のキャンバスの 高さ/幅。ギャラリーで同じ形に再生するために保存する */
    this.ar = 4 / 3;
    this.solvers = [];
    this.endsAt = 0;
    this.timer = null;
    this.usedTopics = new Set();
    this.drawerQueue = [];
    /** お題の難易度。1=かんたん / 2=ふつう / 3=むずかしい */
    this.level = 1;
    /** 待機画面で変えられる進行設定(既定は RULES) */
    this.laps = RULES.laps;
    this.roundMs = RULES.roundMs;
    this.revealMs = RULES.revealMs;
    /** 実際の枚数。開始時に「周回数 × 描き手の人数」で確定する */
    this.totalRounds = 0;
    /** その試合で描かれた絵(全ラウンド分)。推薦コーナーの対象になる */
    this.matchDrawings = [];
    /** 推薦コーナーでの投票 [{ voterId, voterName, drawingId, comment }] */
    this.recommendations = [];
  }

  get connectedPlayers() {
    return [...this.players.values()].filter(p => p.connected);
  }

  broadcast(obj, exceptUserId = null) {
    for (const p of this.players.values()) {
      if (!p.connected || p.userId === exceptUserId) continue;
      send(p.ws, obj);
    }
  }

  clearTimer() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** 部屋の状態まとめ(参加時と変化時に送る) */
  snapshot() {
    return {
      t: 'room',
      code: this.code,
      state: this.state,
      rules: {
        laps: this.laps,
        roundMs: this.roundMs,
        revealMs: this.revealMs,
        // 待機中は「いま始めたら何枚になるか」の見込み、開始後は確定値
        totalRounds: this.totalRounds || this.laps * this.drawerCount(),
        drawerCount: this.drawerCount(),
        minPlayers: RULES.minPlayers,
        maxPlayers: RULES.maxPlayers,
      },
      roundIndex: this.roundIndex,
      drawerId: this.drawerId,
      endsAt: this.endsAt,
      level: this.level,
      players: [...this.players.values()].map(p => p.publicView(this)),
    };
  }

  pushState() {
    this.broadcast(this.snapshot());
  }

  // ─── 参加・離脱 ────────────────────────────────────────

  add(user, ws) {
    const existing = this.players.get(user.id);
    if (existing) {
      // 同じアカウントの再接続。古いソケットは閉じる
      if (existing.ws !== ws) {
        try {
          existing.ws.close(4000, '別の端末で接続しました');
        } catch { /* すでに閉じている */ }
      }
      existing.ws = ws;
      existing.connected = true;
      return existing;
    }
    const p = new Player(user, ws);
    this.players.set(user.id, p);
    return p;
  }

  remove(userId) {
    const p = this.players.get(userId);
    if (!p) return;
    this.players.delete(userId);
    this.afterPlayerGone(userId);
  }

  markDisconnected(userId) {
    const p = this.players.get(userId);
    if (!p) return;
    p.connected = false;
    p.ready = false;
    // 待機中はそのまま消す。対戦中は席を残して再接続を待つ
    if (this.state === 'waiting' || this.state === 'ended') {
      this.players.delete(userId);
    }
    this.afterPlayerGone(userId);
  }

  afterPlayerGone(userId) {
    if (this.players.size === 0) {
      this.clearTimer();
      this.rooms.dispose(this.code);
      return;
    }
    if ((this.state === 'playing' || this.state === 'reveal') && this.connectedPlayers.length < RULES.minPlayers) {
      this.abort('人数が足りなくなりました');
      return;
    }
    if (this.state === 'playing' && this.drawerId === userId) {
      this.broadcast({ t: 'notice', message: '描き手が切断しました' });
      this.endRound();
      return;
    }
    this.pushState();
    if (this.state === 'waiting') this.maybeStart();
  }

  // ─── 開始 ──────────────────────────────────────────────

  setReady(userId, ready) {
    const p = this.players.get(userId);
    if (!p || this.state !== 'waiting') return;
    p.ready = !!ready;
    this.pushState();
    this.maybeStart();
  }

  /** 待機中はだれでも変えられる(部屋の設定。原作にも難易度選択がある) */
  setLevel(userId, level) {
    if (this.state !== 'waiting') return;
    if (!this.players.has(userId)) return;
    const lv = Number(level);
    if (![1, 2, 3].includes(lv)) return;
    this.level = lv;
    this.pushState();
  }

  /**
   * 枚数・1枚の時間・答え合わせの時間。待機中だけ変えられる。
   * 値は CHOICES にあるものだけ受け付ける。
   */
  setConfig(userId, patch) {
    if (this.state !== 'waiting') return;
    if (!this.players.has(userId)) return;
    let changed = false;
    for (const key of ['laps', 'roundMs', 'revealMs']) {
      if (patch[key] === undefined) continue;
      const v = Number(patch[key]);
      if (!CHOICES[key].includes(v)) continue;
      this[key] = v;
      changed = true;
    }
    if (changed) this.pushState();
  }

  setNoDraw(userId, noDraw) {
    const p = this.players.get(userId);
    if (!p) return;
    p.noDraw = !!noDraw;
    this.pushState();
  }

  /** 描き手になれる人の数(描き手拒否を除く。全員が拒否なら全員が対象) */
  drawerCount() {
    const eligible = this.connectedPlayers.filter(p => !p.noDraw);
    return (eligible.length ? eligible : this.connectedPlayers).length;
  }

  /** 原作と同じで、全員が準備完了になったら自動で始まる */
  maybeStart() {
    if (this.state !== 'waiting') return;
    const players = this.connectedPlayers;
    if (players.length < RULES.minPlayers) return;
    if (!players.every(p => p.ready)) return;
    this.start();
  }

  start() {
    this.state = 'playing';
    this.roundIndex = -1;
    this.usedTopics = new Set();
    this.drawerQueue = [];
    // level / laps は待機中に選ばれた設定なので、ここでは触らない。
    // 「全員が同じ回数だけ描く」ように、枚数は周回数 × 描き手の人数で決める
    this.totalRounds = Math.max(1, this.laps * this.drawerCount());
    this.matchDrawings = [];
    this.recommendations = [];
    for (const p of this.players.values()) p.score = 0;
    this.open = false; // 開始した部屋には途中参加させない
    this.nextRound();
  }

  /** 描き手を公平に回す。全員が1周するまで同じ人は選ばない */
  pickDrawer() {
    const eligible = this.connectedPlayers.filter(p => !p.noDraw);
    const pool = eligible.length ? eligible : this.connectedPlayers; // 全員が拒否なら拒否を無視する
    this.drawerQueue = this.drawerQueue.filter(id => pool.some(p => p.userId === id));
    if (this.drawerQueue.length === 0) {
      this.drawerQueue = pool.map(p => p.userId);
      // シャッフル
      for (let i = this.drawerQueue.length - 1; i > 0; i--) {
        const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
        [this.drawerQueue[i], this.drawerQueue[j]] = [this.drawerQueue[j], this.drawerQueue[i]];
      }
    }
    return this.drawerQueue.shift();
  }

  pickTopic() {
    const all = this.rooms.topics;
    // 選ばれたレベルのお題だけを使う(見つからなければ全部から)
    const byLevel = all.filter(t => t.level === this.level);
    const scope = byLevel.length ? byLevel : all;
    const fresh = scope.filter(t => !this.usedTopics.has(all.indexOf(t)));
    const pool = fresh.length ? fresh : scope;
    const idx = crypto.getRandomValues(new Uint32Array(1))[0] % pool.length;
    const topic = pool[idx];
    this.usedTopics.add(all.indexOf(topic));
    return topic;
  }

  nextRound() {
    this.clearTimer();
    if (this.roundIndex + 1 >= this.totalRounds) {
      this.startRecommend();
      return;
    }
    this.roundIndex += 1;
    this.state = 'playing';
    this.drawerId = this.pickDrawer();
    this.topic = this.pickTopic();
    this.strokes = [];
    this.pointCount = 0;
    this.ar = 4 / 3;
    this.solvers = [];
    this.endsAt = Date.now() + this.roundMs;

    for (const p of this.players.values()) {
      if (!p.connected) continue;
      send(p.ws, {
        t: 'round',
        roundIndex: this.roundIndex,
        rounds: this.totalRounds,
        drawerId: this.drawerId,
        endsAt: this.endsAt,
        // お題は描き手にだけ渡す。読み(answer)も一緒に渡して、
        // 「どう書けば正解になるか」が描き手に見えるようにする(漢字のお題があるため)
        topic:
          p.userId === this.drawerId
            ? { label: this.topic.label, answer: this.topic.answer }
            : null,
      });
    }
    this.pushState();
    this.timer = setTimeout(() => this.endRound(), this.roundMs);
  }

  // ─── 描画 ──────────────────────────────────────────────

  strokeStart(userId, msg) {
    if (this.state !== 'playing' || userId !== this.drawerId) return;
    if (this.strokes.length >= RULES.maxStrokes) return;
    const c = msg.c | 0;
    const w = msg.w | 0;
    const p = sanitizePoints(msg.p);
    if (!p.length) return;
    const ar = Number(msg.ar);
    if (Number.isFinite(ar) && ar > 0.2 && ar < 5) this.ar = Math.round(ar * 1000) / 1000;
    const stroke = { id: String(msg.id || this.strokes.length), u: userId, c, w, p };
    this.strokes.push(stroke);
    this.pointCount += p.length / 2;
    this.broadcast({ t: 's0', id: stroke.id, c, w, p }, userId);
  }

  strokeAppend(userId, msg) {
    if (this.state !== 'playing' || userId !== this.drawerId) return;
    const stroke = this.strokes[this.strokes.length - 1];
    if (!stroke || stroke.id !== String(msg.id)) return;
    if (this.pointCount >= RULES.maxPointsTotal) return;
    const p = sanitizePoints(msg.p);
    if (!p.length) return;
    if (stroke.p.length / 2 + p.length / 2 > RULES.maxPointsPerStroke) return;
    stroke.p.push(...p);
    this.pointCount += p.length / 2;
    this.broadcast({ t: 's+', id: stroke.id, p }, userId);
  }

  undo(userId) {
    if (this.state !== 'playing' || userId !== this.drawerId) return;
    // 作者IDつきなので「その人の最後の線」だけを戻せる
    for (let i = this.strokes.length - 1; i >= 0; i--) {
      if (this.strokes[i].u === userId) {
        this.pointCount -= this.strokes[i].p.length / 2;
        this.strokes.splice(i, 1);
        break;
      }
    }
    this.broadcast({ t: 'undo', u: userId }, userId);
  }

  clearCanvas(userId) {
    if (this.state !== 'playing' || userId !== this.drawerId) return;
    this.strokes = [];
    this.pointCount = 0;
    this.broadcast({ t: 'clear' }, userId);
  }

  // ─── 回答 ──────────────────────────────────────────────

  guess(userId, rawText) {
    if (this.state !== 'playing') return;
    const p = this.players.get(userId);
    if (!p || !p.connected) return;
    const text = String(rawText || '').slice(0, 24);
    if (!text) return;
    // 描き手は回答できない(原作どおり、描き手の発言はヒントとして流れるだけ)
    if (userId === this.drawerId) {
      this.broadcast({ t: 'chat', userId, displayName: p.displayName, text, fromDrawer: true });
      return;
    }
    if (this.solvers.some(s => s.userId === userId)) return; // 正解済みは打ち止め

    if (isCorrect(text, this.topic)) {
      const remain = Math.max(0, this.endsAt - Date.now());
      const ratio = Math.min(1, remain / this.roundMs);
      const points = RULES.solveBase + Math.round(RULES.solveBonus * ratio);
      p.score += points;
      this.solvers.push({ userId, displayName: p.displayName, points });
      // 正解の文字列そのものは流さない(まだ当てていない人にバレるため)
      this.broadcast({
        t: 'correct',
        userId,
        displayName: p.displayName,
        points,
        order: this.solvers.length,
      });
      this.pushState();

      const answerers = this.connectedPlayers.filter(x => x.userId !== this.drawerId);
      if (answerers.length > 0 && this.solvers.length >= answerers.length) this.endRound();
      return;
    }
    // 誤答にペナルティはない。ただ流れるだけ
    this.broadcast({ t: 'chat', userId, displayName: p.displayName, text });
  }

  // ─── ラウンド終了 ──────────────────────────────────────

  endRound() {
    if (this.state !== 'playing') return;
    this.clearTimer();
    this.state = 'reveal';

    const drawer = this.players.get(this.drawerId);
    const drawerPoints = RULES.drawerPerSolver * this.solvers.length;
    if (drawer) drawer.score += drawerPoints;

    // 作品を保存する。描いた時点でギャラリーに並ぶ(全作品を常時公開する方針)
    let drawingId = null;
    if (drawer && this.strokes.length > 0) {
      try {
        drawingId = this.rooms.db.saveDrawing({
          userId: drawer.userId,
          displayName: drawer.displayName,
          topicLabel: this.topic.label,
          strokes: this.strokes,
          ar: this.ar,
          solved: this.solvers.length > 0,
          solverName: this.solvers[0] ? this.solvers[0].displayName : null,
          roomCode: this.code,
          mode: 'quiz',
        });
        this.matchDrawings.push({
          drawingId,
          drawerId: drawer.userId,
          displayName: drawer.displayName,
          topic: this.topic.label,
          strokes: this.strokes,
          ar: this.ar,
        });
      } catch (e) {
        console.error('作品の保存に失敗しました:', e && e.message);
      }
    }

    this.broadcast({
      t: 'reveal',
      // 何枚目の答え合わせかを明示する(遅れて届いた古い reveal と取り違えないため)
      roundIndex: this.roundIndex,
      topic: this.topic.label,
      drawerId: this.drawerId,
      drawerPoints,
      solvers: this.solvers,
      drawingId,
      nextInMs: this.revealMs,
      isLast: this.roundIndex + 1 >= this.totalRounds,
    });
    this.pushState();

    this.timer = setTimeout(() => this.nextRound(), this.revealMs);
  }

  // ─── 推薦コーナー ────────────────────────────────────────

  /**
   * 最終ラウンドの答え合わせが終わったら呼ばれる。
   * その試合で1枚も絵が残らなかった(全ラウンド0ストローク)なら、推薦する対象がないので
   * そのまま結果画面へ進む。
   */
  startRecommend() {
    this.clearTimer();
    if (!this.matchDrawings.length) {
      this.finish();
      return;
    }
    this.state = 'recommend';
    this.recommendations = [];
    this.endsAt = Date.now() + RULES.recommendMs;
    this.broadcast({
      t: 'recommendStart',
      endsAt: this.endsAt,
      // 全員の全ラウンド分をまとめて見せる(原作の推薦コーナーと同じ)
      drawings: this.matchDrawings.map(d => ({
        drawingId: d.drawingId,
        drawerId: d.drawerId,
        displayName: d.displayName,
        topic: d.topic,
        strokes: d.strokes,
        ar: d.ar,
      })),
    });
    this.pushState();
    this.timer = setTimeout(() => this.finishRecommend(), RULES.recommendMs);
  }

  /** 1人1票。自分の絵には推薦できない(自薦できないから承認に重みが出る=命題6) */
  recommend(userId, drawingId, comment) {
    if (this.state !== 'recommend') return;
    const voter = this.players.get(userId);
    if (!voter) return;
    const target = this.matchDrawings.find(d => d.drawingId === drawingId);
    if (!target) return;
    if (target.drawerId === userId) return;

    const text = String(comment || '').slice(0, RULES.commentMaxLen);
    this.recommendations = this.recommendations.filter(r => r.voterId !== userId);
    this.recommendations.push({ voterId: userId, voterName: voter.displayName, drawingId, comment: text });
    this.broadcast({ t: 'recommended', voterId: userId, count: this.recommendations.length });

    // 投票できる全員(自分の絵しか無い人は除く)が投票し終えたら待たずに進める
    const eligible = this.connectedPlayers.filter(p => this.matchDrawings.some(d => d.drawerId !== p.userId));
    if (eligible.length > 0 && this.recommendations.length >= eligible.length) {
      this.finishRecommend();
    }
  }

  /**
   * 推薦を締め切る。各票は「その絵へのいいね+コメント」としてギャラリーに直接残す。
   * 結果を全員に見せてから結果画面へ。
   */
  finishRecommend() {
    if (this.state !== 'recommend') return;
    this.clearTimer();

    const byDrawing = new Map();
    for (const r of this.recommendations) {
      try {
        this.rooms.db.toggleLikeOn(r.drawingId, r.voterId);
        if (r.comment) {
          this.rooms.db.addComment(r.drawingId, r.voterId, r.voterName, r.comment);
        }
      } catch (e) {
        console.error('推薦の記録に失敗しました:', e && e.message);
      }
      if (!byDrawing.has(r.drawingId)) byDrawing.set(r.drawingId, []);
      byDrawing.get(r.drawingId).push({ voterName: r.voterName, text: r.comment });
    }

    this.broadcast({
      t: 'recommendResult',
      results: this.matchDrawings.map(d => ({
        drawingId: d.drawingId,
        artistUserId: d.drawerId,
        displayName: d.displayName,
        topic: d.topic,
        votes: (byDrawing.get(d.drawingId) || []).length,
        comments: byDrawing.get(d.drawingId) || [],
      })),
    });
    this.finish();
  }

  finish() {
    this.clearTimer();
    this.state = 'ended';
    this.drawerId = null;
    const ranking = [...this.players.values()]
      .map(p => ({ userId: p.userId, displayName: p.displayName, score: p.score }))
      .sort((a, b) => b.score - a.score);
    const top = ranking.length ? ranking[0].score : 0;
    this.broadcast({
      t: 'end',
      ranking,
      // 同点なら全員 MVP(勝敗を決める場ではないため)
      mvp: ranking.filter(r => r.score === top && top > 0).map(r => r.userId),
    });
    for (const p of this.players.values()) p.ready = false;
    this.pushState();
  }

  abort(message) {
    this.clearTimer();
    this.state = 'waiting';
    this.drawerId = null;
    this.topic = null;
    this.strokes = [];
    this.solvers = [];
    this.open = true;
    for (const p of this.players.values()) p.ready = false;
    this.broadcast({ t: 'notice', message });
    this.pushState();
  }

  /** 結果画面から「もういちど」 */
  restart(userId) {
    if (this.state !== 'ended') return;
    this.state = 'waiting';
    this.open = this.players.size < RULES.maxPlayers;
    for (const p of this.players.values()) p.ready = false;
    this.setReady(userId, true);
  }
}

function sanitizePoints(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  const n = Math.min(arr.length - (arr.length % 2), RULES.maxPointsPerStroke * 2);
  for (let i = 0; i < n; i++) {
    const v = Number(arr[i]);
    if (!Number.isFinite(v)) return [];
    // x も y も「キャンバスの幅」で割った値。x は 1 を大きく超えない。
    // 縦長画面の y は 1 を超える(上限 4 で十分)
    const max = i % 2 === 0 ? 1.05 : 4;
    out.push(Math.min(max, Math.max(0, Math.round(v * 1000) / 1000)));
  }
  return out;
}

/**
 * ソロモード用。対戦中は s0/s+ で少しずつ検証しながら積み上げるが、
 * ソロは描き終わった1枚を丸ごと送ってくるので、一括で同じ上限をかける。
 */
export function sanitizeStrokes(rawStrokes) {
  if (!Array.isArray(rawStrokes)) return [];
  const out = [];
  let totalPoints = 0;
  for (const raw of rawStrokes.slice(0, RULES.maxStrokes)) {
    if (!raw || typeof raw !== 'object') continue;
    const c = Math.min(8, Math.max(0, raw.c | 0));
    const w = Math.min(2, Math.max(0, raw.w | 0));
    const p = sanitizePoints(raw.p);
    if (!p.length) continue;
    if (p.length / 2 > RULES.maxPointsPerStroke) continue;
    if (totalPoints + p.length / 2 > RULES.maxPointsTotal) break;
    totalPoints += p.length / 2;
    out.push({ id: String(raw.id || out.length), u: null, c, w, p });
  }
  return out;
}

export class Rooms {
  constructor(db, topics) {
    this.db = db;
    this.topics = topics;
    this.map = new Map(); // code -> Room
    this.byUser = new Map(); // userId -> code
  }

  get(code) {
    return this.map.get(String(code || '').toUpperCase()) || null;
  }

  dispose(code) {
    const room = this.map.get(code);
    if (!room) return;
    room.clearTimer();
    this.map.delete(code);
    for (const [uid, c] of this.byUser) if (c === code) this.byUser.delete(uid);
  }

  create(open) {
    let code = randomCode();
    let guard = 0;
    while (this.map.has(code) && guard++ < 50) code = randomCode();
    const room = new Room(code, open, this);
    this.map.set(code, room);
    return room;
  }

  /** ランダムマッチ。空きのある公開部屋に入れ、無ければ作る */
  findOrCreate() {
    for (const room of this.map.values()) {
      if (room.open && room.state === 'waiting' && room.players.size < RULES.maxPlayers) return room;
    }
    return this.create(true);
  }

  join(user, ws, code, create) {
    // すでにどこかにいるなら抜けてから入る
    const prev = this.byUser.get(user.id);
    if (prev && prev !== String(code || '').toUpperCase()) {
      const prevRoom = this.map.get(prev);
      if (prevRoom) prevRoom.remove(user.id);
      this.byUser.delete(user.id);
    }

    let room;
    if (create) {
      // 身内だけの部屋。ランダムマッチには出さない(合言葉を知っている人だけ入れる)
      room = this.create(false);
    } else if (code) {
      room = this.get(code);
      if (!room) return { error: 'その合言葉の部屋はありません' };
      if (room.players.size >= RULES.maxPlayers && !room.players.has(user.id)) {
        return { error: '部屋がいっぱいです(最大6人)' };
      }
      if (room.state !== 'waiting' && !room.players.has(user.id)) {
        return { error: 'その部屋はもう始まっています' };
      }
    } else {
      room = this.findOrCreate();
    }

    room.add(user, ws);
    this.byUser.set(user.id, room.code);
    return { room };
  }

  leave(userId) {
    const code = this.byUser.get(userId);
    if (!code) return;
    this.byUser.delete(userId);
    const room = this.map.get(code);
    if (room) room.remove(userId);
  }

  roomOf(userId) {
    const code = this.byUser.get(userId);
    return code ? this.map.get(code) || null : null;
  }

  stats() {
    let playing = 0;
    let waiting = 0;
    for (const r of this.map.values()) {
      if (r.state === 'waiting') waiting += r.connectedPlayers.length;
      else playing += r.connectedPlayers.length;
    }
    return { rooms: this.map.size, waiting, playing };
  }
}
