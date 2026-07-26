/** 画面遷移とホーム/編成/図鑑/ガチャ/履歴/設定 */
(() => {
  let me = null;
  let allPets = [];
  let decks = [];
  let editingDeck = null; // {id, name, pets:[]}

  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // コインは絵文字だと環境により別の記号(月など)に化けるため、CSSアイコンで描く
  const COIN = '<i class="coin"></i>';

  const screens = ['auth', 'home', 'modes', 'room', 'deck', 'dex', 'gacha', 'ranking', 'history', 'settings', 'matching', 'battle'];
  function show(name) {
    for (const s of screens) $(`screen-${s}`).classList.toggle('hidden', s !== name);
  }
  document.querySelectorAll('[data-nav]').forEach(b => {
    b.addEventListener('click', () => nav(b.dataset.nav));
  });
  async function nav(name) {
    if (name === 'home') await loadHome();
    if (name === 'modes') $('modes-error').textContent = '';
    if (name === 'room') $('room-error').textContent = '';
    if (name === 'deck') await loadDeckEditor();
    if (name === 'dex') await loadDex();
    if (name === 'gacha') await loadGacha();
    if (name === 'ranking') await loadRanking();
    if (name === 'history') await loadHistory();
    if (name === 'settings') loadSettings();
    show(name);
  }

  // ─── 認証 ───────────────────────────────────────────────────
  let authMode = 'login';
  // ?admin=1 で開いたときだけ管理者トークン欄を出す(初期管理者の作成用)
  const adminBootstrap = new URLSearchParams(location.search).has('admin');
  if (adminBootstrap) {
    $('auth-admin-row').classList.remove('hidden');
    setAuthMode('register');
  }
  $('tab-login').onclick = () => setAuthMode('login');
  $('tab-register').onclick = () => setAuthMode('register');
  function setAuthMode(m) {
    authMode = m;
    $('tab-login').classList.toggle('active', m === 'login');
    $('tab-register').classList.toggle('active', m === 'register');
    $('auth-submit').textContent = m === 'login' ? 'ログイン' : 'アカウント作成';
    $('auth-admin-row').classList.toggle('hidden', !(adminBootstrap && m === 'register'));
  }
  $('auth-submit').onclick = async () => {
    $('auth-error').textContent = '';
    try {
      const body = { name: $('auth-name').value.trim(), password: $('auth-pass').value };
      const adminToken = $('auth-admin-token').value.trim();
      if (authMode === 'register' && adminToken) body.adminToken = adminToken;
      const res = await Net.api(authMode === 'login' ? '/login' : '/register', { body });
      Net.setToken(res.token);
      me = res.user;
      Net.connectWS();
      await nav('home');
    } catch (e) {
      $('auth-error').textContent = e.message;
    }
  };
  $('auth-pass').addEventListener('keydown', e => { if (e.key === 'Enter') $('auth-submit').click(); });

  // ─── ホーム ─────────────────────────────────────────────────
  async function loadHome() {
    const [meRes, petsRes, decksRes] = await Promise.all([
      Net.api('/me'), Net.api('/pets'), Net.api('/decks'),
    ]);
    me = meRes.user;
    allPets = petsRes.pets;
    decks = decksRes.decks;
    $('home-player').innerHTML =
      `<b>${esc(me.name)}</b> Lv${me.level} <span>${COIN}${me.coins}</span> <span>⭐${me.rating}</span> <small>${me.wins}勝${me.losses}敗</small>`;
    const deck = decks.find(d => d.selected);
    if (deck) {
      const avg = (deck.pets.reduce((a, id) => a + (allPets.find(p => p.id === id)?.cost || 0), 0) / deck.pets.length).toFixed(1);
      $('home-deck-summary').innerHTML =
        deck.pets.map(id => `<img src="/assets/pets/${id}/icon.png" title="${esc(petName(id))}">`).join('') +
        `<span style="width:100%">${esc(deck.name)} ・ ${deck.pets.length}体 ・ 平均コスト ${avg}</span>`;
    } else {
      $('home-deck-summary').innerHTML = '<small>デッキがありません</small>';
    }
    void refreshIzShop();
  }
  const petName = id => allPets.find(p => p.id === id)?.name || id;

  // ─── IZ 課金(IZアプリ内でのみ表示) ───────────────────────────
  async function refreshIzShop() {
    const panel = $('iz-shop');
    try {
      const embedded = !!window.ReactNativeWebView || window.parent !== window;
      if (!embedded || !window.IZ) return panel.classList.add('hidden');
      const status = await Net.api('/purchase/status');
      panel.classList.toggle('hidden', !status.enabled);
    } catch {
      panel.classList.add('hidden');
    }
  }

  document.querySelectorAll('.iz-buy').forEach(btn => {
    btn.addEventListener('click', async () => {
      const izAmount = Number(btn.dataset.iz);
      $('iz-msg').textContent = '';
      document.querySelectorAll('.iz-buy').forEach(b => (b.disabled = true));
      try {
        // IZ の残高移動は IZ アプリのサーバーが行い、署名済みレシートが返る
        const purchase = await IZ.purchase(izAmount);
        const res = await Net.api('/purchase', { body: { receipt: purchase.receipt } });
        me = res.user;
        $('iz-msg').style.color = 'var(--green)';
        $('iz-msg').innerHTML = `${res.coins}${COIN} を受け取りました`;
        await loadHome();
      } catch (e) {
        $('iz-msg').style.color = '';
        $('iz-msg').textContent = e.message || '購入に失敗しました';
      } finally {
        document.querySelectorAll('.iz-buy').forEach(b => (b.disabled = false));
      }
    });
  });

  $('btn-start').onclick = () => nav('modes');
  $('btn-room-mode').onclick = () => nav('room');

  $('btn-random-match').onclick = () => {
    $('modes-error').textContent = '';
    Net.send({ type: 'queue' });
    $('matching-status').textContent = '対戦相手を探しています…';
    $('matching-code').textContent = '';
    show('matching');
  };
  $('btn-practice').onclick = () => {
    $('modes-error').textContent = '';
    Net.send({ type: 'practice' });
    $('matching-status').textContent = 'CPU練習試合を準備中…';
    $('matching-code').textContent = '';
    show('matching');
  };
  $('btn-create-room').onclick = () => {
    $('room-error').textContent = '';
    Net.send({ type: 'room_create' });
  };
  $('btn-join-room').onclick = () => {
    $('room-error').textContent = '';
    Net.send({ type: 'room_join', code: $('room-code-input').value.trim() });
    $('matching-status').textContent = 'ルームに参加しています…';
    show('matching');
  };
  $('btn-cancel-match').onclick = () => {
    Net.send({ type: 'queue_cancel' });
    nav('modes');
  };

  // ─── デッキ編成 ─────────────────────────────────────────────
  async function loadDeckEditor() {
    const [petsRes, decksRes] = await Promise.all([Net.api('/pets'), Net.api('/decks')]);
    allPets = petsRes.pets;
    decks = decksRes.decks;
    const selected = decks.find(d => d.selected) || decks[0];
    editingDeck = selected ? { ...selected, pets: [...selected.pets] } : { id: null, name: '新しいデッキ', pets: [] };
    renderDeckEditor();
  }

  function renderDeckEditor() {
    const sel = $('deck-select');
    sel.innerHTML = decks.map(d => `<option value="${d.id}" ${editingDeck.id === d.id ? 'selected' : ''}>${esc(d.name)}${d.selected ? ' ✓' : ''}</option>`).join('');
    sel.onchange = () => {
      const d = decks.find(x => String(x.id) === sel.value);
      editingDeck = { ...d, pets: [...d.pets] };
      renderDeckEditor();
    };
    $('deck-name').value = editingDeck.name;

    const slots = $('deck-slots');
    slots.innerHTML = '';
    for (let i = 0; i < 8; i++) {
      const petId = editingDeck.pets[i];
      const div = document.createElement('div');
      div.className = 'deck-slot';
      if (petId) {
        div.innerHTML = `<img src="/assets/pets/${petId}/icon.png" title="${esc(petName(petId))}(外す)">`;
        div.querySelector('img').onclick = () => {
          editingDeck.pets.splice(i, 1);
          renderDeckEditor();
        };
      } else {
        div.textContent = i < 4 ? '必須' : '空き';
      }
      slots.appendChild(div);
    }
    const avg = editingDeck.pets.length
      ? (editingDeck.pets.reduce((a, id) => a + (allPets.find(p => p.id === id)?.cost || 0), 0) / editingDeck.pets.length).toFixed(1)
      : '-';
    $('deck-cost').textContent = `${editingDeck.pets.length}/8体 ・ 平均コスト ${avg}`;

    const owned = $('deck-owned');
    owned.innerHTML = '';
    for (const p of allPets.filter(p => p.owned)) {
      const inDeck = editingDeck.pets.includes(p.id);
      const cell = document.createElement('div');
      cell.className = 'pet-cell' + (inDeck ? ' inDeck' : '');
      cell.innerHTML = `<span class="pcost">${p.cost}</span><img src="/assets/pets/${p.id}/icon.png"><span class="pname">${esc(p.name)}</span>`;
      cell.onclick = () => {
        if (inDeck) editingDeck.pets = editingDeck.pets.filter(id => id !== p.id);
        else if (editingDeck.pets.length < 8) editingDeck.pets.push(p.id);
        renderDeckEditor();
      };
      owned.appendChild(cell);
    }
  }

  $('btn-deck-save').onclick = async () => {
    $('deck-error').textContent = '';
    try {
      const res = await Net.api('/decks', { body: { id: editingDeck.id, name: $('deck-name').value.trim() || editingDeck.name, pets: editingDeck.pets } });
      editingDeck.id = res.id;
      await loadDeckEditor();
      $('deck-error').textContent = '';
    } catch (e) {
      $('deck-error').textContent = e.message;
    }
  };
  $('btn-deck-use').onclick = async () => {
    $('deck-error').textContent = '';
    try {
      if (!editingDeck.id) throw new Error('先に保存してください');
      await Net.api(`/decks/${editingDeck.id}/select`, { body: {} });
      await loadDeckEditor();
    } catch (e) {
      $('deck-error').textContent = e.message;
    }
  };
  $('btn-deck-new').onclick = () => {
    editingDeck = { id: null, name: '新しいデッキ', pets: [] };
    renderDeckEditor();
  };

  // ─── 図鑑(ペット・建物・強化) ───────────────────────────────
  let dexData = null;
  let dexTab = 'pets';

  document.querySelectorAll('[data-dextab]').forEach(btn => {
    btn.addEventListener('click', () => {
      dexTab = btn.dataset.dextab;
      document.querySelectorAll('[data-dextab]').forEach(b => b.classList.toggle('active', b === btn));
      renderDexTab();
    });
  });

  function renderDexTab() {
    $('dex-grid').classList.toggle('hidden', dexTab !== 'pets');
    $('dex-facilities').classList.toggle('hidden', dexTab !== 'facilities');
    $('dex-upgrades').classList.toggle('hidden', dexTab !== 'upgrades');
    if (dexTab === 'facilities') renderDexFacilities();
    if (dexTab === 'upgrades') renderDexUpgrades();
  }

  /** 建物: 実際に対戦で使われる公開バランス版の値と、強化レベルごとの数値 */
  function renderDexFacilities() {
    const { facilities, upgrades } = dexData;
    const box = $('dex-facilities');
    const up = upgrades?.mainHouse;
    const entries = [
      {
        id: 'lane-house', name: 'わんこハウス(レーンハウス)', img: '/assets/facilities/lane-house-normal-blue.png',
        desc: '各レーンを自動で防衛する。破壊されると1ポイントを相手に与える。',
        conf: facilities.laneHouse, upgradable: false,
      },
      {
        id: 'main-house', name: 'メインハウス', img: '/assets/facilities/main-house-normal-blue.png',
        desc: '本拠地。HPが0になった側の負け。自軍レーンハウスがどちらか破壊されるまで攻撃を開始しない。',
        conf: facilities.mainHouse, upgradable: true,
      },
    ];
    box.innerHTML = '';
    for (const e of entries) {
      const card = document.createElement('div');
      card.className = 'card';
      const rows = [
        ['HP', e.conf.hp],
        ['攻撃力', e.conf.attackPower],
        ['射程', e.conf.attackRange],
        ['攻撃間隔', `${e.conf.attackInterval}秒`],
      ];
      let lvTable = '';
      if (e.upgradable && up) {
        const header = Array.from({ length: up.maxLevel + 1 }, (_, i) => `<th>Lv${i}</th>`).join('');
        const hpRow = Array.from({ length: up.maxLevel + 1 }, (_, i) => `<td>${Math.round(e.conf.hp * (1 + up.hpPerLevel * i))}</td>`).join('');
        const atkRow = Array.from({ length: up.maxLevel + 1 }, (_, i) => `<td>${Math.round(e.conf.attackPower * (1 + up.attackPerLevel * i))}</td>`).join('');
        const costRow = Array.from({ length: up.maxLevel + 1 }, (_, i) => `<td>${i === 0 ? '-' : `🦴${up.baseCost + up.costStep * (i - 1)}`}</td>`).join('');
        lvTable = `<h4 style="margin-top:10px;font-size:.85rem">試合内強化(おうち強化)</h4>
          <table class="lv-table"><tr><th>項目</th>${header}</tr>
          <tr><td>HP</td>${hpRow}</tr>
          <tr><td>攻撃力</td>${atkRow}</tr>
          <tr><td>必要ほね</td>${costRow}</tr></table>`;
      }
      card.innerHTML = `<div class="dex-entry">
          <img src="${e.img}" alt="${esc(e.name)}">
          <div><h3 style="font-size:1rem">${esc(e.name)}</h3>
            <p style="font-size:.82rem;opacity:.85;margin-top:4px">${esc(e.desc)}</p></div>
        </div>
        <table class="stat-table">${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table>
        ${lvTable}`;
      box.appendChild(card);
    }
  }

  /** 強化(ほね容量・回復・ペット・おうち)のレベルごとの効果と必要ほね */
  function renderDexUpgrades() {
    const box = $('dex-upgrades');
    const up = dexData.upgrades;
    const rules = dexData.rules;
    box.innerHTML = '';
    if (!up) {
      box.innerHTML = '<p style="opacity:.7">この版に強化設定はありません</p>';
      return;
    }
    const lvHeader = conf => Array.from({ length: conf.maxLevel + 1 }, (_, i) => `<th>Lv${i}</th>`).join('');
    const costRow = conf => Array.from({ length: conf.maxLevel + 1 }, (_, i) => `<td>${i === 0 ? '-' : `🦴${conf.baseCost + conf.costStep * (i - 1)}`}</td>`).join('');

    const cards = [
      {
        title: '🦴 ほね容量',
        desc: `ほねの最大値が上がる(初期 ${rules.bone.max})。`,
        conf: up.boneCapacity,
        effectLabel: '最大ほね',
        effect: i => rules.bone.max + up.boneCapacity.increment * i,
      },
      {
        title: '🦴 ほね回復',
        desc: `ほねが貯まる速さが上がる(初期 ${rules.bone.regenSec}秒に1)。`,
        conf: up.boneSpeed,
        effectLabel: 'ほね1個あたり',
        effect: i => `${(rules.bone.regenSec / (1 + up.boneSpeed.speedupPerLevel * i)).toFixed(2)}秒`,
      },
      {
        title: '🐕 ペット強化(ペットごと)',
        desc: 'そのペットのHPと攻撃力が上がる。HPは強化後に出撃したペットへ、攻撃力は出撃済みのペットにも反映される。必要ほねはペットのコストに比例する(コスト4が基準)。',
        conf: up.pets,
        effectLabel: 'HP・攻撃力',
        effect: i => `+${Math.round(up.pets.hpPerLevel * i * 100)}%`,
        costNote: true,
      },
      {
        title: '🏠 おうち強化',
        desc: 'メインハウスのHP上限と攻撃力が上がる。上げた分のHPはその場で回復する。',
        conf: up.mainHouse,
        effectLabel: 'HP・攻撃力',
        effect: i => `+${Math.round(up.mainHouse.hpPerLevel * i * 100)}%`,
      },
    ];
    for (const c of cards) {
      const el = document.createElement('div');
      el.className = 'card';
      const effRow = Array.from({ length: c.conf.maxLevel + 1 }, (_, i) => `<td>${c.effect(i)}</td>`).join('');
      el.innerHTML = `<h3 style="font-size:1rem">${c.title}</h3>
        <p style="font-size:.82rem;opacity:.85;margin:4px 0 8px">${esc(c.desc)}</p>
        <table class="lv-table">
          <tr><th>項目</th>${lvHeader(c.conf)}</tr>
          <tr><td>${c.effectLabel}</td>${effRow}</tr>
          <tr><td>必要ほね${c.costNote ? '(コスト4基準)' : ''}</td>${costRow(c.conf)}</tr>
        </table>`;
      box.appendChild(el);
    }
    const note = document.createElement('p');
    note.className = 'terms';
    note.textContent = `強化は試合ごとにリセットされます(永続的な強さの差は生じません)。表示値はバランス版 #${dexData.balanceVersionId} の実データです。`;
    box.appendChild(note);
  }

  async function loadDex() {
    const res = await Net.api('/pets');
    dexData = res;
    allPets = res.pets;
    renderDexTab();
    const grid = $('dex-grid');
    grid.innerHTML = '';
    for (const p of allPets) {
      const cell = document.createElement('div');
      cell.className = 'pet-cell' + (p.owned ? '' : ' locked');
      const tag = p.owned ? '' : '<span class="locktag">未所有</span>';
      cell.innerHTML = `<span class="pcost">${p.cost}</span>${rarityBadge(p.rarity)}`
        + `<img src="/assets/pets/${p.id}/icon.png"><span class="pname">${esc(p.name)}</span>${tag}`;
      cell.onclick = () => showPetDetail(p);
      grid.appendChild(cell);
    }
  }

  function showPetDetail(p) {
    const body = $('dex-detail-body');
    const dps = p.attackPower ? Math.round(p.attackPower / p.attackInterval) : 0;
    body.innerHTML = `
      <div class="dex-detail-head">
        <img src="/assets/pets/${p.id}/idle.png">
        <div><h3>${esc(p.name)} ${rarityBadge(p.rarity)}</h3><p style="opacity:.8;font-size:.85rem">${esc(p.role)}${p.owned ? '' : ' ・ 未所有'}</p></div>
      </div>
      <p style="margin:10px 0;font-size:.9rem">${esc(p.description)}</p>
      <table class="stat-table">
        <tr><td>コスト</td><td>${p.cost}</td></tr>
        <tr><td>HP</td><td>${p.hp}${p.spawnCount ? ` ×${p.spawnCount}体` : ''}</td></tr>
        <tr><td>${p.attackType === 'heal' ? '回復量' : '攻撃力'}</td><td>${p.attackType === 'heal' ? p.healPower : p.attackPower}${p.buildingAttackPower ? `(対施設 ${p.buildingAttackPower})` : ''}</td></tr>
        <tr><td>攻撃間隔 / DPS</td><td>${p.attackInterval}秒 / ${dps}</td></tr>
        <tr><td>射程 / 速度</td><td>${p.attackRange} / ${p.moveSpeed}</td></tr>
        <tr><td>再使用時間</td><td>${p.rechargeSec}秒</td></tr>
        <tr><td>タイプ</td><td>${p.movement === 'flying' ? '飛行' : '地上'} / ${p.attackType}</td></tr>
      </table>
      ${petLevelTable(p)}
      ${p.owned ? '' : '<button class="btn primary big" id="btn-to-gacha" style="margin-top:12px">ガチャでなかまにする</button>'}
      <button class="btn" id="btn-dex-close" style="margin-top:10px;width:100%">閉じる</button>`;
    $('dex-detail').classList.remove('hidden');
    $('btn-dex-close').onclick = () => $('dex-detail').classList.add('hidden');
    const gachaBtn = $('btn-to-gacha');
    if (gachaBtn) {
      gachaBtn.onclick = () => {
        $('dex-detail').classList.add('hidden');
        void nav('gacha');
      };
    }
  }

  /** レアリティのバッジ(図鑑・ガチャ共通) */
  function rarityBadge(rarity) {
    if (!rarity) return '';
    return `<span class="rarity r-${esc(rarity)}">${esc(rarity)}</span>`;
  }

  /** ペット詳細の「試合内強化」表(実データから算出) */
  function petLevelTable(p) {
    const up = dexData?.upgrades?.pets;
    if (!up) return '';
    const isHeal = p.attackType === 'heal';
    const basePower = isHeal ? p.healPower : p.attackPower;
    const header = Array.from({ length: up.maxLevel + 1 }, (_, i) => `<th>Lv${i}</th>`).join('');
    const hpRow = Array.from({ length: up.maxLevel + 1 }, (_, i) => `<td>${Math.round(p.hp * (1 + up.hpPerLevel * i))}</td>`).join('');
    const atkRow = Array.from({ length: up.maxLevel + 1 }, (_, i) => `<td>${Math.round(basePower * (1 + up.attackPerLevel * i))}</td>`).join('');
    const costRow = Array.from({ length: up.maxLevel + 1 }, (_, i) => {
      if (i === 0) return '<td>-</td>';
      const base = up.baseCost + up.costStep * (i - 1);
      return `<td>🦴${Math.max(1, Math.round(base * (p.cost / 4)))}</td>`;
    }).join('');
    return `<h4 style="margin-top:12px;font-size:.85rem">試合内強化(ペット強化)</h4>
      <table class="lv-table"><tr><th>項目</th>${header}</tr>
      <tr><td>HP</td>${hpRow}</tr>
      <tr><td>${isHeal ? '回復量' : '攻撃力'}</td>${atkRow}</tr>
      <tr><td>必要ほね</td>${costRow}</tr></table>
      <p class="terms">強化は試合ごとにリセットされます。</p>`;
  }

  // ─── ガチャ ─────────────────────────────────────────────────
  // ソシャゲのガチャ画面の定石に沿う: ガチャ機 → カプセル → 1枚ずつ開封(タップでスキップ)
  // → まとめて結果表示。CTAは親指ゾーンに置き、提供割合とラインナップはモーダルへ逃がす。
  let gachaInfo = null;
  let revealTimers = [];
  let revealSkip = null;

  async function loadGacha() {
    gachaInfo = await Net.api('/gacha');
    $('gacha-error').textContent = '';
    $('gacha-coins').innerHTML = `${COIN}${gachaInfo.coins}`;
    const b1 = $('btn-gacha-1');
    const b10 = $('btn-gacha-10');
    b1.querySelector('small').innerHTML = `${COIN}${gachaInfo.singleCost}`;
    b10.querySelector('b').textContent = `${gachaInfo.multiCount}回`;
    b10.querySelector('small').innerHTML = `${COIN}${gachaInfo.multiCost}`;
    const tag = b10.querySelector('.pull-tag');
    if (gachaInfo.multiGuaranteeRarity) tag.textContent = `${gachaInfo.multiGuaranteeRarity}以上確定`;
    else tag.classList.add('hidden');
    b1.disabled = gachaInfo.coins < gachaInfo.singleCost;
    b10.disabled = gachaInfo.coins < gachaInfo.multiCost;
    if (b1.disabled && b10.disabled) $('gacha-error').textContent = 'コインが足りません。対戦で集めよう。';
  }

  /** 提供割合 / ラインナップ(モーダル) */
  function showGachaInfo(kind) {
    if (!gachaInfo) return;
    const title = kind === 'rates' ? '提供割合' : 'ラインナップ';
    const body = kind === 'rates'
      ? gachaInfo.rarities.map(r => `
          <div class="rate-row">${rarityBadge(r.id)} <span>${esc(r.name)}<br><small>${r.pets.length}種 ・ 重複時 ${COIN}${r.duplicateCoins}</small></span>
          <span class="rate-val">${r.rate}%</span></div>`).join('')
        + `<p class="terms">${gachaInfo.multiGuaranteeRarity
          ? `${gachaInfo.multiCount}回ひくと ${gachaInfo.multiGuaranteeRarity} 以上が1回以上でます。` : ''}
           すでに なかまの わんこが出たときはコインが戻ります。</p>`
      : gachaInfo.rarities.map(r => `
          <h4 class="pool-head">${rarityBadge(r.id)} ${esc(r.name)}</h4>
          <div class="pet-grid">${r.pets.map(p => `
            <div class="pet-cell${p.owned ? '' : ' locked'}">
              <span class="pcost">${p.cost}</span>
              <img src="/assets/pets/${p.id}/icon.png" alt="">
              <span class="pname">${esc(p.name)}</span>
              ${p.owned ? '<span class="locktag">所持</span>' : ''}
            </div>`).join('')}</div>`).join('');
    $('gacha-info-title').textContent = title;
    $('gacha-info-body').innerHTML = body;
    $('gacha-info').classList.remove('hidden');
  }
  $('btn-gacha-rates').onclick = () => showGachaInfo('rates');
  $('btn-gacha-pool').onclick = () => showGachaInfo('pool');
  $('btn-gacha-info-close').onclick = () => $('gacha-info').classList.add('hidden');

  $('btn-gacha-1').onclick = () => drawGacha(1);
  $('btn-gacha-10').onclick = () => drawGacha(gachaInfo?.multiCount || 10);

  async function drawGacha(count) {
    $('gacha-error').textContent = '';
    $('btn-gacha-1').disabled = $('btn-gacha-10').disabled = true;
    // 先にガチャ機を回す(通信待ちを演出で隠す)
    const machine = $('gacha-machine');
    machine.classList.add('shake');
    const shaken = new Promise(r => setTimeout(r, 900));
    try {
      const [res] = await Promise.all([Net.api('/gacha/draw', { body: { count } }), shaken]);
      me = res.user;
      machine.classList.remove('shake');
      dropCapsule();
      setTimeout(() => playReveal(res), 420);
      await loadGacha();
    } catch (e) {
      machine.classList.remove('shake');
      $('gacha-error').textContent = e.message;
      await loadGacha();
    }
  }

  function dropCapsule() {
    const cap = $('gacha-capsule');
    cap.classList.remove('hidden', 'drop');
    void cap.offsetWidth; // アニメーションを再生し直す
    cap.classList.add('drop');
    setTimeout(() => cap.classList.add('hidden'), 900);
  }

  /** 1枚ずつ開封 → まとめて結果。画面タップでいつでもスキップできる */
  function playReveal(res) {
    const overlay = $('gacha-result');
    const burst = $('gacha-burst');
    const reveal = $('gacha-reveal');
    const rank = r => gachaInfo.rarities.findIndex(x => x.id === r);
    const best = res.results.reduce((a, b) => (rank(b.rarity) > rank(a.rarity) ? b : a), res.results[0]);

    overlay.classList.remove('hidden');
    $('gacha-summary').classList.add('hidden');
    reveal.className = 'reveal';
    $('gacha-tap-hint').classList.remove('hidden');
    burst.className = `burst on${rank(best.rarity) >= gachaInfo.rarities.length - 1 ? ' sr' : ''}`;
    reveal.innerHTML = '';

    let i = 0;
    const showOne = () => {
      const r = res.results[i];
      reveal.className = `reveal r-${r.rarity}`; // 後光の色をレアリティに合わせる
      reveal.innerHTML = `
        <div class="reveal-card r-${esc(r.rarity)}">
          ${res.results.length > 1 ? `<span class="reveal-count">${i + 1} / ${res.results.length}</span>` : ''}
          <span class="rarity r-${esc(r.rarity)}">${esc(r.rarity)}</span>
          <img src="/assets/pets/${r.petId}/idle.png" alt="">
          <span class="rname">${esc(r.name)}</span>
          <span class="rtag ${r.duplicate ? 'dup' : 'new'}">${r.duplicate ? `おなじわんこ → ${COIN}${r.coins}` : 'NEW!'}</span>
        </div>`;
      i++;
      if (i < res.results.length) revealTimers.push(setTimeout(showOne, 620));
      else revealTimers.push(setTimeout(() => showSummary(res), 900));
    };
    showOne();

    revealSkip = () => showSummary(res);
    overlay.onclick = () => { if (!$('gacha-summary').classList.contains('hidden')) return; revealSkip(); };
  }

  function clearReveal() {
    revealTimers.forEach(clearTimeout);
    revealTimers = [];
  }

  function showSummary(res) {
    clearReveal();
    const newCount = res.results.filter(r => !r.duplicate).length;
    $('gacha-reveal').innerHTML = '';
    $('gacha-reveal').className = 'reveal hidden'; // 空の開封エリアが場所を取らないように畳む
    $('gacha-tap-hint').classList.add('hidden');
    $('summary-cards').innerHTML = res.results.map((r, i) => `
      <div class="gacha-card r-${esc(r.rarity)}${r.duplicate ? ' dup' : ''}" style="animation-delay:${i * 60}ms">
        <span class="rarity r-${esc(r.rarity)}">${esc(r.rarity)}</span>
        <img src="/assets/pets/${r.petId}/icon.png" alt="">
        <span class="gname">${esc(r.name)}</span>
        <span class="gtag">${r.duplicate ? `+${COIN}${r.coins}` : 'NEW!'}</span>
      </div>`).join('');
    $('summary-line').innerHTML = `${newCount > 0 ? `<b>${newCount}体が なかまになった!</b><br>` : ''}`
      + `つかったコイン ${COIN}${res.spent}${res.refunded ? ` ・ もどったコイン ${COIN}${res.refunded}` : ''}`;
    $('gacha-summary').classList.remove('hidden');
  }

  $('btn-gacha-close').onclick = e => {
    e.stopPropagation();
    clearReveal();
    $('gacha-burst').className = 'burst';
    $('gacha-result').classList.add('hidden');
  };

  // ─── ランキング ─────────────────────────────────────────────
  async function loadRanking() {
    const res = await Net.api('/ranking');
    const list = $('ranking-list');
    list.innerHTML = '';
    if (res.entries.length === 0) {
      list.innerHTML = '<p style="text-align:center;opacity:.7">まだ対戦記録がありません</p>';
    }
    const row = e => {
      const div = document.createElement('div');
      div.className = 'card history-item' + (e.isMe ? ' rank-me' : '');
      const medal = e.rank === 1 ? '🥇' : e.rank === 2 ? '🥈' : e.rank === 3 ? '🥉' : `${e.rank}位`;
      div.innerHTML = `<span class="res">${medal}</span>
        <span><b>${esc(e.name)}</b> <small style="opacity:.7">Lv${e.level}</small></span>
        <span style="opacity:.7;font-size:.8rem">${e.wins}勝${e.losses}敗${e.draws ? e.draws + '分' : ''}</span>
        <span style="margin-left:auto">⭐${e.rating}</span>`;
      return div;
    };
    for (const e of res.entries) list.appendChild(row(e));
    if (res.me && !res.entries.some(e => e.isMe)) {
      const sep = document.createElement('p');
      sep.style.cssText = 'text-align:center;opacity:.6;font-size:.8rem';
      sep.textContent = '⋮';
      list.appendChild(sep);
      list.appendChild(row(res.me));
    }
  }

  // ─── 履歴 ───────────────────────────────────────────────────
  async function loadHistory() {
    const res = await Net.api('/history');
    const list = $('history-list');
    const label = { win: '勝利', lose: '敗北', draw: '引き分け', invalid: '無効' };
    list.innerHTML = res.history.length === 0 ? '<p style="text-align:center;opacity:.7">まだ対戦していません</p>' : '';
    for (const h of res.history) {
      const div = document.createElement('div');
      div.className = 'card history-item';
      div.innerHTML = `
        <span class="res ${h.result}">${label[h.result]}</span>
        <span>vs ${esc(h.opponent)}</span>
        <span style="opacity:.7;font-size:.8rem">${h.myDeck.length}体デッキ ・ ${Math.round(h.durationSec || 0)}秒</span>
        <span style="margin-left:auto">⭐${h.ratingBefore}→${h.ratingAfter}</span>`;
      list.appendChild(div);
    }
  }

  // ─── 設定 ───────────────────────────────────────────────────
  function loadSettings() {
    $('settings-info').innerHTML = `<p><b>${esc(me?.name || '')}</b></p><p style="opacity:.7;font-size:.85rem">Lv${me?.level} ・ レート${me?.rating}</p>`;
  }
  $('btn-logout').onclick = async () => {
    try { await Net.api('/logout', { body: {} }); } catch {}
    Net.setToken(null);
    Net.disconnectWS();
    location.reload();
  };

  // ─── WS イベント ─────────────────────────────────────────────
  Net.on('room_created', msg => {
    $('matching-status').textContent = 'あいことばを相手に伝えてください';
    $('matching-code').textContent = msg.code;
    show('matching');
  });
  Net.on('match_start', msg => {
    show('battle');
    Battle.start(msg, () => nav('home'));
  });
  Net.on('state', msg => Battle.applyState(msg.state));
  Net.on('snapshot', msg => Battle.applySnapshot(msg));
  Net.on('event', msg => Battle.onEvent(msg.ev));
  Net.on('match_end', msg => Battle.showResult(msg));
  Net.on('opponent_connection', () => {});
  Net.on('op_rejected', msg => console.warn('操作拒否:', msg.error));
  Net.on('error', msg => {
    const matching = !$('screen-matching').classList.contains('hidden');
    if (matching) {
      $('matching-status').textContent = msg.error;
      if (!msg.error.includes('探して')) setTimeout(() => nav('modes'), 1500);
      return;
    }
    // 表示中の画面のエラー欄に出す
    const target = !$('screen-room').classList.contains('hidden') ? 'room-error'
      : !$('screen-modes').classList.contains('hidden') ? 'modes-error' : 'home-error';
    $(target).textContent = msg.error;
  });

  // ─── 起動 ───────────────────────────────────────────────────
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

  /**
   * IZ アプリ内(WebView/iframe)で開かれた場合の自動ログイン。
   * ホストから Firebase ID トークンを受け取り、サーバーで署名検証する。
   * 未対応ホスト・タイムアウト時は false を返して通常ログインへフォールバック。
   */
  async function tryIzAutoLogin() {
    const embedded = !!window.ReactNativeWebView || window.parent !== window;
    if (!embedded || !window.IZ) return false;
    try {
      const init = await withTimeout(IZ.ready(), 3000);
      const idToken = await withTimeout(IZ.getIdToken(), 3000);
      if (!idToken) return false;
      const res = await Net.api('/login-iz', { body: { idToken, displayName: init.user && init.user.displayName } });
      Net.setToken(res.token);
      me = res.user;
      return true;
    } catch {
      return false;
    }
  }

  (async () => {
    // IZ アプリ内では IZ アカウントを優先(アプリ側のアカウント切替に追従)
    $('matching-status').textContent = 'IZアカウントでログイン中…';
    show('matching');
    if (await tryIzAutoLogin()) {
      await nav('home');
      Net.connectWS();
      return;
    }
    if (Net.token) {
      try {
        await nav('home');
        Net.connectWS();
        return;
      } catch {
        Net.setToken(null);
      }
    }
    show('auth');
  })();
})();
