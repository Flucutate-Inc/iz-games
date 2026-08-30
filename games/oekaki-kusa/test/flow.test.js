/**
 * 2人分のクライアントを実際に繋いで、エゴコロクイズを1試合通す受入テスト。
 *
 *   npx wrangler dev --port 8788 --local   を起動した状態で
 *   node --test test/
 *
 * 確認するのは「部屋に入れる → 全員準備で始まる → 描ける → ひらがなで当たる →
 * 得点が入る(描き手にも) → 周回ぶん描いたら終わる → 作品がギャラリーに残る」の一本道。
 */
const { test } = require('node:test');
const assert = require('node:assert');

const BASE = process.env.KUSA_BASE || 'http://localhost:8788';
const WS_BASE = BASE.replace(/^http/, 'ws');

async function loginGuest(name) {
  const res = await fetch(`${BASE}/api/login-guest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ displayName: name }),
  });
  assert.ok(res.ok, `ログインに失敗: ${res.status}`);
  return res.json();
}

/** WebSocket を「待ち合わせできる」形に包む */
class Client {
  constructor(name) {
    this.name = name;
    this.messages = [];
    this.waiters = [];
  }

  async connect() {
    const session = await loginGuest(this.name);
    this.user = session.user;
    this.token = session.token;
    this.ws = new WebSocket(`${WS_BASE}/ws?t=${encodeURIComponent(this.token)}`);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', ev => {
      const msg = JSON.parse(ev.data);
      this.messages.push(msg);
      for (const w of this.waiters.slice()) {
        if (w.match(msg)) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          w.resolve(msg);
        }
      }
    });
    return this;
  }

  send(obj) {
    this.ws.send(JSON.stringify(obj));
  }

  /** 条件に合うメッセージを待つ。すでに届いていればそれを返す */
  wait(match, timeoutMs = 15000) {
    const found = this.messages.find(match);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const w = { match, resolve };
      this.waiters.push(w);
      setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) {
          this.waiters.splice(i, 1);
          reject(new Error(`${this.name}: 待っていたメッセージが来ませんでした`));
        }
      }, timeoutMs);
    });
  }

  waitType(t, timeoutMs) {
    return this.wait(m => m.t === t, timeoutMs);
  }

  /**
   * 条件に合うメッセージを1件だけ取り出して消費する。
   * `wait()` と違い見つけたメッセージをキューから取り除くので、
   * 同種のメッセージが複数回届く場面(推薦→投稿のやり取り)で使う。
   */
  take(match, timeoutMs = 15000) {
    const idx = this.messages.findIndex(match);
    if (idx >= 0) return Promise.resolve(this.messages.splice(idx, 1)[0]);
    return new Promise((resolve, reject) => {
      const w = {
        match,
        resolve: m => {
          const i = this.messages.indexOf(m);
          if (i >= 0) this.messages.splice(i, 1);
          resolve(m);
        },
      };
      this.waiters.push(w);
      setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) {
          this.waiters.splice(i, 1);
          reject(new Error(`${this.name}: 待っていたメッセージが来ませんでした`));
        }
      }, timeoutMs);
    });
  }

  /** 受信済みを捨てる(ラウンドをまたぐときに使う) */
  clear() {
    this.messages.length = 0;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* すでに閉じている */
    }
  }
}

test('エゴコロクイズを1試合、2人で通す', async t => {
  const a = await new Client('あかつき').connect();
  const b = await new Client('ばんそう').connect();

  await a.waitType('hello');
  await b.waitType('hello');

  // A がランダムマッチで部屋を作り、B が合言葉で入る
  a.send({ t: 'join', create: true });
  const roomA = await a.waitType('room');
  assert.match(roomA.code, /^[A-Z2-9]{4}$/, '合言葉は4文字');

  b.send({ t: 'join', code: roomA.code });
  const roomB = await b.waitType('room');
  assert.equal(roomB.code, roomA.code);
  assert.equal(roomB.players.length, 2, '2人が同じ部屋にいる');

  // このテストは対戦を最後まで通す。
  // 推薦コーナーまで通したいので 2人 × 2周 = 4枚にする
  a.send({ t: 'config', laps: 2, roundMs: 60000, revealMs: 6000 });
  await a.wait(m => m.t === 'room' && m.rules.laps === 2, 5000);

  // 片方だけ準備完了では始まらない
  a.clear();
  b.clear();
  a.send({ t: 'ready', ready: true });
  await a.wait(m => m.t === 'room' && m.players.some(p => p.ready));
  assert.equal(
    a.messages.some(m => m.t === 'round'),
    false,
    '1人だけ準備完了では始まらない',
  );

  // 全員が準備完了で自動開始(原作と同じ)
  b.send({ t: 'ready', ready: true });

  const seenDrawers = new Set();
  let lastRanking = null;
  let matchDrawingIds = [];
  const postedIds = [];
  const SHEETS = 4; // 2人 × 2周

  for (let round = 0; round < SHEETS; round++) {
    const rA = await a.wait(m => m.t === 'round' && m.roundIndex === round, 20000);
    const rB = await b.wait(m => m.t === 'round' && m.roundIndex === round, 20000);

    // お題は描き手にしか渡らない
    const drawerIsA = rA.drawerId === a.user.id;
    const drawer = drawerIsA ? a : b;
    const guesser = drawerIsA ? b : a;
    const drawerMsg = drawerIsA ? rA : rB;
    const guesserMsg = drawerIsA ? rB : rA;

    assert.ok(drawerMsg.topic && drawerMsg.topic.label, '描き手にはお題が見える');
    assert.ok(drawerMsg.topic.answer, '描き手には正解の読みも見える');
    assert.equal(guesserMsg.topic, null, '回答者にはお題が見えない');
    seenDrawers.add(drawerMsg.drawerId);

    // 描き手が線を1本引く。回答者に届くこと
    guesser.clear();
    drawer.send({ t: 's0', id: 'st1', c: 0, w: 1, p: [0.1, 0.1], ar: 1.9 });
    drawer.send({ t: 's+', id: 'st1', p: [0.5, 0.8, 0.9, 1.5] });
    const s0 = await guesser.waitType('s0');
    assert.equal(s0.c, 0);
    const sPlus = await guesser.waitType('s+');
    assert.deepEqual(sPlus.p, [0.5, 0.8, 0.9, 1.5], '座標はそのまま届く(幅基準なので1を超えてよい)');

    // 描き手は回答できない
    guesser.clear();
    drawer.send({ t: 'guess', text: drawerMsg.topic.answer });
    const drawerChat = await guesser.waitType('chat');
    assert.equal(drawerChat.fromDrawer, true, '描き手の発言はヒント扱いで流れるだけ');

    // 誤答にペナルティはない
    guesser.clear();
    guesser.send({ t: 'guess', text: 'ぜったいちがうこたえ' });
    const wrong = await guesser.waitType('chat');
    assert.equal(wrong.text, 'ぜったいちがうこたえ');

    // カタカナで打っても、ひらがなに直して判定される
    guesser.clear();
    const katakana = drawerMsg.topic.answer.replace(/[ぁ-ゖ]/g, c => String.fromCharCode(c.charCodeAt(0) + 0x60));
    guesser.send({ t: 'guess', text: katakana });
    const correct = await guesser.waitType('correct');
    assert.equal(correct.userId, guesser.user.id);
    assert.ok(correct.points > 0, '正解には得点が入る');

    // 回答者が全員当てたのでラウンドは即終了する
    const reveal = await guesser.wait(m => m.t === 'reveal' && m.roundIndex === round, 20000);
    assert.equal(reveal.topic, drawerMsg.topic.label, '答え合わせでお題が明かされる');
    assert.ok(reveal.drawerPoints > 0, '描き手にも得点が入る');
    assert.ok(reveal.drawingId, '作品が保存されている');
    assert.equal(reveal.isLast, round === SHEETS - 1);

    a.clear();
    b.clear();

    if (round === SHEETS - 1) {
      // 最終ラウンドの答え合わせのあと、推薦コーナーが開く(その試合で描かれた全部が対象)
      const recA = await a.take(m => m.t === 'recommendStart', 20000);
      const recB = await b.take(m => m.t === 'recommendStart', 20000);
      matchDrawingIds = recA.drawings.map(d => d.drawingId);
      assert.equal(matchDrawingIds.length, SHEETS, '全ラウンド分の絵がそろっている');
      assert.deepEqual(
        [...matchDrawingIds].sort(),
        recB.drawings.map(d => d.drawingId).sort(),
        '全員に同じ一覧が届く',
      );

      // 自分の絵には推薦できない。a・bともに自分以外の1枚に投票する
      const pick = (drawings, ownId) => drawings.find(d => d.drawerId !== ownId);
      const aPick = pick(recA.drawings, a.user.id);
      const bPick = pick(recB.drawings, b.user.id);
      assert.ok(aPick, 'a は自分以外の絵に投票できる');
      assert.ok(bPick, 'b は自分以外の絵に投票できる');
      a.send({ t: 'recommend', drawingId: aPick.drawingId, comment: 'すごい!' });
      b.send({ t: 'recommend', drawingId: bPick.drawingId, comment: 'かわいい' });
      postedIds.push(aPick.drawingId, bPick.drawingId);

      // 全員が投票し終えると、集計結果 → 結果画面と続く
      const result = await a.take(m => m.t === 'recommendResult', 20000);
      assert.equal(result.results.length, SHEETS, '集計は全部の絵について返る');
      const votedTotal = result.results.reduce((n, r) => n + r.votes, 0);
      assert.equal(votedTotal, 2, '2人が1票ずつ入れた');

      const end = await a.take(m => m.t === 'end', 20000);
      lastRanking = end.ranking;
    }
  }

  assert.equal(seenDrawers.size, 2, '描き手は交代する');
  assert.ok(lastRanking, '結果が出る');
  assert.equal(lastRanking.length, 2);
  assert.ok(
    lastRanking.every(r => r.score > 0),
    '協調ゲームなので、描き手も回答者も点が入る',
  );

  // 描かれた絵は、推薦の有無に関わらず全部ギャラリーに載る
  const gallery = await (await fetch(`${BASE}/api/gallery?limit=50`)).json();
  for (const id of matchDrawingIds) {
    const found = gallery.drawings.find(d => d.id === id);
    assert.ok(found, `作品 #${id} がギャラリーに載っている(推薦の有無を問わない)`);
    assert.ok(found.topic, 'お題が入っている');
    assert.ok(Array.isArray(found.strokes) && found.strokes.length > 0, 'ストロークが入っている');
    assert.ok(found.ar > 0, '縦横比が保存されている');
    assert.equal(found.strokes[0].p.length, 6, '線の点がつながって保存されている');
  }

  // 推薦は「いいね+コメント」としてその絵に残る
  for (const id of new Set(postedIds)) {
    const found = gallery.drawings.find(d => d.id === id);
    assert.ok(found.likeCount >= 1, `推薦された作品 #${id} にいいねが付いている`);
    const comments = (await (await fetch(`${BASE}/api/drawings/${id}/comments`)).json()).comments;
    assert.ok(comments.length >= 1, `推薦コメントが作品 #${id} に残っている`);
    assert.ok(comments.every(c => c.displayName && c.text), 'コメントには名前と本文がある');
  }

  // 「じぶんの」一覧は自分の作品だけを返す
  const mineA = await (
    await fetch(`${BASE}/api/gallery?mine=1`, { headers: { authorization: `Bearer ${a.token}` } })
  ).json();
  assert.ok(mineA.drawings.length > 0, 'a の作品がある');
  assert.ok(
    mineA.drawings.every(d => d.userId === a.user.id),
    '「じぶんの」には自分の作品だけが並ぶ',
  );

  a.close();
  b.close();
});

test('ソロモード: 1人で描いた絵もそのままギャラリーに載る', async () => {
  const session = await loginGuest('ひとりぼっち');

  const topicRes = await fetch(`${BASE}/api/topics/random`);
  assert.ok(topicRes.ok, 'お題を取得できる');
  const topic = await topicRes.json();
  assert.ok(topic.label, 'お題のラベルが入っている');

  const postRes = await fetch(`${BASE}/api/solo-post`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({
      topicLabel: topic.label,
      ar: 1.6,
      strokes: [{ id: 'a', c: 0, w: 1, p: [0.1, 0.1, 0.4, 0.4, 0.7, 0.2] }],
    }),
  });
  assert.ok(postRes.ok, `ソロ投稿に失敗: ${postRes.status}`);
  const { drawing } = await postRes.json();
  assert.equal(drawing.mode, 'solo');
  assert.equal(drawing.topic, topic.label);

  const gallery = await (await fetch(`${BASE}/api/gallery?limit=50`)).json();
  assert.ok(
    gallery.drawings.some(d => d.id === drawing.id),
    'ソロ作品はギャラリーに現れる',
  );
});

test('いいね・コメント・シェア用の単品取得', async () => {
  const artist = await loginGuest('えかき');
  const fan = await loginGuest('ふぁん');

  // 作品を1枚用意する
  const { drawing } = await (
    await fetch(`${BASE}/api/solo-post`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${artist.token}` },
      body: JSON.stringify({
        topicLabel: 'てすと',
        ar: 1.5,
        strokes: [{ id: 's', c: 1, w: 1, p: [0.2, 0.2, 0.6, 0.9] }],
      }),
    })
  ).json();

  // 未ログインではいいねできない
  const noAuth = await fetch(`${BASE}/api/drawings/${drawing.id}/like`, { method: 'POST' });
  assert.equal(noAuth.status, 401, '未ログインのいいねは 401');

  // いいねはトグルする
  const likeHeaders = { 'content-type': 'application/json', authorization: `Bearer ${fan.token}` };
  const like1 = await (await fetch(`${BASE}/api/drawings/${drawing.id}/like`, { method: 'POST', headers: likeHeaders })).json();
  assert.deepEqual({ liked: like1.liked, count: like1.count }, { liked: true, count: 1 });
  const like2 = await (await fetch(`${BASE}/api/drawings/${drawing.id}/like`, { method: 'POST', headers: likeHeaders })).json();
  assert.deepEqual({ liked: like2.liked, count: like2.count }, { liked: false, count: 0 }, '2度目で取り消し');
  const like3 = await (await fetch(`${BASE}/api/drawings/${drawing.id}/like`, { method: 'POST', headers: likeHeaders })).json();
  assert.equal(like3.liked, true);

  // コメントを付けられ、一覧で読める
  const posted = await (
    await fetch(`${BASE}/api/drawings/${drawing.id}/comments`, {
      method: 'POST',
      headers: likeHeaders,
      body: JSON.stringify({ text: 'いい絵！' }),
    })
  ).json();
  assert.equal(posted.comment.text, 'いい絵！');
  assert.equal(posted.comment.displayName, 'ふぁん');

  const empty = await fetch(`${BASE}/api/drawings/${drawing.id}/comments`, {
    method: 'POST',
    headers: likeHeaders,
    body: JSON.stringify({ text: '   ' }),
  });
  assert.equal(empty.status, 400, '空コメントは 400');

  // シェアリンクから開くための単品取得。いいね数・コメントがまとまって返る
  const single = await (
    await fetch(`${BASE}/api/drawings/${drawing.id}`, { headers: { authorization: `Bearer ${fan.token}` } })
  ).json();
  assert.equal(single.drawing.id, drawing.id);
  assert.equal(single.drawing.likeCount, 1);
  assert.equal(single.drawing.likedByMe, true, '自分がいいね済みかも分かる');
  assert.equal(single.drawing.commentCount, 1);
  assert.equal(single.comments.length, 1);

  // ギャラリー一覧にもいいね数・コメント数が乗る
  const gallery = await (
    await fetch(`${BASE}/api/gallery?limit=50`, { headers: { authorization: `Bearer ${fan.token}` } })
  ).json();
  const inList = gallery.drawings.find(d => d.id === drawing.id);
  assert.equal(inList.likeCount, 1);
  assert.equal(inList.likedByMe, true);
  assert.equal(inList.commentCount, 1);

  // 存在しない作品は 404
  const missing = await fetch(`${BASE}/api/drawings/999999`);
  assert.equal(missing.status, 404);
});

test('合言葉が違えば入れない', async () => {
  const c = await new Client('ちどり').connect();
  await c.waitType('hello');
  c.send({ t: 'join', code: 'ZZZZ' });
  const err = await c.waitType('joinError');
  assert.match(err.message, /ありません/);
  c.close();
});

test('月間絵しりとり: 予想でつなぐ。ことばは次の人が繋ぐまで伏せられる', async () => {
  const a = await loginGuest('しりとりあ');
  const b = await loginGuest('しりとりび');
  const headers = t => ({ 'content-type': 'application/json', authorization: `Bearer ${t}` });
  const strokes = [{ id: 's', c: 0, w: 1, p: [0.1, 0.1, 0.5, 0.5] }];

  // 未ログインは 401
  assert.equal((await fetch(`${BASE}/api/shiritori`)).status, 401);

  // 現在の状態(他のテスト実行の影響を受けないよう、相対で検証する)
  const before = await (await fetch(`${BASE}/api/shiritori`, { headers: headers(a.token) })).json();
  assert.match(before.month, /^\d{4}-\d{2}$/, '月は YYYY-MM');
  const baseSeq = before.count;
  const hasPrev = !!before.last;

  // 「ん」で終わることばは出せない
  const ngN = await fetch(`${BASE}/api/shiritori`, {
    method: 'POST',
    headers: headers(a.token),
    body: JSON.stringify({ word: 'みかん', guessedPrev: hasPrev ? 'なにか' : null, strokes, ar: 1.5, prevSeq: baseSeq }),
  });
  assert.equal(ngN.status, 400, '「ん」で終わることばは 400');

  // a が1枚つなぐ。2枚目以降は「前の絵の予想」が必須で、予想の最後の文字から
  // 自分のことばが始まっていればよい(前の人の実際のことばとは比べない)
  const guessA = hasPrev ? 'とけい' : null; // 前の絵をなんと読むかは自由
  const wordA = hasPrev ? 'いるか' : 'りんご';
  if (hasPrev) {
    // 予想なしは 400
    const noGuess = await fetch(`${BASE}/api/shiritori`, {
      method: 'POST',
      headers: headers(a.token),
      body: JSON.stringify({ word: wordA, strokes, ar: 1.5, prevSeq: baseSeq }),
    });
    assert.equal(noGuess.status, 400, '2枚目以降は予想なしだと 400');
    // 予想とことばが繋がっていないのも 400
    const noConnect = await fetch(`${BASE}/api/shiritori`, {
      method: 'POST',
      headers: headers(a.token),
      body: JSON.stringify({ word: 'すいか', guessedPrev: 'とけい', strokes, ar: 1.5, prevSeq: baseSeq }),
    });
    assert.equal(noConnect.status, 400, '予想の最後の文字から始まらないことばは 400');
  }
  const okA = await fetch(`${BASE}/api/shiritori`, {
    method: 'POST',
    headers: headers(a.token),
    body: JSON.stringify({ word: wordA, guessedPrev: guessA, strokes, ar: 1.5, prevSeq: baseSeq }),
  });
  assert.ok(okA.ok, `a の投稿に失敗: ${okA.status} ${await okA.clone().text()}`);
  const postedA = await okA.json();
  assert.equal(postedA.entry.seq, baseSeq + 1);
  if (hasPrev) {
    assert.ok(postedA.revealed, '繋いだ瞬間に前のことばが明かされる');
    assert.ok(postedA.revealed.prevWord, '前の実際のことばが分かる');
    assert.equal(typeof postedA.revealed.matched, 'boolean', '予想が合っていたかも分かる');
  }

  // a は連続でつなげない
  const twice = await fetch(`${BASE}/api/shiritori`, {
    method: 'POST',
    headers: headers(a.token),
    body: JSON.stringify({ word: 'かさ', guessedPrev: wordA, strokes, ar: 1.5, prevSeq: baseSeq + 1 }),
  });
  assert.equal(twice.status, 403, '同じ人の連続投稿は 403');

  // 未参加の b には、最後の絵は見えるが、ことばは伏せられている(頭文字も教えない)
  const bView = await (await fetch(`${BASE}/api/shiritori`, { headers: headers(b.token) })).json();
  assert.equal(bView.participated, false);
  assert.equal(bView.last.word, null, '最後のことばは伏せられる(予想のネタバレ防止)');
  assert.equal(bView.last.nextChar, undefined, '頭文字も教えない(予想が意味を持つように)');
  assert.equal(bView.chain, null, '未参加にはチェーンが見えない');
  assert.ok(bView.last.strokes.length > 0, '最後の絵は見える');

  // 「ん」で終わる予想は「前の人は出せないはず」なので 400 で教える
  const ngGuessN = await fetch(`${BASE}/api/shiritori`, {
    method: 'POST',
    headers: headers(b.token),
    body: JSON.stringify({ word: 'かめ', guessedPrev: 'みかん', strokes, ar: 1.5, prevSeq: bView.last.seq }),
  });
  assert.equal(ngGuessN.status, 400, '「ん」で終わる予想は 400');

  // 古い prevSeq は 409(誰かが先につないだ扱い)
  const stale = await fetch(`${BASE}/api/shiritori`, {
    method: 'POST',
    headers: headers(b.token),
    body: JSON.stringify({ word: 'かい', guessedPrev: 'いるか', strokes, ar: 1.5, prevSeq: bView.last.seq - 1 }),
  });
  assert.equal(stale.status, 409, 'prevSeq がズレていたら 409');
  assert.equal((await stale.json()).conflict, true);

  // b が「わざとズレた予想」でつなぐ。それでもしりとりは続く(ズレが面白さ)
  // 予想「らっぱー」(長音終わり) → 頭文字は「は」(濁点ゆるめ判定で「ぱ」もOK)
  const okB = await fetch(`${BASE}/api/shiritori`, {
    method: 'POST',
    headers: headers(b.token),
    body: JSON.stringify({ word: 'ぱせり', guessedPrev: 'らっぱー', strokes, ar: 1.2, prevSeq: bView.last.seq }),
  });
  assert.ok(okB.ok, `b の投稿に失敗: ${okB.status} ${await okB.clone().text()}`);
  const postedB = await okB.json();
  assert.equal(postedB.entry.seq, baseSeq + 2);
  assert.equal(postedB.revealed.prevWord, wordA, '前の実際のことば(いるか)が明かされる');
  assert.equal(postedB.revealed.matched, false, '「らっぱー」は「いるか」とズレている');

  // 参加したので b にもチェーン全体が見える。答え合わせの形で
  const bAfter = await (await fetch(`${BASE}/api/shiritori`, { headers: headers(b.token) })).json();
  assert.equal(bAfter.participated, true);
  assert.ok(bAfter.chain.length >= 2);
  const entryA = bAfter.chain.find(e => e.seq === baseSeq + 1);
  const entryB = bAfter.chain.find(e => e.seq === baseSeq + 2);
  assert.equal(entryA.word, wordA, '次の人が繋いだので a のことばは公開されている');
  assert.equal(entryB.word, 'ぱせり', '最後尾でも自分のことばは見える');
  assert.equal(entryB.guessedPrev, 'らっぱー', '予想も記録されている');
  assert.equal(entryB.guessMatched, false, 'どこでズレたかが分かる');

  // a から見ると: ことばが見えるのは「自分が描いたところまで」。
  // 自分(baseSeq+1)のあとに増えた b のことばは？？？のまま
  const aAfter = await (await fetch(`${BASE}/api/shiritori`, { headers: headers(a.token) })).json();
  const bEntryForA = aAfter.chain.find(e => e.seq === baseSeq + 2);
  assert.equal(bEntryForA.word, null, '自分が描いたあとに増えたことばは伏せられる');
  assert.equal(bEntryForA.guessedPrev, 'らっぱー', '自分のことばがどう読まれたかは見える');
  assert.equal(bEntryForA.guessMatched, false, 'ズレたことも見える(比較相手は公開済みの自分のことば)');
  const aEntryForA = aAfter.chain.find(e => e.seq === baseSeq + 1);
  assert.equal(aEntryForA.word, wordA, '自分が描いたところまでは見える');

  // ギャラリーにも反映される。答え合わせ前(最後尾)の絵はお題が？？？にマスクされる
  const galleryForA = await (
    await fetch(`${BASE}/api/gallery?limit=60`, { headers: headers(a.token) })
  ).json();
  const aDrawing = galleryForA.drawings.find(d => d.mode === 'shiritori' && d.topic === wordA);
  assert.ok(aDrawing, 'しりとりの絵がギャラリーに載る(次が繋がった分はことばが見える)');
  const maskedForA = galleryForA.drawings.find(
    d => d.mode === 'shiritori' && d.userId === b.user.id && d.topic === '？？？',
  );
  assert.ok(maskedForA, '答え合わせ前(最後尾)のしりとり絵は、お題が？？？にマスクされる');

  // 作者本人(b)には自分のことばが見える
  const galleryForB = await (
    await fetch(`${BASE}/api/gallery?limit=60`, { headers: headers(b.token) })
  ).json();
  const bOwn = galleryForB.drawings.find(d => d.mode === 'shiritori' && d.userId === b.user.id);
  assert.equal(bOwn.topic, 'ぱせり', '作者本人にはマスクされない');
});

test('むずかしさ: レベルを選ぶと、そのレベルのお題だけが出る', async () => {
  // お題データを直接読んで、レベルごとの答えの集合を作る
  const topics = require('../data/topics.json').topics;
  const byLevel = { 1: new Set(), 2: new Set(), 3: new Set() };
  for (const t of topics) byLevel[t.level].add(t.label);
  assert.ok(byLevel[1].size > 10 && byLevel[2].size > 10 && byLevel[3].size > 10, '各レベルにお題がある');

  // ソロ用のお題APIはレベルで絞れる
  for (const lv of [1, 2, 3]) {
    for (let i = 0; i < 8; i++) {
      const t = await (await fetch(`${BASE}/api/topics/random?level=${lv}`)).json();
      assert.equal(t.level, lv, `level=${lv} を頼んだのに ${t.level} が来た`);
      assert.ok(byLevel[lv].has(t.label), `${t.label} はレベル${lv}のお題ではない`);
    }
  }

  // 対戦: 待機中にレベル3を選ぶと、出題が全部レベル3になる
  const a = await new Client('れべるあ').connect();
  const b = await new Client('れべるび').connect();
  await a.waitType('hello');
  await b.waitType('hello');

  a.send({ t: 'join', create: true });
  const room = await a.waitType('room');
  assert.equal(room.level, 1, 'はじめはレベル1');
  b.send({ t: 'join', code: room.code });
  await b.waitType('room');

  a.clear();
  a.send({ t: 'level', level: 3 });
  a.send({ t: 'config', laps: 1, roundMs: 60000 });
  const leveled = await a.wait(m => m.t === 'room' && m.level === 3 && m.rules.laps === 1, 5000);
  assert.equal(leveled.level, 3, '選んだレベルが部屋の設定になる');
  const sheets = leveled.rules.totalRounds;

  a.send({ t: 'ready', ready: true });
  b.send({ t: 'ready', ready: true });

  // 出題される全部の絵で、お題がレベル3か見る
  for (let round = 0; round < sheets; round++) {
    const rA = await a.wait(m => m.t === 'round' && m.roundIndex === round, 20000);
    const rB = await b.wait(m => m.t === 'round' && m.roundIndex === round, 20000);
    const drawerMsg = rA.topic ? rA : rB;
    assert.ok(byLevel[3].has(drawerMsg.topic.label), `${drawerMsg.topic.label} はレベル3のお題ではない`);
    // すぐ当てて次へ
    const guesser = rA.topic ? b : a;
    guesser.send({ t: 'guess', text: drawerMsg.topic.answer });
    await guesser.wait(m => m.t === 'reveal' && m.roundIndex === round, 20000);
    a.clear();
    b.clear();
  }

  a.close();
  b.close();
});

test('進行の設定: 周回数と1枚の時間を変えられる', async () => {
  const a = await new Client('せっていあ').connect();
  const b = await new Client('せっていび').connect();
  const hello = await a.waitType('hello');
  await b.waitType('hello');
  assert.ok(hello.choices && hello.choices.laps.length, '選べる値の一覧が届く');

  // 既定値はサーバー定数で確認する(部屋はランダムマッチで再利用されることがあり、
  // その部屋で前に選ばれた設定を引き継ぐのが正しい挙動なので)
  const cfgApi = await (await fetch(`${BASE}/api/iz-config`)).json();
  assert.equal(cfgApi.rules.laps, 1, '既定は1周');
  assert.equal(cfgApi.rules.roundMs, 60000, '既定は60秒');

  a.send({ t: 'join', create: true });
  const room = await a.waitType('room');
  b.send({ t: 'join', code: room.code });
  const room2 = await b.waitType('room');
  assert.equal(room2.rules.drawerCount, 2, '描き手になれるのは2人');

  // まず既知の状態にそろえる(1周)
  a.clear();
  a.send({ t: 'config', laps: 1, roundMs: 60000, revealMs: 6000 });
  const base = await a.wait(m => m.t === 'room' && m.rules.laps === 1, 5000);
  // 1周 = 描き手になれる人が全員1回ずつ。2人なので2枚
  assert.equal(base.rules.totalRounds, 2, '2人 × 1周 = 2枚');

  // 一覧に無い値は無視される(勝手な数値でタイマーを乗っ取れない)
  a.clear();
  a.send({ t: 'config', roundMs: 1 });
  a.send({ t: 'config', laps: 999 });
  a.send({ t: 'level', level: 1 });
  const afterBogus = await a.wait(m => m.t === 'room' && m.level === 1, 5000);
  assert.equal(afterBogus.rules.roundMs, 60000, '一覧に無い秒数は無視される');
  assert.equal(afterBogus.rules.laps, 1, '一覧に無い周回数は無視される');

  // 2周・30秒・答え合わせ3秒にする → 2人なので4枚になるはず
  a.clear();
  a.send({ t: 'config', laps: 2, roundMs: 30000, revealMs: 3000 });
  const cfg = await a.wait(m => m.t === 'room' && m.rules.laps === 2, 5000);
  assert.equal(cfg.rules.roundMs, 30000);
  assert.equal(cfg.rules.revealMs, 3000);
  assert.equal(cfg.rules.totalRounds, 4, '2人 × 2周 = 4枚');

  a.clear();
  b.clear();
  a.send({ t: 'ready', ready: true });
  b.send({ t: 'ready', ready: true });

  const r0 = await a.wait(m => m.t === 'round' && m.roundIndex === 0, 10000);
  assert.equal(r0.rounds, 4, '実際の枚数が伝わる(2人 × 2周)');
  const remain = r0.endsAt - Date.now();
  assert.ok(remain > 25000 && remain <= 30000, `制限時間が30秒でない: 残り${remain}ms`);

  // 4枚こなす。全員が同じ回数(2回ずつ)描いていることも確かめる
  const drawCount = {};
  for (let round = 0; round < 4; round++) {
    const rA = await a.wait(m => m.t === 'round' && m.roundIndex === round, 20000);
    const rB = await b.wait(m => m.t === 'round' && m.roundIndex === round, 20000);
    drawCount[rA.drawerId] = (drawCount[rA.drawerId] || 0) + 1;
    const drawerMsg = rA.topic ? rA : rB;
    const guesser = rA.topic ? b : a;
    guesser.send({ t: 'guess', text: drawerMsg.topic.answer });
    const reveal = await guesser.wait(m => m.t === 'reveal' && m.roundIndex === round, 20000);
    assert.equal(reveal.isLast, round === 3, '4枚目が最後');
    assert.equal(reveal.nextInMs, 3000, '答え合わせの時間も設定どおり');
    a.clear();
    b.clear();
  }
  assert.deepEqual(
    Object.values(drawCount).sort(),
    [2, 2],
    '2周なので、全員がちょうど2回ずつ描く',
  );

  a.close();
  b.close();
});

test('お題はすべて名詞(動詞句・ことわざを入れない)', () => {
  const topics = require('../data/topics.json').topics;
  assert.ok(topics.length >= 200, `お題が少ない: ${topics.length}`);

  // 「を」は名詞の中にほぼ現れない助詞なので、これだけは強い手がかりになる
  // (「が」「に」は「めがね」「にじ」のように語中に来るので使えない)
  for (const t of topics) {
    assert.ok(!t.answer.includes('を'), `${t.label}: 「を」を含む(動詞句の可能性)`);
    assert.match(t.answer, /^[ぁ-ゖー]+$/, `${t.label}: 答えがひらがなでない`);
    assert.ok(t.answer.length <= 12, `${t.label}: 長すぎる(文の可能性)`);
  }

  // 以前まぎれていた動詞句・ことわざが消えていること
  const removed = [
    'かぜをひく', 'さばをよむ', 'てをぬく', 'はらがたつ', 'みちにまよう',
    'ねこにこばん', 'さるもきからおちる', 'いしのうえにもさんねん',
    'おなかがすく', 'ねつがでる', 'みみがいたい', 'むしがいい',
    'あしがぼうになる', 'ぬかにくぎ', 'さいふをおとす', 'びみょう',
  ];
  const answers = new Set(topics.map(t => t.answer));
  for (const r of removed) {
    assert.equal(answers.has(r), false, `${r} は名詞でないので消えているはず`);
  }
});
