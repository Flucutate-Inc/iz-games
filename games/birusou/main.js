/**
 * ビル層 — 白い空 × 黒いビル群を自転車で走り、ビルの間の谷を2段ジャンプで飛び越えるランナー。
 * 元祖チャリ走の見た目・遊び（ビル屋上を走る、谷に落ちる/障害物で即ゲームオーバー、ライバル佐藤）に寄せた。
 *
 * スコア＝走行距離のみ。ランキングは端末ローカル(localStorage)に保存・表示（この端末の記録のみ）。
 * 賭け・IZ残高・コインには一切触れない、純粋な距離競争のスキルゲーム。
 * IZ SDK はランキング表示名の取得だけに任意で使う（ホスト不在でも単体で動く）。
 */
(function () {
  var el = function (id) { return document.getElementById(id); };
  var RANK_KEY = 'birusou_ranking_v2';
  var RANK_MAX = 50;

  // ── DOM ──
  var canvas = el('game');
  var ctx = canvas.getContext('2d');
  var hud = el('hud');
  var scoreEl = el('score');
  var bestEl = el('best');
  var views = { start: el('view-start'), over: el('view-over'), rank: el('view-rank') };

  // ── 色（白黒基調＋アクセント最小） ──
  var C = {
    black: '#111111', white: '#ffffff', paper: '#f5f5f3', accent: '#ff3b30',
    sky: '#eef1f4', hillFar: '#cfd3d8', rival: '#9aa0a6',
  };

  // ── 定数 ──
  var GRAV = 2000;
  var JUMP_V = [700, 600];        // 1〜2段目の初速（2段ジャンプまで）
  var MAX_JUMPS = 2;
  var BIKE_SX_RATIO = 0.28;
  var SPIKE_FROM = 1000;          // 障害物はこの距離(m)以降に登場し、徐々に増える

  var W = 0, H = 0, dpr = 1, minH = 0, maxH = 0;
  var STATE = 'menu';             // menu | playing | over
  var host = { ready: false, name: 'あなた' };
  var run = null;

  function bikeSX() { return W * BIKE_SX_RATIO; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  // ── ランキング（端末ローカル） ──
  function loadRanking() {
    try { var a = JSON.parse(localStorage.getItem(RANK_KEY) || '[]'); return Array.isArray(a) ? a : []; }
    catch (e) { return []; }
  }
  function bestScore() { var r = loadRanking(); return r.length ? r[0].score : 0; }
  function saveScore(score) {
    var r = loadRanking();
    var e = { name: host.name || 'あなた', score: score, t: run ? run.stamp : 0 };
    r.push(e); r.sort(function (a, b) { return b.score - a.score; }); r = r.slice(0, RANK_MAX);
    try { localStorage.setItem(RANK_KEY, JSON.stringify(r)); } catch (x) {}
    var i = r.indexOf(e); return i >= 0 ? i + 1 : -1;
  }

  // ── リサイズ ──
  // 狭い画面（スマホ）ほどズームアウトして、先のビル群が見えるようにする。
  // ワールドは「論理ビューポート(W,H)」で描画し、キャンバスへは dpr/zoom で縮小転写する。
  // 物理・距離スコアはすべて論理座標なので、見える範囲だけが変わり挙動は不変。
  var VIEW_MIN_W = 1000;         // 確保したい最小の横幅（ワールド単位）。狭い画面ほどズームアウト。
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    var cw = canvas.clientWidth, ch = canvas.clientHeight;
    var zoom = clamp(VIEW_MIN_W / cw, 1, 3);
    W = cw * zoom; H = ch * zoom;
    canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr);
    ctx.setTransform(dpr / zoom, 0, 0, dpr / zoom, 0, 0);
    minH = H * 0.50; maxH = H * 0.80;
  }
  window.addEventListener('resize', resize);

  // ══════════════ 地形（フラットなビル群＋谷） ══════════════
  // gap の場合も edgeY（屋上ライン）を返す。谷でこのラインより下に落ちたら即死判定に使う。
  function surfaceAt(worldX, segs) {
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (worldX >= s.x0 && worldX < s.x1) {
        if (s.gap) return { solid: false, y: H + 999, edgeY: s.h0 };
        return { solid: true, y: s.h0, edgeY: s.h0 };
      }
    }
    return { solid: true, y: run ? run.lastH : H * 0.7, edgeY: run ? run.lastH : H * 0.7 };
  }

  function generate(r) {
    while (r.genX < r.worldX + W + 260) {
      var diff = clamp(r.dist / 1400, 0, 1);
      var bw = 120 + Math.random() * 120;
      r.segs.push({ x0: r.genX, x1: r.genX + bw, h0: r.lastH, h1: r.lastH, gap: false, win: buildWindows(r.genX, r.genX + bw, r.lastH) });
      // 障害物は 1000m 以降のみ、以降じわじわ増える
      if (r.dist > SPIKE_FROM && Math.random() < Math.min(0.30, 0.05 + (r.dist - SPIKE_FROM) / 3500)) {
        placeSpike(r, r.genX + bw / 2, r.lastH);
      }
      r.genX += bw;
      // 谷を多めに。谷の先はビルの高さが変わる（高いビルはジャンプで登り切らないと側面に激突）。
      var gapChance = 0.5 + 0.2 * diff;
      if (r.genX > 780 && Math.random() < gapChance) {
        var up = Math.random() < 0.45 && r.lastH - 50 >= minH;
        var gapW;
        if (up) {
          // 上り（先が高いビル）: 谷は狭めにして「登りながら跨ぐ」負荷を抑える。壁は1回のジャンプで届く高さ。
          gapW = 80 + Math.random() * 50;
          r.segs.push({ x0: r.genX, x1: r.genX + gapW, h0: r.lastH, h1: r.lastH, gap: true });
          r.genX += gapW;
          r.lastH = clamp(r.lastH - (45 + Math.random() * (30 + 40 * diff)), minH, maxH);
        } else {
          // 下り/同高さ: 高速でも跨ぎ抜けできない十分な幅に（落ちたら必ず側面激突）。
          gapW = 120 + Math.random() * (50 + 80 * diff);
          r.segs.push({ x0: r.genX, x1: r.genX + gapW, h0: r.lastH, h1: r.lastH, gap: true });
          r.genX += gapW;
          r.lastH = clamp(r.lastH + (40 + Math.random() * 90), minH, maxH);
        }
      } else {
        // 隣接（谷なし）は同じ高さ or 段差を下るのみ。隣接で「上る壁」は作らない（理不尽回避）。
        if (Math.random() < 0.3) r.lastH = clamp(r.lastH + (30 + Math.random() * 60), minH, maxH);
      }
    }
    var cut = r.worldX - 200;
    while (r.segs.length && r.segs[0].x1 < cut) r.segs.shift();
    r.spikes = r.spikes.filter(function (s) { return s.gx > cut; });
  }
  function buildWindows(x0, x1, topY) {
    var wins = [], cols = Math.floor((x1 - x0 - 24) / 26);
    for (var cx = 0; cx < cols; cx++) {
      for (var ry = 0; ry < 6; ry++) {
        if (Math.random() < 0.45) continue;
        wins.push({ x: x0 + 18 + cx * 26, y: topY + 22 + ry * 30 });
      }
    }
    return wins;
  }
  function placeSpike(r, gx, h) { r.spikes.push({ gx: gx, gy: h }); }

  // ══════════════ 走行データ ══════════════
  function newRun() {
    return {
      dist: 0, score: 0, speed: 320,
      worldX: 0, genX: 0, lastH: H * 0.70, hills: 0,
      segs: [], spikes: [],
      bike: { y: H * 0.70, vy: 0, jumps: 0, air: false, rot: 0, pedal: 0 },
      rival: { y: H * 0.70, vy: 0, air: false, off: 150 },
      alive: true, dying: false, deathKind: null, stamp: 0,
    };
  }

  // ── 入力（ジャンプ、2段まで） ──
  function jump() {
    if (STATE !== 'playing' || !run) return;
    var b = run.bike;
    if (!b.air) { b.vy = -JUMP_V[0]; b.air = true; b.jumps = 1; }
    else if (b.jumps < MAX_JUMPS) { b.jumps++; b.vy = -JUMP_V[b.jumps - 1]; }
  }
  canvas.addEventListener('pointerdown', function (e) { if (STATE === 'playing') { e.preventDefault(); jump(); } });
  window.addEventListener('keydown', function (e) {
    if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') {
      if (STATE === 'playing') { e.preventDefault(); jump(); }
    }
  });

  // ── 画面切り替え ──
  function showView(name) {
    Object.keys(views).forEach(function (k) { views[k].classList.toggle('view-hidden', k !== name); });
    hud.classList.toggle('view-hidden', name !== null);
  }

  // ── 開始 ──
  function startGame() {
    run = newRun();
    run.segs.push({ x0: 0, x1: 900, h0: H * 0.70, h1: H * 0.70, gap: false, win: [] });
    run.genX = 900; run.lastH = H * 0.70;
    generate(run);
    STATE = 'playing';
    showView(null);
    bestEl.textContent = 'BEST ' + bestScore() + ' m';
    updateHud();
  }

  function updateHud() { scoreEl.textContent = Math.floor(run.score) + ' m'; }

  function endGame() {
    STATE = 'over';
    run.stamp = Date.now();
    run.score = Math.floor(run.dist);
    var localRank = saveScore(run.score);           // 端末ローカルにも保存（オフライン/フォールバック）
    el('over-title').textContent = run.deathKind === 'wall' ? 'ビルに激突！' : '転落！';
    el('over-distance').textContent = run.score;
    if (host.ready) {
      // ホスト（IZアプリ）があれば共通リーダーボードへ送信。自己ベスト更新はサーバー判定を採用。
      el('over-newbest').classList.add('view-hidden');
      IZ.submitScore(run.score)
        .then(function (res) { el('over-newbest').classList.toggle('view-hidden', !(res && res.isBest)); })
        .catch(function () {});
    } else {
      el('over-newbest').classList.toggle('view-hidden', localRank !== 1);
    }
    showView('over');
  }

  // ── ランキング描画 ──
  // ホストがあれば共通リーダーボード（全ユーザー）を、無ければ端末ローカルの記録を表示する。
  function renderRanking() {
    var empty = el('rank-empty');
    empty.classList.add('view-hidden');
    if (host.ready) {
      el('rank-list').innerHTML = '';
      IZ.getLeaderboard()
        .then(function (entries) {
          paintRanking(
            (entries || []).map(function (e) { return { name: e.displayName, score: e.score }; }),
            function (e) { return host.name && e.name === host.name; }
          );
        })
        .catch(function () {
          paintRanking(loadRanking(), function (e) { return run && e.t === run.stamp; });
        });
    } else {
      paintRanking(loadRanking(), function (e) { return run && e.t === run.stamp; });
    }
  }

  function paintRanking(rows, isMine) {
    var list = el('rank-list'), empty = el('rank-empty');
    list.innerHTML = '';
    if (!rows || !rows.length) { empty.classList.remove('view-hidden'); return; }
    empty.classList.add('view-hidden');
    rows.forEach(function (e, i) {
      var li = document.createElement('li');
      li.className = 'rank-row' + (isMine(e) ? ' rank-me' : '');
      li.innerHTML = '<span class="rank-pos"></span><span class="rank-name"></span><span class="rank-dist"></span>';
      li.querySelector('.rank-pos').textContent = i + 1;
      li.querySelector('.rank-name').textContent = e.name || '名無し';
      li.querySelector('.rank-dist').textContent = Math.floor(e.score) + ' m';
      list.appendChild(li);
    });
  }

  // ══════════════ 更新 ══════════════
  function updatePlaying(dt) {
    var r = run;

    // 谷への転落アニメ（スクロールを止めて、谷に落ちていく様子を見せてから転倒）
    if (r.dying) {
      var bb = r.bike;
      bb.vy += GRAV * dt; bb.y += bb.vy * dt; bb.rot += 7 * dt; bb.pedal += 0.4;
      if (bb.y > H + 70) endGame();
      return;
    }

    r.speed = Math.min(r.speed + dt * 7, 720);
    var dx = r.speed * dt;
    r.worldX += dx; r.dist += dx / 30; r.score = r.dist;
    r.hills = (r.hills + dx * 0.3) % (W + 300);
    generate(r);

    var b = r.bike, bx = r.worldX + bikeSX();
    var s = surfaceAt(bx, r.segs);
    b.pedal += dx * 0.05;

    // 重力（空中のみ）
    if (b.air) { b.vy += GRAV * dt; b.y += b.vy * dt; }
    if (s.solid) {
      if (b.y >= s.y) {
        // 屋上ラインに到達。「上から屋上へ降りてきた」＝この1フレーム分の落下で跨いだ場合だけ着地。
        // それより深く屋上ラインの下にいる＝横からビルの側面に潜り込んだ＝激突（ゲームオーバー）。
        if (b.vy >= 0 && (b.y - s.y) <= b.vy * dt + 6) {
          b.y = s.y; b.vy = 0; b.air = false; b.jumps = 0;
        } else {
          b.vy = Math.max(b.vy, 120); r.dying = true; r.deathKind = 'wall';  // ビルの側面に激突
        }
      } else {
        b.air = true;                                    // 屋上より上＝空中（段差の下りもここで落下開始）
      }
    } else {
      b.air = true;                                      // ビルの無い所＝落下
      if (b.y > H + 40) { r.dying = true; r.deathKind = 'fall'; }  // 画面下へ転落
    }
    b.rot = b.air ? clamp(b.vy / 1400, -0.4, 0.6) : 0;
    if (r.dying) return;

    // 障害物（スパイク）当たり＝即死
    var bikeBox = { x: bikeSX() - 17, y: b.y - 40, w: 34, h: 40 };
    for (var i = 0; i < r.spikes.length; i++) {
      var sp = r.spikes[i], sx = sp.gx - r.worldX;
      if (sx < -30 || sx > W + 30) continue;
      if (hit(bikeBox, { x: sx - 12, y: sp.gy - 26, w: 24, h: 26 })) { r.alive = false; break; }
    }
    updateRival(r, dt);
    updateHud();
    if (!r.alive) endGame();
  }

  function updateRival(r, dt) {
    var rv = r.rival, rx = r.worldX + bikeSX() - rv.off;
    var s = surfaceAt(rx, r.segs), ahead = surfaceAt(rx + 80, r.segs);
    if (rv.air) {
      rv.vy += GRAV * dt; rv.y += rv.vy * dt;
      if (s.solid && rv.vy >= 0 && rv.y >= s.y) { rv.y = s.y; rv.vy = 0; rv.air = false; }
      else if (rv.y > H + 200) { rv.y = s.solid ? s.y : ahead.y; rv.vy = 0; rv.air = false; }
    } else {
      if (s.solid) rv.y = s.y; else { rv.air = true; rv.vy = -640; }
      if (!ahead.solid && !rv.air) { rv.air = true; rv.vy = -700; }  // 崖の手前でジャンプ
    }
  }

  // ══════════════ 描画 ══════════════
  function render() {
    ctx.fillStyle = C.sky; ctx.fillRect(0, 0, W, H);
    if (!run) return;
    drawSun();
    drawFarSkyline(run.hills);
    drawTerrain(run);
    run.spikes.forEach(function (sp) { drawSpike(sp.gx - run.worldX, sp.gy); });
    drawBike(bikeSX() - run.rival.off, run.rival.y, run.rival.air ? 0.2 : 0, run.bike.pedal, C.rival, '佐');
    drawBike(bikeSX(), run.bike.y, run.bike.rot, run.bike.pedal, C.black, null);
  }

  function drawSun() {
    var sx = W - 64, sy = 66, R = 26;
    ctx.strokeStyle = C.accent; ctx.lineWidth = 5; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(sx, sy, R, 0.2, Math.PI * 2 + 0.1); ctx.stroke();
    for (var a = 0; a < 8; a++) {
      var ang = a / 8 * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(sx + Math.cos(ang) * (R + 8), sy + Math.sin(ang) * (R + 8));
      ctx.lineTo(sx + Math.cos(ang) * (R + 18), sy + Math.sin(ang) * (R + 18));
      ctx.stroke();
    }
  }
  function drawFarSkyline(off) {
    ctx.fillStyle = C.hillFar;
    var base = H * 0.86, span = W + 400, o = ((off * 0.5) % span + span) % span;
    var ws = [70, 46, 90, 58, 78, 50, 66, 84], hs = [120, 180, 150, 210, 130, 190, 160, 140];
    var x = -o, i = 0;
    while (x < W + 40) { var w = ws[i % ws.length]; ctx.fillRect(x, base - hs[i % hs.length], w - 6, hs[i % hs.length]); x += w; i++; }
  }
  function drawTerrain(r) {
    r.segs.forEach(function (s) {
      if (s.gap) return;
      var x0 = s.x0 - r.worldX, x1 = s.x1 - r.worldX;
      if (x1 < -20 || x0 > W + 20) return;
      ctx.fillStyle = C.black;
      ctx.fillRect(x0, s.h0, x1 - x0, H - s.h0);
      if (s.win) {
        ctx.fillStyle = C.white;
        for (var i = 0; i < s.win.length; i++) {
          var w = s.win[i], wx = w.x - r.worldX;
          if (wx > x0 + 4 && wx < x1 - 12 && w.y < H - 6) ctx.fillRect(wx, w.y, 9, 13);
        }
      }
    });
  }
  function drawSpike(x, y) {
    if (x < -20 || x > W + 20) return;
    ctx.fillStyle = C.black; ctx.strokeStyle = C.black; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(x - 12, y); ctx.lineTo(x, y - 26); ctx.lineTo(x + 12, y); ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.strokeStyle = C.white; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x - 5, y - 8); ctx.lineTo(x + 3, y - 16); ctx.stroke();
  }

  // 黒い自転車＋ライダー。黒いビルの上でも見えるよう白いフチ(ハロー)を付ける。
  function drawBike(cx, cy, rot, pedal, color, badge) {
    ctx.save();
    ctx.translate(cx, cy - 12); ctx.rotate(rot || 0);
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    var frame = function () {
      ctx.beginPath();
      ctx.moveTo(-14, 12); ctx.lineTo(2, -2); ctx.lineTo(15, 12);
      ctx.moveTo(2, -2); ctx.lineTo(6, 12); ctx.lineTo(-14, 12);
      ctx.moveTo(15, 12); ctx.lineTo(18, -6);
    };
    var body = function () { ctx.beginPath(); ctx.moveTo(2, -2); ctx.lineTo(6, -20); ctx.lineTo(18, -6); };
    ctx.fillStyle = C.white;
    ctx.beginPath(); ctx.arc(-14, 12, 13, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.arc(15, 12, 13, 0, 7); ctx.fill();
    ctx.save(); ctx.translate(-14, 12); ctx.rotate(pedal); spoke(color); ctx.restore();
    ctx.save(); ctx.translate(15, 12); ctx.rotate(pedal); spoke(color); ctx.restore();
    ctx.strokeStyle = color; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(-14, 12, 12, 0, 7); ctx.stroke();
    ctx.beginPath(); ctx.arc(15, 12, 12, 0, 7); ctx.stroke();
    ctx.strokeStyle = C.white; ctx.lineWidth = 9; frame(); ctx.stroke(); body(); ctx.stroke();
    ctx.strokeStyle = color; ctx.lineWidth = 5; frame(); ctx.stroke(); body(); ctx.stroke();
    ctx.fillStyle = C.white; ctx.strokeStyle = color; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(6, -26, 6, 0, 7); ctx.fill(); ctx.stroke();
    ctx.fillStyle = C.white; ctx.beginPath(); ctx.arc(6, -28, 8.5, Math.PI, 0); ctx.fill();
    ctx.fillStyle = color; ctx.beginPath(); ctx.arc(6, -28, 7, Math.PI, 0); ctx.fill();
    if (badge) { ctx.fillStyle = C.white; ctx.font = '900 8px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(badge, 6, -27); }
    ctx.restore();
  }
  function spoke(color) {
    ctx.strokeStyle = color; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(-8, 0); ctx.lineTo(8, 0); ctx.moveTo(0, -8); ctx.lineTo(0, 8); ctx.stroke();
  }

  function hit(a, b) { return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y; }

  // ══════════════ ループ ══════════════
  var last = 0;
  function frame(now) {
    if (!last) last = now;
    var dt = Math.min(0.045, (now - last) / 1000); last = now;
    if (STATE === 'playing') updatePlaying(dt);
    render();
    requestAnimationFrame(frame);
  }

  // ══════════════ 配線 ══════════════
  el('start-btn').addEventListener('click', startGame);
  el('start-rank-btn').addEventListener('click', function () { renderRanking(); showView('rank'); });
  el('retry-btn').addEventListener('click', startGame);
  el('over-rank-btn').addEventListener('click', function () { renderRanking(); showView('rank'); });
  el('over-home-btn').addEventListener('click', function () { STATE = 'menu'; showView('start'); });
  el('rank-back-btn').addEventListener('click', function () { showView(STATE === 'over' ? 'over' : 'start'); });
  el('rank-clear-btn').addEventListener('click', function () { try { localStorage.removeItem(RANK_KEY); } catch (e) {} renderRanking(); });

  // ── 初期化 ──
  resize();
  showView('start');
  bestEl.textContent = 'BEST ' + bestScore() + ' m';
  requestAnimationFrame(frame);

  IZ.ready().then(function (c) {
    host.ready = true;
    if (c.user && c.user.displayName) host.name = c.user.displayName;
  });
})();
