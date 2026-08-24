/**
 * 2人分のクライアントを実際に繋いで、エゴコロクイズを1試合通す受入テスト。
 *
 *   npx wrangler dev --port 8788 --local   を起動した状態で
 *   node --test test/
 *
 * 確認するのは「部屋に入れる → 全員準備で始まる → 描ける → ひらがなで当たる →
 * 得点が入る(描き手にも) → 3枚で終わる → 作品がギャラリーに残る」の一本道。
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
  a.send({ t: 'join' });
  const roomA = await a.waitType('room');
  assert.match(roomA.code, /^[A-Z2-9]{4}$/, '合言葉は4文字');

  b.send({ t: 'join', code: roomA.code });
  const roomB = await b.waitType('room');
  assert.equal(roomB.code, roomA.code);
  assert.equal(roomB.players.length, 2, '2人が同じ部屋にいる');

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

  for (let round = 0; round < 3; round++) {
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
    const reveal = await guesser.wait(m => m.t === 'reveal', 20000);
    assert.equal(reveal.topic, drawerMsg.topic.label, '答え合わせでお題が明かされる');
    assert.ok(reveal.drawerPoints > 0, '描き手にも得点が入る');
    assert.ok(reveal.drawingId, '作品が保存されている');
    assert.equal(reveal.isLast, round === 2);

    a.clear();
    b.clear();

    if (round === 2) {
      // 最終ラウンドの答え合わせのあと、推薦コーナーが開く(その試合で描かれた3枚が対象)
      const recA = await a.take(m => m.t === 'recommendStart', 20000);
      const recB = await b.take(m => m.t === 'recommendStart', 20000);
      matchDrawingIds = recA.drawings.map(d => d.drawingId);
      assert.equal(matchDrawingIds.length, 3, '3ラウンド分の絵がそろっている');
      assert.deepEqual(
        [...matchDrawingIds].sort(),
        recB.drawings.map(d => d.drawingId).sort(),
        '全員に同じ一覧が届く',
      );

      // 自分の絵には推薦できない(命題6)。a・bともに自分以外の1枚に投票する
      const pick = (drawings, ownId) => drawings.find(d => d.drawerId !== ownId);
      const aPick = pick(recA.drawings, a.user.id);
      const bPick = pick(recB.drawings, b.user.id);
      assert.ok(aPick, 'a は自分以外の絵に投票できる');
      assert.ok(bPick, 'b は自分以外の絵に投票できる');
      a.send({ t: 'recommend', drawingId: aPick.drawingId, comment: 'すごい!' });
      b.send({ t: 'recommend', drawingId: bPick.drawingId, comment: 'かわいい' });

      // 票が入った絵の描き手に、投稿するか尋ねる画面が順番に回ってくる
      for (let guard = 0; guard < 4; guard++) {
        const msg = await a.take(m => m.t === 'postPrompt' || m.t === 'end', 20000);
        if (msg.t === 'end') {
          lastRanking = msg.ranking;
          break;
        }
        assert.ok(Array.isArray(msg.comments) && msg.comments.length > 0, '推薦コメントが届く');
        const artist = msg.artistUserId === a.user.id ? a : b;
        artist.send({ t: 'postDecision', drawingId: msg.drawingId, post: true, acceptedIndices: [0] });
        postedIds.push(msg.drawingId);
        const posted = await a.take(m => m.t === 'posted' && m.drawingId === msg.drawingId, 20000);
        assert.equal(posted.artistUserId, artist.user.id, '投稿したのは推薦された絵の本人');
      }
      if (!lastRanking) {
        const end = await a.take(m => m.t === 'end', 20000);
        lastRanking = end.ranking;
      }
      // 2人だと投票は最大2票 = 2枚まで。3枚全部には絶対に届かない(必ず未投稿が残る)
      assert.ok(postedIds.length >= 1 && postedIds.length < matchDrawingIds.length, '推薦された分だけが投稿される');
    }
  }

  assert.equal(seenDrawers.size, 2, '描き手は交代する');
  assert.ok(lastRanking, '結果が出る');
  assert.equal(lastRanking.length, 2);
  assert.ok(
    lastRanking.every(r => r.score > 0),
    '協調ゲームなので、描き手も回答者も点が入る',
  );

  // 推薦されて投稿された作品だけが公開ギャラリーに載る
  const gallery = await (await fetch(`${BASE}/api/gallery?limit=50`)).json();
  for (const id of postedIds) {
    const found = gallery.drawings.find(d => d.id === id);
    assert.ok(found, `投稿した作品 #${id} が公開ギャラリーに載っている`);
    assert.ok(found.topic, 'お題が入っている');
    assert.ok(Array.isArray(found.strokes) && found.strokes.length > 0, 'ストロークが入っている');
    assert.ok(found.ar > 0, '縦横比が保存されている');
    assert.equal(found.strokes[0].p.length, 6, '線の点がつながって保存されている');
    assert.ok(found.comments.length > 0, '本人が採用した推薦コメントが入っている');
  }
  const notPostedIds = matchDrawingIds.filter(id => !postedIds.includes(id));
  assert.ok(notPostedIds.length > 0, '検証には未投稿の1枚が要る');
  for (const id of notPostedIds) {
    assert.ok(
      !gallery.drawings.some(d => d.id === id),
      `推薦されなかった作品 #${id} は公開ギャラリーに現れない`,
    );
  }

  // 「じぶんの」一覧では、投稿していない下書きも(自分にだけは)見える
  const mineA = await (
    await fetch(`${BASE}/api/gallery?mine=1`, { headers: { authorization: `Bearer ${a.token}` } })
  ).json();
  const mineB = await (
    await fetch(`${BASE}/api/gallery?mine=1`, { headers: { authorization: `Bearer ${b.token}` } })
  ).json();
  const mineIds = new Set([...mineA.drawings, ...mineB.drawings].map(d => d.id));
  for (const id of matchDrawingIds) {
    assert.ok(mineIds.has(id), `作品 #${id} は本人の「じぶんの」一覧には投稿有無に関わらず見える`);
  }

  a.close();
  b.close();
});

test('ソロモード: 1人で描いた絵は推薦を経ずにそのままギャラリーに公開される', async () => {
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
  assert.equal(drawing.posted, true, '他人の承認を待つ相手がいないので即公開される');
  assert.equal(drawing.topic, topic.label);

  const gallery = await (await fetch(`${BASE}/api/gallery?limit=50`)).json();
  assert.ok(
    gallery.drawings.some(d => d.id === drawing.id),
    'ソロ作品は公開ギャラリーに現れる',
  );
});

test('合言葉が違えば入れない', async () => {
  const c = await new Client('ちどり').connect();
  await c.waitType('hello');
  c.send({ t: 'join', code: 'ZZZZ' });
  const err = await c.waitType('joinError');
  assert.match(err.message, /ありません/);
  c.close();
});
