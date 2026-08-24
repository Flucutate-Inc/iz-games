/**
 * お絵かきの草 — 画面遷移とゲーム進行。
 *
 * 画面は1枚のHTMLに全部あり、`.view` を出し入れするだけ。ルーターは持たない。
 * スマホの縦持ち専用。キャンバスが主役で、それ以外の要素は必要なときだけ現れる。
 */
(function () {
  'use strict';

  var $ = function (id) {
    return document.getElementById(id);
  };

  var state = {
    me: null,
    room: null,
    round: null, // { roundIndex, rounds, drawerId, endsAt, topic }
    board: null,
    solved: false,
    lastDrawings: [],
    gallery: { items: [], mine: false, done: false },
    recommend: null, // { drawings, endsAt, selectedId, sent }
    soloBoard: null,
    soloTopic: null,
  };

  var izDiag = { steps: [], token: null };

  // ══ 表示できる高さの追従 ═══════════════════════════════════
  // ソフトキーボードが出ると visualViewport が縮む。--vh をそれに合わせることで、
  // キャンバスが自動的に縮み、入力欄がキーボードの上に残る。
  var vv = window.visualViewport;

  function syncViewport() {
    var h = vv ? vv.height : window.innerHeight;
    document.documentElement.style.setProperty('--vh', h + 'px');
    if (state.board) state.board.resize();
    if (state.soloBoard) state.soloBoard.resize();
    if (typeof shiriBoard !== 'undefined' && shiriBoard) shiriBoard.resize();
  }

  if (vv) {
    vv.addEventListener('resize', syncViewport);
    vv.addEventListener('scroll', syncViewport);
  }
  window.addEventListener('resize', syncViewport);
  window.addEventListener('orientationchange', function () {
    setTimeout(syncViewport, 150);
  });

  // ══ 小道具 ════════════════════════════════════════════════

  function show(name) {
    var views = document.querySelectorAll('.view');
    for (var i = 0; i < views.length; i++) views[i].classList.add('hidden');
    var v = $('view-' + name);
    if (v) v.classList.remove('hidden');
    // 画面が変われば描ける大きさも変わる
    setTimeout(syncViewport, 0);
  }

  var toastTimer = null;
  function toast(message) {
    var el = $('toast');
    el.textContent = message;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.classList.add('hidden');
    }, 2400);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function sleep(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  }

  function withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise(function (_, reject) {
        setTimeout(function () {
          reject(new Error('timeout'));
        }, ms);
      }),
    ]);
  }

  // ══ IZ ログイン(わんわん大戦争と同じ流れ) ═════════════════

  function izEmbedded() {
    return !!window.ReactNativeWebView || window.parent !== window;
  }

  function diagPush(label, value) {
    izDiag.steps.push({ label: label, value: value });
  }

  function decodeJwtPayload(token) {
    try {
      var seg = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(decodeURIComponent(escape(atob(seg))));
    } catch (e) {
      return null;
    }
  }

  /**
   * IZ アプリ(WebView/iframe)で開かれたときの自動ログイン。
   * ホストから Firebase ID トークンを受け取り、サーバーで署名検証する。
   * 起動直後は認証の復元が終わっていないことがあるので、数回リトライする。
   */
  async function tryIzAutoLogin(onStatus) {
    onStatus = onStatus || function () {};
    izDiag.steps = [];
    diagPush(
      '埋め込み',
      window.ReactNativeWebView ? 'IZアプリ(WebView)' : window.parent !== window ? 'iframe' : 'なし',
    );
    if (!izEmbedded()) return { ok: false, reason: 'IZアプリ内ではありません' };
    diagPush('IZ SDK', window.IZ ? 'あり(protocol ' + window.IZ.PROTOCOL + ')' : 'なし');
    if (!window.IZ) return { ok: false, reason: 'IZ SDK を読み込めませんでした' };

    var init;
    try {
      onStatus('IZアプリと接続しています…');
      init = await withTimeout(IZ.ready(), 8000);
      diagPush('iz:init', '受信(uid ' + (init.user && init.user.uid ? 'あり' : 'なし') + ')');
    } catch (e) {
      diagPush('iz:init', '応答なし(8秒)');
      return { ok: false, reason: 'IZアプリからの応答がありません', hint: 'update' };
    }

    var lastError = '';
    var hint = '';
    for (var attempt = 1; attempt <= 3; attempt++) {
      try {
        onStatus(attempt === 1 ? 'IZアカウントを確認しています…' : 'IZアカウントを確認しています…(' + attempt + '/3)');
        var idToken = await withTimeout(IZ.getIdToken(), 6000);
        if (!idToken) throw new Error('IZアカウントの情報を取得できませんでした');
        izDiag.token = decodeJwtPayload(idToken);
        diagPush('iz:getIdToken', '取得(aud ' + (izDiag.token ? izDiag.token.aud : '不明') + ')');
        onStatus('ログインしています…');
        var res = await Net.api('/login-iz', {
          body: { idToken: idToken, displayName: init.user && init.user.displayName },
        });
        Net.setToken(res.token);
        state.me = res.user;
        diagPush('サーバー検証', 'OK');
        return { ok: true };
      } catch (e2) {
        lastError = e2 && e2.message === 'timeout' ? 'IZアプリが応答しませんでした' : (e2 && e2.message) || '不明なエラー';
        diagPush('試行' + attempt, lastError);
        // aud / iss 不一致は何度やっても直らないので即座に打ち切る
        if (/aud が不正/.test(lastError) || /iss が不正/.test(lastError)) {
          hint = 'project';
          break;
        }
        if (attempt < 3) await sleep(1000 * attempt);
      }
    }
    if (!hint && /応答/.test(lastError)) hint = 'update';
    return { ok: false, reason: lastError, hint: hint };
  }

  function izDiagText() {
    var lines = izDiag.steps.map(function (s) {
      return s.label + ': ' + s.value;
    });
    if (izDiag.token) {
      lines.push('トークン aud: ' + izDiag.token.aud);
      lines.push('トークン iss: ' + izDiag.token.iss);
      if (izDiag.token.exp) {
        lines.push('トークン有効期限: 残り' + Math.round(izDiag.token.exp - Date.now() / 1000) + '秒');
      }
    }
    lines.push('URL: ' + location.origin);
    lines.push('UA: ' + navigator.userAgent.slice(0, 120));
    return lines.join('\n');
  }

  async function showLoginFallback(result) {
    $('boot-status').textContent = 'ログインが必要です';
    $('boot-login').classList.remove('hidden');

    var note = '';
    if (result && result.reason && izEmbedded()) {
      note = 'IZアカウントで自動ログインできませんでした。<br>理由: ' + esc(result.reason);
      if (result.hint === 'project') {
        var expected = '(取得できませんでした)';
        try {
          expected = (await Net.api('/iz-config')).firebaseProjects.join(' / ');
        } catch (e) {
          /* 表示は諦める */
        }
        var aud = izDiag.token && izDiag.token.aud ? izDiag.token.aud : '不明';
        note +=
          '<br>アプリのプロジェクト: <b>' + esc(aud) + '</b>' +
          '<br>ゲーム側の受け入れ設定: <b>' + esc(expected) + '</b>';
      } else if (result.hint === 'update') {
        note += '<br>IZアプリが最新版か確認してください。';
      }
      note += '<br>下のなまえだけでも遊べます。';
      $('btn-iz-retry').classList.remove('hidden');
    } else {
      note = 'なまえを決めるとすぐ始められます。';
    }
    $('boot-note').innerHTML = note;
  }

  // ══ 起動 ══════════════════════════════════════════════════

  async function boot() {
    syncViewport();

    // すでにセッションがあるならそれを使う
    if (Net.getToken()) {
      try {
        var me = await Net.api('/me');
        state.me = me.user;
        return enterHome();
      } catch (e) {
        Net.setToken(null);
      }
    }

    if (izEmbedded()) {
      var result = await tryIzAutoLogin(function (t) {
        $('boot-status').textContent = t;
      });
      if (result.ok) return enterHome();
      await showLoginFallback(result);
      return;
    }

    await showLoginFallback(null);
  }

  function enterHome() {
    show('home');
    $('home-me').textContent = state.me ? state.me.displayName : '';
    Net.connect();
    refreshStats();
    loadHomeBackground();
  }

  /** いままで投稿された絵をうっすら背景に流す。決まった数の場所に散らして置く */
  async function loadHomeBackground() {
    var el = $('home-bg');
    if (!el) return;
    var slots = [
      { left: '-10%', top: '2%', size: 130, rot: -12 },
      { left: '60%', top: '0%', size: 150, rot: 9 },
      { left: '-12%', top: '56%', size: 150, rot: 11 },
      { left: '58%', top: '58%', size: 140, rot: -9 },
      { left: '24%', top: '80%', size: 116, rot: 5 },
    ];
    try {
      var res = await Net.api('/gallery/random?n=' + slots.length);
      var items = res.drawings || [];
      el.innerHTML = '';
      items.slice(0, slots.length).forEach(function (d, i) {
        var slot = slots[i];
        var cv = document.createElement('canvas');
        var ar = Math.min(1.6, Math.max(0.7, d.ar || 4 / 3));
        cv.style.left = slot.left;
        cv.style.top = slot.top;
        cv.style.width = slot.size + 'px';
        cv.style.height = Math.round(slot.size * ar) + 'px';
        cv.style.transform = 'rotate(' + slot.rot + 'deg)';
        el.appendChild(cv);
        requestAnimationFrame(function () {
          Draw.render(cv, d);
        });
      });
    } catch (e) {
      /* 背景が無くても困らない。静かに諦める */
    }
  }

  async function refreshStats() {
    try {
      var s = await Net.api('/stats');
      var parts = [];
      if (s.waiting + s.playing > 0) parts.push('いま ' + (s.waiting + s.playing) + '人が来ています');
      parts.push('作品 ' + s.drawings + '枚');
      $('home-stats').textContent = parts.join(' ・ ');
    } catch (e) {
      $('home-stats').textContent = '';
    }
  }

  // ══ 部屋 ══════════════════════════════════════════════════

  var pendingJoin = null;
  /**
   * 直近まで居た部屋の合言葉。スマホは通信が途切れやすく、WebSocket は
   * 自動で繋ぎ直る(net.js)がサーバー側の部屋は再 join しないと関連付けが戻らない。
   * 'hello'(=接続成立のたび)に、居たはずの部屋へそっと再入室しておく。
   */
  var lastRoomCode = null;

  function joinRoom(code) {
    var msg = { t: 'join', code: code || null };
    if (Net.isOpen()) {
      Net.send(msg);
      return;
    }
    // まだ繋がっていない。開いたら送る(_open で流す)
    pendingJoin = msg;
    $('home-stats').textContent = 'せつぞくしています…';
    Net.connect();
  }

  function renderWait() {
    var room = state.room;
    if (!room) return;
    $('wait-code').textContent = room.code;
    var n = room.players.filter(function (p) {
      return p.connected;
    }).length;
    $('wait-status').textContent =
      n < room.rules.minPlayers
        ? 'あと ' + (room.rules.minPlayers - n) + '人ではじめられます'
        : '全員が「じゅんびOK」で開始します';

    $('wait-players').innerHTML = room.players
      .map(function (p) {
        var tag = p.ready ? '<span class="tag ok">じゅんびOK</span>' : '<span class="tag">まちうけ</span>';
        var mark = p.noDraw ? '<span class="tag">回答だけ</span>' : '';
        return '<li><span>' + esc(p.displayName) + (p.userId === (state.me && state.me.id) ? '（じぶん）' : '') + '</span><span>' + mark + ' ' + tag + '</span></li>';
      })
      .join('');

    var mine = room.players.filter(function (p) {
      return p.userId === (state.me && state.me.id);
    })[0];
    $('btn-ready').textContent = mine && mine.ready ? 'じゅんびOK を取り消す' : 'じゅんびOK';
  }

  // ══ プレイ ════════════════════════════════════════════════

  function isDrawer() {
    return !!(state.round && state.me && state.round.drawerId === state.me.id);
  }

  function ensureBoard() {
    if (state.board) return state.board;
    state.board = new Draw.Board($('board'), {
      onStrokeStart: function (msg) {
        Net.send({
          t: 's0',
          id: msg.id,
          c: msg.c,
          w: msg.w,
          p: msg.p,
          ar: msg.ar,
        });
      },
      onStrokeAppend: function (msg) {
        Net.send({ t: 's+', id: msg.id, p: msg.p });
      },
    });
    state.board.myUserId = state.me ? state.me.id : null;
    buildTools();
    state.board.resize();
    return state.board;
  }

  /** 対戦用・ソロ用で同じ道具立てを使い回す */
  function buildPaintTools(board, swatchEl, widthEl) {
    swatchEl.innerHTML = '';
    Draw.PALETTE.forEach(function (color, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch' + (i === Draw.ERASER_INDEX ? ' eraser' : '');
      b.style.background = color;
      b.setAttribute('aria-pressed', i === 0 ? 'true' : 'false');
      b.setAttribute('aria-label', i === Draw.ERASER_INDEX ? 'けしゴム' : 'いろ' + (i + 1));
      b.onclick = function () {
        board.setColor(i);
        Array.prototype.forEach.call(swatchEl.children, function (el, j) {
          el.setAttribute('aria-pressed', i === j ? 'true' : 'false');
        });
      };
      swatchEl.appendChild(b);
    });

    widthEl.innerHTML = '';
    Draw.WIDTHS.forEach(function (w, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'width';
      b.setAttribute('aria-pressed', i === 1 ? 'true' : 'false');
      b.setAttribute('aria-label', 'ふとさ' + (i + 1));
      var dot = document.createElement('i');
      var px = Math.max(3, Math.round(w * 190));
      dot.style.width = px + 'px';
      dot.style.height = px + 'px';
      b.appendChild(dot);
      b.onclick = function () {
        board.setWidth(i);
        Array.prototype.forEach.call(widthEl.children, function (el, j) {
          el.setAttribute('aria-pressed', i === j ? 'true' : 'false');
        });
      };
      widthEl.appendChild(b);
    });
  }

  function buildTools() {
    buildPaintTools(state.board, $('swatches'), $('widths'));
  }

  var timerHandle = null;

  function startTimer() {
    stopTimer();
    timerHandle = setInterval(paintTimer, 200);
    paintTimer();
  }

  function stopTimer() {
    if (timerHandle) clearInterval(timerHandle);
    timerHandle = null;
  }

  function paintTimer() {
    if (!state.round) return;
    var left = Math.max(0, Math.ceil((state.round.endsAt - Date.now()) / 1000));
    var el = $('play-timer');
    el.textContent = String(left);
    el.classList.toggle('urgent', left <= 10);
  }

  function enterRound(msg) {
    state.round = msg;
    state.solved = false;
    show('play');

    var board = ensureBoard();
    board.reset();
    board.myUserId = state.me ? state.me.id : null;
    board.setEnabled(isDrawer());

    $('play-round').textContent = msg.roundIndex + 1 + '/' + msg.rounds;
    var topicEl = $('play-topic');
    if (isDrawer()) {
      // 漢字まじりのお題は、正解になる読みも添える
      var label = msg.topic.label;
      topicEl.textContent =
        msg.topic.answer && msg.topic.answer !== label ? label + '（' + msg.topic.answer + '）' : label;
      topicEl.classList.remove('masked');
    } else {
      topicEl.textContent = 'これ、なに？';
      topicEl.classList.add('masked');
    }

    $('tools').classList.toggle('hidden', !isDrawer());
    $('guessarea').classList.toggle('hidden', isDrawer());
    $('guessarea').classList.remove('solved');
    $('guess').value = '';
    $('guess').disabled = false;
    $('guess-send').disabled = false;
    $('guess').placeholder = 'こたえをひらがなで';
    document.querySelector('.guesshint').textContent = '必ずひらがなで入力してください';

    $('veil').classList.add('hidden');
    $('bubbles').innerHTML = '';
    startTimer();
    renderScores();
  }

  function renderScores() {
    var room = state.room;
    if (!room) return;
    $('scorestrip').innerHTML = room.players
      .map(function (p) {
        var cls = 'chip';
        if (p.isDrawer) cls += ' drawer';
        else if (p.solved) cls += ' solved';
        if (!p.connected) cls += ' off';
        var mark = p.isDrawer ? '✎ ' : p.solved ? '○ ' : '';
        return '<span class="' + cls + '">' + mark + esc(p.displayName) + ' <b>' + p.score + '</b></span>';
      })
      .join('');
  }

  function bubble(html, cls) {
    var wrap = $('bubbles');
    var el = document.createElement('div');
    el.className = 'bubble' + (cls ? ' ' + cls : '');
    el.innerHTML = html;
    wrap.appendChild(el);
    while (wrap.children.length > 4) wrap.removeChild(wrap.firstChild);
    setTimeout(function () {
      el.classList.add('leaving');
      setTimeout(function () {
        if (el.parentNode) el.parentNode.removeChild(el);
      }, 400);
    }, 3200);
  }

  function showReveal(msg) {
    stopTimer();
    var board = state.board;
    if (board) board.setEnabled(false);
    $('tools').classList.add('hidden');
    $('guess').disabled = true;
    $('guess-send').disabled = true;
    $('guess').blur();

    $('veil-label').textContent = 'おだいは';
    $('veil-topic').textContent = msg.topic;
    if (msg.solvers.length) {
      $('veil-list').innerHTML = msg.solvers
        .map(function (s) {
          return '<li><span>' + esc(s.displayName) + '</span><span>+' + s.points + '</span></li>';
        })
        .join('');
    } else {
      $('veil-list').innerHTML = '<li class="none">だれも当てられなかった…</li>';
    }
    $('veil-next').textContent = msg.isLast ? 'すいせんコーナーへ…' : 'つぎの絵へ…';
    $('veil').classList.remove('hidden');
  }

  function showResult(msg) {
    stopTimer();
    stopRecommendTimer();
    show('result');
    var mvp = msg.mvp || [];
    $('ranking').innerHTML = msg.ranking
      .map(function (r, i) {
        var cls = mvp.indexOf(r.userId) >= 0 ? ' class="mvp"' : '';
        return (
          '<li' + cls + '><span class="rank">' + (i + 1) + '</span>' +
          '<span class="name">' + esc(r.displayName) + '</span>' +
          '<span class="score">' + r.score + '</span></li>'
        );
      })
      .join('');
  }

  // ══ 推薦コーナー ══════════════════════════════════════════
  //
  // 最終ラウンドの答え合わせが終わると、その試合で描かれた絵が一覧で並ぶ。
  // 自分の絵には推薦できない(自薦できないから承認に重みが出る=命題6)。
  // 票が入った絵の描き手だけが、次の「投稿画面」で公開するかを選ぶ。

  var recommendTimerHandle = null;

  function startRecommendTimer() {
    stopRecommendTimer();
    recommendTimerHandle = setInterval(paintRecommendTimer, 200);
    paintRecommendTimer();
  }

  function stopRecommendTimer() {
    if (recommendTimerHandle) clearInterval(recommendTimerHandle);
    recommendTimerHandle = null;
  }

  function paintRecommendTimer() {
    if (!state.recommend) return;
    var left = Math.max(0, Math.ceil((state.recommend.endsAt - Date.now()) / 1000));
    var el = $('recommend-timer');
    el.textContent = left + '秒';
    el.classList.toggle('urgent', left <= 5);
  }

  function enterRecommend(msg) {
    state.recommend = { drawings: msg.drawings, endsAt: msg.endsAt, selectedId: null, sent: false };
    show('recommend');

    document.querySelector('#view-recommend .field').classList.remove('hidden');
    $('btn-recommend-send').classList.remove('hidden');
    $('recommend-hint').textContent = 'いちばん好きな1枚をえらんで、コメントをそえよう（自分の絵は選べません）';
    $('recommend-comment').value = '';
    $('recommend-comment').disabled = false;
    $('btn-recommend-send').disabled = true;
    $('btn-recommend-send').textContent = '推薦する';
    $('recommend-waiting').textContent = '';

    var grid = $('recommend-grid');
    grid.innerHTML = '';
    msg.drawings.forEach(function (d) {
      var isOwn = !!(state.me && d.drawerId === state.me.id);
      var card = document.createElement(isOwn ? 'div' : 'button');
      if (!isOwn) card.type = 'button';
      card.className = 'card selectable' + (isOwn ? ' own' : '');
      card.dataset.drawingId = d.drawingId;

      var cv = document.createElement('canvas');
      cv.style.aspectRatio = '1 / ' + Math.min(2.2, Math.max(0.6, d.ar || 4 / 3));
      card.appendChild(cv);

      var body = document.createElement('div');
      body.className = 'card-body';
      body.innerHTML = '<p class="card-topic">' + esc(d.topic) + '</p><p class="card-meta">' + esc(d.displayName) + '</p>';
      card.appendChild(body);

      if (isOwn) {
        var tag = document.createElement('span');
        tag.className = 'card-own-tag';
        tag.textContent = '（自分の絵）';
        card.appendChild(tag);
      } else {
        card.onclick = function () {
          selectRecommend(d.drawingId);
        };
      }

      grid.appendChild(card);
      requestAnimationFrame(function () {
        Draw.render(cv, d);
      });
    });

    startRecommendTimer();
  }

  function selectRecommend(drawingId) {
    if (!state.recommend || state.recommend.sent) return;
    state.recommend.selectedId = drawingId;
    var cards = $('recommend-grid').querySelectorAll('.card');
    Array.prototype.forEach.call(cards, function (el) {
      el.classList.toggle('selected', Number(el.dataset.drawingId) === drawingId);
    });
    $('btn-recommend-send').disabled = false;
  }

  function sendRecommend() {
    if (!state.recommend || !state.recommend.selectedId || state.recommend.sent) return;
    var comment = $('recommend-comment').value.trim().slice(0, 80);
    Net.send({ t: 'recommend', drawingId: state.recommend.selectedId, comment: comment });
    state.recommend.sent = true;
    $('btn-recommend-send').disabled = true;
    $('btn-recommend-send').textContent = '送信しました';
    $('recommend-comment').disabled = true;
    $('recommend-waiting').textContent = 'ほかの人を待っています…';
  }

  /** 推薦の集計結果。トーストで軽く流すだけ(絵はギャラリーで見られる) */
  function handleRecommendResult(msg) {
    var mine = (msg.results || []).filter(function (r) {
      return state.me && r.artistUserId === state.me.id && r.votes > 0;
    });
    if (mine.length) {
      var total = mine.reduce(function (n, r) {
        return n + r.votes;
      }, 0);
      toast('あなたの絵に ' + total + '票入りました！');
    }
  }

  // ══ ひとりでかく ══════════════════════════════════════════
  //
  // 対戦とちがい、当ててくれる相手がいない。描いて投稿すると
  // そのままギャラリーに載る。

  async function openSoloTopic() {
    show('solo-topic');
    $('solo-topic-label').textContent = '…';
    await rerollSoloTopic();
  }

  async function rerollSoloTopic() {
    try {
      var res = await Net.api('/topics/random');
      state.soloTopic = res.label;
      $('solo-topic-label').textContent = res.label;
    } catch (e) {
      toast('お題を取得できませんでした');
    }
  }

  function ensureSoloBoard() {
    if (state.soloBoard) return state.soloBoard;
    state.soloBoard = new Draw.Board($('solo-board'), {});
    state.soloBoard.myUserId = state.me ? state.me.id : null;
    buildPaintTools(state.soloBoard, $('solo-swatches'), $('solo-widths'));
    state.soloBoard.resize();
    return state.soloBoard;
  }

  function enterSoloDraw() {
    show('solo-draw');
    $('solo-draw-topic').textContent = state.soloTopic || '';
    var board = ensureSoloBoard();
    board.reset();
    board.myUserId = state.me ? state.me.id : null;
    board.setEnabled(true);
  }

  async function postSoloDrawing() {
    if (!state.soloBoard) return;
    var strokes = state.soloBoard.strokes.map(function (s) {
      return { id: s.id, c: s.c, w: s.w, p: s.p.slice() };
    });
    if (!strokes.length) {
      toast('まだ何も描かれていません');
      return;
    }
    $('btn-solo-post').disabled = true;
    try {
      await Net.api('/solo-post', {
        body: { topicLabel: state.soloTopic, strokes: strokes, ar: state.soloBoard.aspect() },
      });
      toast('とうこうしました！');
      show('home');
      loadHomeBackground();
      refreshStats();
    } catch (e) {
      toast('とうこうできませんでした: ' + e.message);
    } finally {
      $('btn-solo-post').disabled = false;
    }
  }

  // ══ 月間絵しりとり ════════════════════════════════════════
  //
  // 月ごとに1本のチェーン。リアルタイムに集まらなくても、誰かが最後に描いた絵を見て
  // 自分のことばを描いて繋ぐ。ことばは参加するまで伏せられていて(絵から推測する楽しみ)、
  // 参加するとその月のしりとり全体(絵+ことば+名前)が見られる。

  var shiritori = null; // GET /api/shiritori のレスポンス
  var shiriBoard = null;

  function monthLabel(month) {
    var m = /^\d{4}-(\d{2})$/.exec(month || '');
    return m ? parseInt(m[1], 10) + '月' : '';
  }

  async function openShiritori() {
    show('shiritori');
    $('shiritori-status').textContent = 'よみこみちゅう…';
    $('shiri-last').classList.add('hidden');
    $('shiri-chain-wrap').classList.add('hidden');
    $('btn-shiri-draw').disabled = true;
    await loadShiritori();
  }

  async function loadShiritori() {
    try {
      shiritori = await Net.api('/shiritori');
    } catch (e) {
      $('shiritori-status').textContent = '読み込めませんでした: ' + e.message;
      return;
    }
    renderShiritori();
  }

  function renderShiritori() {
    var s = shiritori;
    if (!s) return;
    $('shiritori-title').textContent = monthLabel(s.month) + 'の絵しりとり';

    var drawBtn = $('btn-shiri-draw');
    var last = s.last;

    if (!last) {
      $('shiritori-status').textContent = 'まだだれも描いていません。';
      $('shiri-last').classList.add('hidden');
      drawBtn.textContent = '最初の1枚をかく';
      drawBtn.disabled = false;
      $('shiri-hint').textContent = 'すきなことばを絵にして、しりとりをはじめよう。';
    } else {
      $('shiritori-status').textContent = 'いま ' + s.count + 'つ つながっています';
      $('shiri-last').classList.remove('hidden');
      var cv = $('shiri-last-canvas');
      cv.style.aspectRatio = '1 / ' + Math.min(2.2, Math.max(0.6, last.ar || 4 / 3));
      requestAnimationFrame(function () {
        Draw.render(cv, last);
      });
      $('shiri-last-meta').textContent =
        s.count + '番目 ・ ' + last.displayName + (last.isMine ? '（じぶん）' : '') +
        (last.word ? ' ・ 「' + last.word + '」' : '');
      $('shiri-next').innerHTML = 'つぎは「<b>' + esc(last.nextChar || '?') + '</b>」からはじまることば';

      if (last.isMine) {
        drawBtn.textContent = 'だれかがつなぐのをまとう';
        drawBtn.disabled = true;
        $('shiri-hint').textContent = 'じぶんの絵には つなげられません。';
      } else {
        drawBtn.textContent = 'つづきをかく';
        drawBtn.disabled = false;
        $('shiri-hint').textContent = last.word
          ? ''
          : 'この絵がなにか、想像しながらつなごう。';
      }
    }

    // 参加済みならその月のチェーン全体
    if (s.participated && s.chain && s.chain.length) {
      $('shiri-chain-wrap').classList.remove('hidden');
      $('shiri-chain-label').textContent = monthLabel(s.month) + 'のしりとり ぜんぶ（' + s.chain.length + 'つ）';
      var ol = $('shiri-chain');
      ol.innerHTML = '';
      s.chain.forEach(function (entry) {
        var li = document.createElement('li');
        var cv = document.createElement('canvas');
        cv.style.aspectRatio = '1 / ' + Math.min(2.2, Math.max(0.6, entry.ar || 4 / 3));
        li.appendChild(cv);
        var body = document.createElement('div');
        body.className = 'shiri-entry-body';
        body.innerHTML =
          '<span class="shiri-word">' + esc(entry.word) + '</span>' +
          '<span class="shiri-who">' + entry.seq + '番目 ・ ' + esc(entry.displayName) + '</span>';
        li.appendChild(body);
        ol.appendChild(li);
        requestAnimationFrame(function () {
          Draw.render(cv, entry);
        });
      });
    } else {
      $('shiri-chain-wrap').classList.add('hidden');
      if (!s.participated && s.count > 0) {
        $('shiri-hint').textContent =
          ($('shiri-hint').textContent + ' 参加すると、この月のしりとり ぜんぶが見られます。').trim();
      }
    }
  }

  function ensureShiriBoard() {
    if (shiriBoard) return shiriBoard;
    shiriBoard = new Draw.Board($('shiri-board'), {});
    shiriBoard.myUserId = state.me ? state.me.id : null;
    buildPaintTools(shiriBoard, $('shiri-swatches'), $('shiri-widths'));
    shiriBoard.resize();
    return shiriBoard;
  }

  function enterShiritoriDraw() {
    show('shiritori-draw');
    var nextChar = shiritori && shiritori.last ? shiritori.last.nextChar : null;
    $('shiri-draw-title').textContent = nextChar ? '「' + nextChar + '」からはじまることば' : 'すきなことばをかく';
    $('shiri-word').value = '';
    $('shiri-word').placeholder = nextChar ? '「' + nextChar + '」からはじまることば' : 'ことばをひらがなで';
    var board = ensureShiriBoard();
    board.reset();
    board.myUserId = state.me ? state.me.id : null;
    board.setEnabled(true);
  }

  async function postShiritori() {
    if (!shiriBoard) return;
    var word = Kana.toHiraganaOnly($('shiri-word').value).slice(0, 12);
    if (!word) {
      toast('ことばをひらがなで入れてください');
      $('shiri-word').focus();
      return;
    }
    var strokes = shiriBoard.strokes.map(function (s) {
      return { id: s.id, c: s.c, w: s.w, p: s.p.slice() };
    });
    if (!strokes.length) {
      toast('まだ何も描かれていません');
      return;
    }
    $('btn-shiri-post').disabled = true;
    try {
      var res = await Net.api('/shiritori', {
        body: {
          word: word,
          strokes: strokes,
          ar: shiriBoard.aspect(),
          prevSeq: shiritori && shiritori.last ? shiritori.last.seq : 0,
        },
      });
      toast('つなぎました！');
      // 参加したのでチェーン全体が返ってくる。状態を組み立て直して一覧へ
      shiritori = null;
      show('shiritori');
      await loadShiritori();
    } catch (e) {
      if (e.status === 409) {
        // 誰かが先に繋いだ。絵はそのままに、最新の状態を取り直す
        toast(e.message + '。頭文字がかわっていないか確認してね');
        try {
          shiritori = await Net.api('/shiritori');
          var nc = shiritori.last ? shiritori.last.nextChar : null;
          $('shiri-draw-title').textContent = nc ? '「' + nc + '」からはじまることば' : 'すきなことばをかく';
        } catch (e2) {
          /* 次の「つなぐ」でまた分かる */
        }
      } else {
        toast(e.message);
      }
    } finally {
      $('btn-shiri-post').disabled = false;
    }
  }

  // ══ ギャラリー ════════════════════════════════════════════

  async function openGallery(mine) {
    state.gallery = { items: [], mine: !!mine, done: false };
    show('gallery');
    $('gallery-mine').textContent = mine ? 'ぜんぶ' : 'じぶんの';
    $('gallery-grid').innerHTML = '';
    $('gallery-empty').textContent = 'よみこみちゅう…';
    await loadGallery();
  }

  async function loadGallery() {
    var g = state.gallery;
    var before = g.items.length ? g.items[g.items.length - 1].id : null;
    try {
      var q = '/gallery?limit=24' + (before ? '&before=' + before : '') + (g.mine ? '&mine=1' : '');
      var res = await Net.api(q);
      g.items = g.items.concat(res.drawings);
      g.done = res.drawings.length < 24;
      renderGallery();
    } catch (e) {
      $('gallery-empty').textContent = '読み込めませんでした: ' + e.message;
    }
  }

  function renderGallery() {
    var g = state.gallery;
    var grid = $('gallery-grid');
    grid.innerHTML = '';
    g.items.forEach(function (d) {
      var card = document.createElement('button');
      card.type = 'button';
      card.className = 'card';
      var cv = document.createElement('canvas');
      // 元の絵と同じ形で見せる(極端な比率だけは詰める)
      cv.style.aspectRatio = '1 / ' + Math.min(2.2, Math.max(0.6, d.ar || 4 / 3));
      card.appendChild(cv);
      var body = document.createElement('div');
      body.className = 'card-body';
      var meta =
        d.mode === 'solo'
          ? 'ひとりでかいた'
          : d.solved
            ? '<span class="ok">当てられた</span>'
            : 'だれも当てられず';
      var counts = '';
      if (d.likeCount || d.commentCount) {
        counts =
          '<p class="card-counts">' +
          (d.likeCount ? (d.likedByMe ? '♥' : '♡') + ' ' + d.likeCount : '') +
          (d.likeCount && d.commentCount ? ' ・ ' : '') +
          (d.commentCount ? '💬 ' + d.commentCount : '') +
          '</p>';
      }
      body.innerHTML =
        '<p class="card-topic">' + esc(d.topic) + '</p>' +
        '<p class="card-meta">' + esc(d.displayName) + ' ・ ' + meta + '</p>' +
        counts;
      card.appendChild(body);
      card.onclick = function () {
        openSheet(d);
      };
      grid.appendChild(card);
      // レイアウトが確定してから描く(clientWidth が要る)
      requestAnimationFrame(function () {
        Draw.render(cv, d);
      });
    });

    $('gallery-empty').textContent = g.items.length
      ? ''
      : g.mine
        ? 'まだ自分の作品はありません。'
        : 'まだ作品がありません。遊ぶとここに残ります。';
    $('gallery-more').classList.toggle('hidden', g.done || !g.items.length);
  }

  /** いま拡大シートで開いている作品 */
  var sheetDrawing = null;

  function openSheet(d) {
    sheetDrawing = d;
    $('sheet').classList.remove('hidden');
    $('sheet-canvas').style.aspectRatio = '1 / ' + Math.min(2.2, Math.max(0.6, d.ar || 4 / 3));
    $('sheet-topic').textContent = d.topic;
    $('sheet-meta').textContent =
      d.displayName +
      ' ・ ' +
      (d.mode === 'solo'
        ? 'ひとりでかいた'
        : d.solved
          ? (d.solverName || 'だれか') + 'さんが当てた'
          : 'だれも当てられなかった');

    renderSheetLike(d.likedByMe, d.likeCount);
    $('sheet-comment-input').value = '';
    $('sheet-comments').innerHTML = '';
    loadSheetComments(d.id);

    requestAnimationFrame(function () {
      Draw.render($('sheet-canvas'), d);
    });
  }

  function renderSheetLike(liked, count) {
    $('sheet-like-heart').textContent = liked ? '♥' : '♡';
    $('sheet-like-count').textContent = String(count || 0);
    $('sheet-like').classList.toggle('liked', !!liked);
  }

  async function loadSheetComments(drawingId) {
    try {
      var res = await Net.api('/drawings/' + drawingId + '/comments');
      if (!sheetDrawing || sheetDrawing.id !== drawingId) return; // もう別の絵を見ている
      renderSheetComments(res.comments || []);
    } catch (e) {
      /* コメントが読めなくても絵は見られる。静かに諦める */
    }
  }

  function renderSheetComments(comments) {
    $('sheet-comments').innerHTML = comments
      .map(function (c) {
        return '<li><b>' + esc(c.displayName) + '</b>' + esc(c.text) + '</li>';
      })
      .join('');
    // 最新が見えるように下へ
    var el = $('sheet-comments');
    el.scrollTop = el.scrollHeight;
  }

  async function toggleSheetLike() {
    if (!sheetDrawing) return;
    var d = sheetDrawing;
    $('sheet-like').disabled = true;
    try {
      var res = await Net.api('/drawings/' + d.id + '/like', { body: {} });
      d.likedByMe = res.liked;
      d.likeCount = res.count;
      if (sheetDrawing === d) renderSheetLike(res.liked, res.count);
    } catch (e) {
      toast('いいねできませんでした: ' + e.message);
    } finally {
      $('sheet-like').disabled = false;
    }
  }

  async function submitSheetComment(ev) {
    ev.preventDefault();
    if (!sheetDrawing) return;
    var d = sheetDrawing;
    var input = $('sheet-comment-input');
    var text = input.value.trim().slice(0, 80);
    if (!text) return;
    $('sheet-comment-send').disabled = true;
    try {
      await Net.api('/drawings/' + d.id + '/comments', { body: { text: text } });
      input.value = '';
      d.commentCount = (d.commentCount || 0) + 1;
      loadSheetComments(d.id);
    } catch (e) {
      toast('コメントできませんでした: ' + e.message);
    } finally {
      $('sheet-comment-send').disabled = false;
    }
  }

  /**
   * シェア。絵を PNG にして Web Share API(なければリンクのコピー)で渡す。
   * IZ アプリ(WebView)内では files 付き share が使えないことがあるので、
   * その場合はテキスト+URLだけの share → クリップボード、の順に落とす。
   */
  async function shareSheetDrawing() {
    if (!sheetDrawing) return;
    var d = sheetDrawing;
    var url = location.origin + '/?drawing=' + d.id;
    var text = '「' + d.topic + '」 by ' + d.displayName + ' — お絵かきの草';

    // 絵を PNG 化する(白背景で 2 倍解像度)
    var blob = null;
    try {
      var cv = document.createElement('canvas');
      var w = 640;
      var ar = Math.min(2.2, Math.max(0.6, d.ar || 4 / 3));
      cv.width = w;
      cv.height = Math.round(w * ar);
      cv.style.width = w + 'px';
      cv.style.height = Math.round(w * ar) + 'px';
      // Draw.render は clientWidth を見るので、一時的に DOM に置く
      cv.style.position = 'fixed';
      cv.style.left = '-9999px';
      document.body.appendChild(cv);
      Draw.render(cv, d);
      blob = await new Promise(function (resolve) {
        cv.toBlob(resolve, 'image/png');
      });
      document.body.removeChild(cv);
    } catch (e) {
      blob = null;
    }

    try {
      if (blob && navigator.canShare && navigator.canShare({ files: [new File([blob], 'oekaki.png', { type: 'image/png' })] })) {
        await navigator.share({
          files: [new File([blob], 'oekaki.png', { type: 'image/png' })],
          text: text,
          url: url,
        });
        return;
      }
      if (navigator.share) {
        await navigator.share({ text: text, url: url });
        return;
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return; // ユーザーがキャンセルしただけ
    }

    // 最後の砦: リンクをコピー
    try {
      await navigator.clipboard.writeText(text + ' ' + url);
      toast('リンクをコピーしました');
    } catch (e) {
      toast('このリンクを共有してください: ' + url);
    }
  }

  // ══ 回答入力(ひらがな限定) ════════════════════════════════

  var composing = false;

  function setupGuessInput() {
    var input = $('guess');

    input.addEventListener('compositionstart', function () {
      composing = true;
    });
    input.addEventListener('compositionend', function () {
      composing = false;
      input.value = Kana.toHiraganaOnly(input.value);
    });
    input.addEventListener('input', function () {
      // 変換中は触らない(IME を壊すため)。確定したところでひらがなだけに落とす
      if (composing) return;
      var filtered = Kana.toHiraganaOnly(input.value);
      if (filtered !== input.value) input.value = filtered;
    });

    $('guess-form').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var text = Kana.toHiraganaOnly(input.value);
      input.value = '';
      if (!text) return;
      Net.send({ t: 'guess', text: text });
      // 入力欄は開いたままにする。連続で撃てるのがこのゲームの気持ちよさなので
    });

    // 「キーボード以外をタップするとキーボードが消える」
    document.addEventListener(
      'pointerdown',
      function (ev) {
        if (document.activeElement !== input) return;
        if (ev.target.closest('.guessbar')) return;
        input.blur();
      },
      true,
    );
  }

  // ══ WebSocket の受信 ══════════════════════════════════════

  function wireSocket() {
    Net.on('hello', function (msg) {
      state.me = msg.user;
      if (state.board) state.board.myUserId = msg.user.id;
      if (pendingJoin) {
        Net.send(pendingJoin);
        pendingJoin = null;
      } else if (lastRoomCode) {
        // 再接続。サーバー側の部屋の関連付け(どのソケットに送ればよいか)を結び直す
        Net.send({ t: 'join', code: lastRoomCode });
      }
    });

    Net.on('room', function (msg) {
      state.room = msg;
      lastRoomCode = msg.code;
      if (msg.state === 'waiting') {
        renderWait();
        // ギャラリーを見ている最中に画面を奪わない
        if ($('view-gallery').classList.contains('hidden')) show('wait');
      } else {
        renderScores();
      }
    });

    Net.on('joinError', function (msg) {
      lastRoomCode = null;
      toast(msg.message);
      show('home');
    });

    Net.on('left', function () {
      lastRoomCode = null;
      state.room = null;
      state.round = null;
      state.recommend = null;
      stopRecommendTimer();
      show('home');
      refreshStats();
      loadHomeBackground();
    });

    Net.on('round', enterRound);

    Net.on('s0', function (msg) {
      if (state.board) state.board.remoteStart(msg);
    });
    Net.on('s+', function (msg) {
      if (state.board) state.board.remoteAppend(msg);
    });
    Net.on('undo', function (msg) {
      if (state.board) state.board.removeLastBy(msg.u);
    });
    Net.on('clear', function () {
      if (state.board) state.board.reset();
    });

    Net.on('chat', function (msg) {
      bubble('<b>' + esc(msg.displayName) + '</b>' + esc(msg.text), msg.fromDrawer ? 'notice' : '');
    });

    Net.on('correct', function (msg) {
      bubble(esc(msg.displayName) + ' せいかい！ +' + msg.points, 'correct');
      if (state.me && msg.userId === state.me.id) {
        state.solved = true;
        var input = $('guess');
        input.value = '';
        input.disabled = true;
        input.placeholder = 'せいかい！';
        $('guess-send').disabled = true;
        $('guessarea').classList.add('solved');
        document.querySelector('.guesshint').textContent = 'せいかい！ +' + msg.points;
        input.blur();
      }
    });

    Net.on('reveal', showReveal);

    Net.on('recommendStart', enterRecommend);
    Net.on('recommended', function (msg) {
      if (!state.recommend) return;
      $('recommend-waiting').textContent =
        (state.recommend.sent ? '送信しました。' : '') + msg.count + '人が投票しました';
    });
    Net.on('recommendResult', handleRecommendResult);

    Net.on('end', showResult);

    Net.on('notice', function (msg) {
      toast(msg.message);
    });

    Net.on('error', function (msg) {
      toast(msg.message || 'エラー');
    });

    Net.on('_close', function () {
      if (!$('view-play').classList.contains('hidden')) toast('接続が切れました。つなぎ直しています…');
    });
  }

  // ══ 画面のボタン ══════════════════════════════════════════

  function wireUi() {
    $('btn-guest').onclick = async function () {
      var name = $('guest-name').value.trim() || 'ゲスト';
      $('btn-guest').disabled = true;
      try {
        var res = await Net.api('/login-guest', { body: { displayName: name } });
        Net.setToken(res.token);
        state.me = res.user;
        enterHome();
      } catch (e) {
        toast('ログインできませんでした: ' + e.message);
      } finally {
        $('btn-guest').disabled = false;
      }
    };

    $('btn-iz-retry').onclick = async function () {
      $('boot-login').classList.add('hidden');
      var res = await tryIzAutoLogin(function (t) {
        $('boot-status').textContent = t;
      });
      if (res.ok) enterHome();
      else await showLoginFallback(res);
    };

    $('btn-diag').onclick = function () {
      var pre = $('diag-body');
      pre.classList.toggle('hidden');
      pre.textContent = izDiagText();
    };

    $('btn-match').onclick = function () {
      joinRoom(null);
    };

    $('btn-code').onclick = function () {
      var code = prompt('合言葉（4文字）を入れてください。\n空のままなら新しい部屋を作ります。');
      if (code === null) return;
      code = code.trim().toUpperCase();
      joinRoom(code || null);
    };

    $('btn-gallery').onclick = function () {
      openGallery(false);
    };

    $('btn-solo').onclick = function () {
      openSoloTopic();
    };

    $('btn-shiritori').onclick = openShiritori;
    $('shiritori-back').onclick = function () {
      show('home');
      loadHomeBackground();
    };
    $('shiritori-reload').onclick = loadShiritori;
    $('btn-shiri-draw').onclick = enterShiritoriDraw;
    $('shiri-draw-back').onclick = function () {
      show('shiritori');
      loadShiritori();
    };
    $('btn-shiri-post').onclick = postShiritori;
    $('btn-shiri-undo').onclick = function () {
      if (shiriBoard) shiriBoard.undoMine();
    };
    $('btn-shiri-clear').onclick = function () {
      if (shiriBoard) shiriBoard.clearAll();
    };

    // しりとりのことば入力もひらがな限定(回答欄と同じ方式。IME は壊さない)
    (function () {
      var input = $('shiri-word');
      var composingWord = false;
      input.addEventListener('compositionstart', function () {
        composingWord = true;
      });
      input.addEventListener('compositionend', function () {
        composingWord = false;
        input.value = Kana.toHiraganaOnly(input.value);
      });
      input.addEventListener('input', function () {
        if (composingWord) return;
        var filtered = Kana.toHiraganaOnly(input.value);
        if (filtered !== input.value) input.value = filtered;
      });
    })();

    $('opt-nodraw').onchange = function () {
      Net.send({ t: 'noDraw', value: $('opt-nodraw').checked });
    };

    $('wait-back').onclick = function () {
      Net.send({ t: 'leave' });
    };

    $('wait-share').onclick = function () {
      var code = state.room ? state.room.code : '';
      if (!code) return;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(code).then(
          function () {
            toast('合言葉「' + code + '」をコピーしました');
          },
          function () {
            toast('合言葉は ' + code + ' です');
          },
        );
      } else {
        toast('合言葉は ' + code + ' です');
      }
    };

    $('btn-ready').onclick = function () {
      var mine = state.room
        ? state.room.players.filter(function (p) {
            return p.userId === (state.me && state.me.id);
          })[0]
        : null;
      Net.send({ t: 'ready', ready: !(mine && mine.ready) });
    };

    $('btn-undo').onclick = function () {
      if (!state.board) return;
      state.board.undoMine();
      Net.send({ t: 'undo' });
    };

    $('btn-clear').onclick = function () {
      if (!state.board) return;
      state.board.reset();
      Net.send({ t: 'clear' });
    };

    $('btn-again').onclick = function () {
      Net.send({ t: 'restart' });
    };

    $('result-home').onclick = function () {
      Net.send({ t: 'leave' });
    };

    $('btn-result-gallery').onclick = function () {
      openGallery(false);
    };

    $('btn-recommend-send').onclick = sendRecommend;

    $('solo-topic-back').onclick = function () {
      show('home');
    };
    $('btn-solo-reroll').onclick = rerollSoloTopic;
    $('btn-solo-start').onclick = enterSoloDraw;

    $('solo-draw-back').onclick = function () {
      show('solo-topic');
    };
    $('btn-solo-post').onclick = postSoloDrawing;
    $('btn-solo-undo').onclick = function () {
      if (state.soloBoard) state.soloBoard.undoMine();
    };
    $('btn-solo-clear').onclick = function () {
      if (state.soloBoard) state.soloBoard.clearAll();
    };

    $('gallery-back').onclick = function () {
      if (state.room && state.room.state === 'ended') show('result');
      else if (state.room) show('wait');
      else show('home');
    };

    $('gallery-mine').onclick = function () {
      openGallery(!state.gallery.mine);
    };

    $('gallery-more').onclick = loadGallery;

    $('sheet-close').onclick = function () {
      sheetDrawing = null;
      $('sheet').classList.add('hidden');
    };
    $('sheet').onclick = function (ev) {
      if (ev.target === $('sheet')) {
        sheetDrawing = null;
        $('sheet').classList.add('hidden');
      }
    };

    $('sheet-like').onclick = toggleSheetLike;
    $('sheet-share').onclick = shareSheetDrawing;
    $('sheet-comment-form').addEventListener('submit', submitSheetComment);

    setupGuessInput();
  }

  /** シェアされたリンク(?drawing=N)で開かれたら、その絵をすぐ見せる */
  async function openSharedDrawing() {
    var m = /[?&]drawing=(\d+)/.exec(location.search);
    if (!m) return;
    try {
      var res = await Net.api('/drawings/' + m[1]);
      openSheet(res.drawing);
    } catch (e) {
      /* 消えた作品などは黙って無視する */
    }
  }

  // ══ 起動 ══════════════════════════════════════════════════

  wireUi();
  wireSocket();
  boot().then(openSharedDrawing);
})();
