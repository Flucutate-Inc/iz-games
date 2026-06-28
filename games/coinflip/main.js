/**
 * コインフリップ — ゲーム本体（フロントのみ）。
 *
 * 当落・残高・ランキングはすべて IZ SDK 経由でホスト→サーバーが決める。
 * このスクリプトは「賭けの依頼」と「結果アニメーションの再生」しか行わない（当落を自前で決めない）。
 */
(function () {
  var el = function (id) {
    return document.getElementById(id);
  };

  var state = { balance: 0, choice: 'heads', minBet: 10, maxBet: 10000, busy: false, spins: 0 };

  var balanceEl = el('balance');
  var resultEl = el('result');
  var coinEl = el('coin');
  var amountEl = el('amount');
  var betBtn = el('bet-btn');

  function setBalance(v) {
    state.balance = v;
    balanceEl.textContent = Number(v).toLocaleString() + ' IZ';
  }

  function setChoice(choice) {
    state.choice = choice;
    el('choice-heads').classList.toggle('choice-active', choice === 'heads');
    el('choice-tails').classList.toggle('choice-active', choice === 'tails');
  }

  function clampAmount() {
    var n = parseInt(amountEl.value, 10);
    if (!isFinite(n) || n <= 0) n = state.minBet;
    n = Math.max(state.minBet, Math.min(state.maxBet, n));
    return n;
  }

  function setBusy(busy) {
    state.busy = busy;
    betBtn.disabled = busy;
    betBtn.textContent = busy ? '判定中…' : '賭ける';
  }

  /** コインを結果の面に向けて回す。heads=表が上(0deg), tails=裏が上(180deg)。 */
  function spinCoin(coinResult) {
    state.spins += 5; // 毎回さらに5回転させて動きを出す
    var base = state.spins * 360;
    var land = coinResult === 'tails' ? 180 : 0;
    coinEl.style.transform = 'rotateX(' + (base + land) + 'deg)';
  }

  function showResult(res) {
    setBalance(res.balance);
    if (res.won) {
      resultEl.textContent = '🎉 当たり！ +' + Number(res.payout).toLocaleString() + ' IZ';
      resultEl.className = 'result result-win';
    } else {
      resultEl.textContent = '残念… 0 IZ';
      resultEl.className = 'result result-lose';
    }
  }

  function bet() {
    if (state.busy) return;
    var amount = clampAmount();
    amountEl.value = String(amount);
    if (amount > state.balance) {
      resultEl.textContent = 'IZ が足りません';
      resultEl.className = 'result result-lose';
      return;
    }
    setBusy(true);
    resultEl.textContent = '';
    resultEl.className = 'result';

    IZ.placeBet(state.choice, amount)
      .then(function (res) {
        // サーバーが決めた coinResult に向けてコインを着地させる
        spinCoin(res.coinResult);
        // 回転アニメ（1.5s）に合わせて結果表示を遅らせる
        setTimeout(function () {
          showResult(res);
          setBusy(false);
        }, 1500);
      })
      .catch(function (err) {
        resultEl.textContent = (err && err.message) || '賭けに失敗しました';
        resultEl.className = 'result result-lose';
        setBusy(false);
      });
  }

  function renderRanking(entries) {
    var list = el('rank-list');
    var empty = el('rank-empty');
    list.innerHTML = '';
    if (!entries || entries.length === 0) {
      empty.classList.remove('view-hidden');
      return;
    }
    empty.classList.add('view-hidden');
    entries.forEach(function (e) {
      var li = document.createElement('li');
      li.className = 'rank-row';
      var sign = e.net >= 0 ? 'rank-net-plus' : 'rank-net-minus';
      var netText = (e.net >= 0 ? '+' : '') + Number(e.net).toLocaleString() + ' IZ';
      li.innerHTML =
        '<span class="rank-pos">' +
        e.rank +
        '</span><span class="rank-name"></span><span class="rank-net ' +
        sign +
        '"></span>';
      li.querySelector('.rank-name').textContent = e.displayName;
      li.querySelector('.rank-net').textContent = netText;
      list.appendChild(li);
    });
  }

  function showView(which) {
    var play = which === 'play';
    el('view-play').classList.toggle('view-hidden', !play);
    el('view-rank').classList.toggle('view-hidden', play);
    el('tab-play').classList.toggle('tab-active', play);
    el('tab-rank').classList.toggle('tab-active', !play);
    if (!play) {
      IZ.getRanking()
        .then(renderRanking)
        .catch(function () {
          renderRanking([]);
        });
    }
  }

  // ── イベント配線 ──
  el('choice-heads').addEventListener('click', function () {
    setChoice('heads');
  });
  el('choice-tails').addEventListener('click', function () {
    setChoice('tails');
  });
  Array.prototype.forEach.call(document.querySelectorAll('.chip'), function (chip) {
    chip.addEventListener('click', function () {
      amountEl.value = chip.getAttribute('data-amount');
    });
  });
  betBtn.addEventListener('click', bet);
  el('tab-play').addEventListener('click', function () {
    showView('play');
  });
  el('tab-rank').addEventListener('click', function () {
    showView('rank');
  });

  // ── 初期化（ホストから残高・設定を受け取る） ──
  IZ.ready().then(function (ctx) {
    setBalance(ctx.balance || 0);
    if (ctx.game) {
      if (typeof ctx.game.minBet === 'number') state.minBet = ctx.game.minBet;
      if (typeof ctx.game.maxBet === 'number') state.maxBet = ctx.game.maxBet;
      amountEl.min = String(state.minBet);
    }
    setChoice('heads');
    betBtn.disabled = false;
  });
})();
