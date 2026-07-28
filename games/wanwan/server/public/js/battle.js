/**
 * 対戦画面: canvas 描画+WS同期。
 * 自分は常に左側になるようにビューをミラーリングする(サーバーは side 0=左固定)。
 */
const Battle = (() => {
  const LANE_LEN = 1000;
  const canvas = document.getElementById('battle-canvas');
  const ctx = canvas.getContext('2d');
  // ワールド(描画基準)サイズ。canvas の実ピクセルは画面に合わせて動的に変わる
  const W = 960;
  const H = 540;

  const LANE_Y = { top: H * 0.58, bottom: H * 0.86 };
  const X0 = 40;
  const X1 = W - 40;

  /** canvas の実サイズを表示領域に合わせる(上下の余白をなくす) */
  function syncCanvasSize() {
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    if (cw > 0 && ch > 0 && (canvas.width !== cw || canvas.height !== ch)) {
      canvas.width = cw;
      canvas.height = ch;
    }
  }

  function containFit() {
    return Math.min(canvas.width / W, canvas.height / H);
  }

  // 素材
  const images = {};
  function img(src) {
    if (!images[src]) {
      images[src] = new Image();
      images[src].src = src;
    }
    return images[src];
  }
  const petImg = (petId, frame) => img(`/assets/pets/${petId}/${frame}.png`);
  const facImg = (kind, state, color) => img(`/assets/facilities/${kind}-${state}-${color}.png`);
  const fxImg = name => img(`/assets/effects/${name}.png`);
  const bg = img('/assets/background/arena.png');

  // 状態
  let ctxData = null; // match_start のスナップショット(pets, rules, side, ...)
  let state = null; // 最新のサーバー state
  let petsById = {};
  let selectedPet = null;
  let effects = []; // {name, x, lane, until, scale}
  let projectiles = []; // {fromX, fromY, toX, toY(画面座標基準の関数用world値), start, dur, impactLane, impactX}
  let displayPos = {}; // unitId -> x(補間表示用)
  let running = false;
  let onEnd = null;
  let handSig = ''; // 手札DOMの再構築判定(毎フレーム作り直すとクリックが失われる)
  let handSlots = []; // カードの並び(デッキ全体をコスト順に固定。試合中は変わらない)
  let upgradeSig = ''; // 強化ボタンDOMの再構築判定

  // カメラ。T = containFit * cam.s がワールド→画面ピクセルの倍率。
  // 通常時は視界幅がフィールドの約1/3になるデフォルトズームで開始し、
  // 「マップ」ボタンで全体表示(操作不可)へ切り替える。
  const cam = { s: 1, ox: 0, oy: 0 };
  let mapMode = false;
  const VIS_MIN_RATIO = 6; // 最大ズーム: 視界幅 = W/6
  const VIS_MAX_RATIO = 1 / 0.55; // 通常時の最小ズーム: 視界幅 = W*0.55

  function currentT() {
    return mapMode ? containFit() : containFit() * cam.s;
  }

  function clampCam() {
    const fit = containFit();
    if (fit <= 0) return;
    const sMin = canvas.width / (W * 0.55) / fit; // 視界幅がフィールドの55%より広くならない
    const sMax = Math.max(sMin, canvas.width / (W / VIS_MIN_RATIO) / fit);
    cam.s = Math.min(sMax, Math.max(sMin, cam.s));
    const T = containFit() * cam.s;
    const visW = canvas.width / T;
    const visH = canvas.height / T;
    cam.ox = visW >= W ? (W - visW) / 2 : Math.max(0, Math.min(W - visW, cam.ox));
    cam.oy = visH >= H ? (H - visH) / 2 : Math.max(0, Math.min(H - visH, cam.oy));
  }

  /** 自陣側(左)を中心に、視界幅=フィールドの約1/3で開始する */
  function setDefaultCamera() {
    syncCanvasSize();
    const fit = containFit();
    if (fit <= 0) return;
    // 視界幅=フィールドの1/3を基本に、レーン帯(高さ約300world px)が収まる範囲でズーム
    const T = Math.min(canvas.width / (W / 3), canvas.height / 300);
    cam.s = T / fit;
    const T2 = currentT();
    cam.ox = 0; // 自陣(ミラーリング後は常に左)から
    cam.oy = H * 0.72 - canvas.height / T2 / 2; // レーン帯を中央に
    clampCam();
  }

  function setMapMode(on) {
    mapMode = on;
    selectedPet = null;
    document.getElementById('b-lane-hint').classList.add('hidden');
    const btn = document.getElementById('btn-map');
    btn.textContent = on ? 'もどる' : 'マップ';
    document.getElementById('map-banner').classList.toggle('hidden', !on);
    if (state) renderHand();
  }

  function mirrored(x) {
    return ctxData.side === 1 ? LANE_LEN - x : x;
  }
  function sx(gameX) {
    return X0 + (mirrored(gameX) / LANE_LEN) * (X1 - X0);
  }

  function start(matchData, endCallback) {
    ctxData = matchData;
    petsById = Object.fromEntries(matchData.pets.map(p => [p.id, p]));
    state = matchData.state;
    Net.syncSeq(matchData.lastSeq);
    selectedPet = null;
    effects = [];
    projectiles = [];
    displayPos = {};
    handSig = '';
    handSlots = computeHandSlots();
    upgradeSig = '';
    setMapMode(false);
    setDefaultCamera(); // 自陣側にズームインした状態で開始
    onEnd = endCallback;
    running = true;
    renderHUD();
    requestAnimationFrame(loop);
  }

  function stop() {
    running = false;
  }

  function applyState(s) {
    state = s;
    renderHUD();
  }

  function applySnapshot(snap) {
    ctxData = snap;
    petsById = Object.fromEntries(snap.pets.map(p => [p.id, p]));
    Net.syncSeq(snap.lastSeq);
    state = snap.state;
    handSlots = computeHandSlots(); // 再接続後も並びは同じ(コスト順)
    handSig = '';
    renderHUD();
  }

  /** 施設・遠距離攻撃の弾道。world座標で保持し描画時に画面座標へ変換する */
  function addProjectile(fromX, fromYOffset, fromLane, toX, toLane) {
    projectiles.push({
      fromX, fromYOffset, fromLane, toX, toLane,
      start: performance.now(),
      dur: 220,
      impacted: false,
    });
  }

  function onEvent(ev) {
    const d = ev.data || {};
    const put = (name, x, lane, scale = 1) => effects.push({ name, x, lane, until: performance.now() + 500, scale });
    switch (ev.type) {
      case 'facility_attack': {
        // どの施設から撃たれたか分かるように弾道を描く(修正要望④)
        const fromX = d.from === 'main' ? (d.side === 0 ? 6 : 994) : d.side === 0 ? 100 : 900;
        const fromLane = d.from === 'main' ? null : d.from; // main は中央高さから
        addProjectile(fromX, d.from === 'main' ? -90 : -70, fromLane, d.x, d.lane);
        put('hit-small', fromX, fromLane || d.lane, 0.6); // 発射フラッシュ
        break;
      }
      case 'spawn': put('smoke-spawn', d.side === 0 ? 140 : 860, d.lane, 1.2); break;
      case 'attack': {
        // 遠距離ユニットの攻撃も発射元から弾道を描く
        const attacker = state && state.units.find(u => u.id === d.unitId);
        if (attacker && Math.abs(attacker.x - d.x) > 90) {
          addProjectile(attacker.x, -26, d.lane, d.x, d.lane);
        }
        put(d.area ? 'hit-big' : 'hit-small', d.x, d.lane, d.area ? 1.3 : 0.9);
        break;
      }
      case 'explosion': put('explosion', d.x, d.lane, 1.5); break;
      case 'heal': put('heal', d.x, d.lane); break;
      case 'stun': put('stun', d.x, d.lane, 0.8); break;
      case 'death': put('smoke-death', d.x, d.lane, 1); break;
      case 'facility_destroyed': {
        const x = d.key === 'main' ? (d.side === 0 ? 0 : LANE_LEN) : d.side === 0 ? 100 : 900;
        put('explosion', x, d.key === 'main' ? 'top' : d.key, 2);
        put('explosion', x, d.key === 'main' ? 'bottom' : d.key, 2);
        break;
      }
      case 'upgrade': {
        if (d.side === ctxData.side) {
          const name = d.key === 'pets'
            ? `${petsById[d.petId] ? petsById[d.petId].name : 'ペット'}強化`
            : { boneCapacity: 'ほね容量', boneSpeed: 'ほね回復', mainHouse: 'おうち強化' }[d.key];
          put('buff-atk', 140, 'top', 1.1);
          put('buff-atk', 140, 'bottom', 1.1);
          document.getElementById('b-phase').textContent = `${name} Lv${d.level}!`;
          setTimeout(() => {
            const el = document.getElementById('b-phase');
            if (el.textContent.startsWith(name)) el.textContent = state && state.phase === 'overtime' ? '延長戦! ほね回復2倍' : '';
          }, 1800);
        }
        break;
      }
      case 'overtime_start':
        document.getElementById('b-phase').textContent = '延長戦! ほね回復2倍';
        break;
    }
  }

  // ─── 描画ループ ───────────────────────────────────────────────
  function loop() {
    if (!running) return;
    draw();
    requestAnimationFrame(loop);
  }

  function draw() {
    syncCanvasSize();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#141020';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // カメラ(ズーム/パン)を適用して以降はワールド座標で描く。
    // マップ表示中は全体が収まる倍率で中央寄せ。
    let T, ox, oy;
    if (mapMode) {
      // 全体マップ: 左右は全幅を見せる。縦は空の余白ではなくレーン帯を中心に
      // 収める(上下の黒帯を最小にする)。
      T = canvas.width / W;
      ox = 0;
      const visH = canvas.height / T;
      oy = visH >= H ? (H - visH) / 2 : Math.max(0, Math.min(H - visH, H * 0.74 - visH / 2));
    } else {
      clampCam();
      T = currentT();
      ox = cam.ox;
      oy = cam.oy;
    }
    ctx.setTransform(T, 0, 0, T, -ox * T, -oy * T);
    if (bg.complete) ctx.drawImage(bg, 0, 0, W, H);
    if (!state) return;

    drawFacilities();
    drawPending();
    drawUnits();
    drawProjectiles();
    drawEffects();
  }

  function drawProjectiles() {
    const now = performance.now();
    for (const p of [...projectiles]) {
      const t = (now - p.start) / p.dur;
      if (t >= 1) {
        if (!p.impacted) {
          p.impacted = true;
          effects.push({ name: 'shot-impact', x: p.toX, lane: p.toLane, until: now + 350, scale: 0.8 });
        }
        projectiles.splice(projectiles.indexOf(p), 1);
        continue;
      }
      const x0 = sx(p.fromX);
      const y0 = (p.fromLane ? LANE_Y[p.fromLane] : H * 0.72) + p.fromYOffset;
      const x1 = sx(p.toX);
      const y1 = LANE_Y[p.toLane] - 24;
      const x = x0 + (x1 - x0) * t;
      // 放物線ぎみの軌道で視認性を上げる
      const y = y0 + (y1 - y0) * t - Math.sin(Math.PI * t) * 26;
      ctx.save();
      ctx.strokeStyle = 'rgba(255,220,120,0.55)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(x0 + (x1 - x0) * Math.max(0, t - 0.18), y0 + (y1 - y0) * Math.max(0, t - 0.18) - Math.sin(Math.PI * Math.max(0, t - 0.18)) * 26);
      ctx.lineTo(x, y);
      ctx.stroke();
      ctx.fillStyle = '#ffd964';
      ctx.strokeStyle = '#7a5200';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }

  function facilityColor(ownerSide) {
    return ownerSide === ctxData.side ? 'blue' : 'red';
  }

  function facState(f) {
    if (f.destroyed) return 'destroyed';
    return f.hp < f.maxHp * 0.5 ? 'damaged' : 'normal';
  }

  function drawFacilities() {
    for (let side = 0; side < 2; side++) {
      const fs = state.facilities[side];
      const color = facilityColor(side);
      for (const lane of ['top', 'bottom']) {
        const f = fs[lane];
        const x = sx(side === 0 ? 100 : 900);
        const y = LANE_Y[lane];
        const im = facImg('lane-house', facState(f), color);
        const size = 86;
        if (im.complete) ctx.drawImage(im, x - size / 2, y - size + 12, size, size);
        if (!f.destroyed) hpBar(x, y - size + 4, 60, f.hp / f.maxHp, color === 'blue' ? '#5aa9ff' : '#ff6b6b');
      }
      const main = fs.main;
      const mx = sx(side === 0 ? 6 : 994);
      const my = H * 0.72;
      const mim = facImg('main-house', facState(main), color);
      const msize = 120;
      if (mim.complete) ctx.drawImage(mim, mx - msize / 2, my - msize + 14, msize, msize);
    }
  }

  function drawPending() {
    for (const p of state.pending) {
      const x = sx(p.owner === 0 ? 140 : 860);
      const y = LANE_Y[p.lane];
      const im = fxImg('smoke-spawn');
      if (im.complete) {
        ctx.globalAlpha = 0.85;
        ctx.drawImage(im, x - 28, y - 52, 56, 56);
        ctx.globalAlpha = 1;
      }
    }
  }

  function animFrame(u, now) {
    const pet = petsById[u.petId];
    if (u.anim === 'death') return 'death';
    if (u.anim === 'stun') return 'hurt';
    if (u.anim === 'attack' || u.anim === 'attack_ready') {
      const t = (now / 1000) % Math.max(0.4, pet.attackInterval);
      const phase = t / Math.max(0.4, pet.attackInterval);
      return phase < 0.2 ? 'attack_1' : phase < 0.4 ? 'attack_2' : phase < 0.6 ? 'attack_3' : 'idle';
    }
    if (u.anim === 'walk') {
      const i = Math.floor(now / 140 + u.id * 3) % 4;
      return `walk_${i + 1}`;
    }
    return 'idle';
  }

  function drawUnits(now = performance.now()) {
    const sorted = [...state.units].sort((a, b) => (a.lane === b.lane ? 0 : a.lane === 'top' ? -1 : 1));
    for (const u of sorted) {
      // 位置補間(サーバー10Hz → 表示は滑らかに追従)
      const target = u.x;
      const cur = displayPos[u.id] ?? target;
      displayPos[u.id] = cur + (target - cur) * 0.35;
      const x = sx(displayPos[u.id]);
      const y = LANE_Y[u.lane] - (u.flying ? 46 : 0);
      const pet = petsById[u.petId];
      const size = 30 + Math.min(34, (pet.collisionRadius || 16) * 1.3);

      const im = petImg(u.petId, animFrame(u, now));
      const faceRight = (u.owner === 0) !== (ctxData.side === 1);
      ctx.save();
      ctx.translate(x, y);
      if (!faceRight) ctx.scale(-1, 1);
      if (u.anim === 'death') ctx.globalAlpha = 0.7;
      if (im.complete && im.naturalWidth) ctx.drawImage(im, -size / 2, -size, size, size);
      ctx.restore();

      if (u.anim !== 'death') {
        const mine = u.owner === ctxData.side;
        hpBar(x, y - size - 6, 34, u.hp / u.maxHp, mine ? '#6fdc8c' : '#ff6b6b');
      }
      if (u.flying) {
        ctx.globalAlpha = 0.25;
        ctx.beginPath();
        ctx.ellipse(x, LANE_Y[u.lane] - 4, 14, 4, 0, 0, Math.PI * 2);
        ctx.fillStyle = '#000';
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
  }

  function hpBar(x, y, w, ratio, color) {
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(x - w / 2, y, w, 5);
    ctx.fillStyle = color;
    ctx.fillRect(x - w / 2, y, w * Math.max(0, Math.min(1, ratio)), 5);
  }

  function drawEffects() {
    const now = performance.now();
    effects = effects.filter(e => e.until > now);
    for (const e of effects) {
      const im = fxImg(e.name);
      if (!im.complete) continue;
      const x = sx(e.x);
      const y = LANE_Y[e.lane] - 30;
      const s = 44 * (e.scale || 1);
      const alpha = Math.min(1, (e.until - now) / 300);
      ctx.globalAlpha = alpha;
      ctx.drawImage(im, x - s / 2, y - s / 2, s, s);
      ctx.globalAlpha = 1;
    }
  }

  // ─── HUD(DOM) ────────────────────────────────────────────────
  function renderHUD() {
    if (!state || !ctxData) return;
    const rules = ctxData.rules;
    const total = rules.normalTimeSec + (state.phase === 'overtime' ? rules.overtimeSec : 0);
    const remain = Math.max(0, (state.phase === 'overtime' ? rules.normalTimeSec + rules.overtimeSec : rules.normalTimeSec) - state.t);
    const mm = Math.floor(remain / 60);
    const ss = String(Math.floor(remain % 60)).padStart(2, '0');
    document.getElementById('b-timer').textContent = `${mm}:${ss}`;
    if (state.phase !== 'overtime') document.getElementById('b-phase').textContent = '';

    const mySide = ctxData.side;
    const renderPlayer = (el, side, label) => {
      const f = state.facilities[side];
      const name = side === mySide ? ctxData.you.name : ctxData.opponent.name;
      el.innerHTML = `<span>${esc(name)} <small>P${state.points[side]}</small></span>
        <div class="hpbar"><div style="width:${(f.main.hp / f.main.maxHp) * 100}%"></div></div>`;
    };
    const meEl = document.getElementById('b-me');
    const oppEl = document.getElementById('b-opp');
    meEl.className = 'b-player me';
    oppEl.className = 'b-player opp';
    renderPlayer(meEl, mySide);
    renderPlayer(oppEl, 1 - mySide);

    // ほね(強化で最大値が増える)
    const gauge = document.getElementById('bone-gauge');
    const boneMax = state.boneMax || rules.bone.max;
    if (gauge.children.length !== boneMax) {
      gauge.innerHTML = Array.from({ length: boneMax }, () => '<span></span>').join('');
    }
    const bone = Math.floor(state.bone);
    [...gauge.children].forEach((el2, i) => el2.classList.toggle('full', i < bone));
    document.getElementById('bone-num').textContent = `${bone}/${boneMax}`;

    renderHand();

    renderUpgrades();
    document.getElementById('next-pet').innerHTML = `控え: ${state.reserveCount}体`;

    // 相手の通信状態
    const oppConnected = state.connection[1 - mySide];
    const banner = document.getElementById('b-conn');
    banner.classList.toggle('hidden', oppConnected);
    if (!oppConnected) banner.textContent = '相手の通信が切断されています…';
  }

  /**
   * カードの並び順。デッキ全体を**コストの安い順に固定**する
   * (同コストは名前順→ID順で毎回同じ並びになるようにする)。
   * 手札は出撃するたびに控えと入れ替わるため、手札の配列順で描くと
   * カードの位置が動いて隣のペットを押してしまう(修正要望③)。
   */
  function computeHandSlots() {
    const deck = (ctxData && ctxData.hand && ctxData.hand.deck) || [];
    return [...deck].filter(id => petsById[id]).sort((a, b) => {
      const pa = petsById[a];
      const pb = petsById[b];
      return pa.cost - pb.cost || pa.name.localeCompare(pb.name, 'ja') || (a < b ? -1 : 1);
    });
  }

  /**
   * 手札の描画。枠はデッキ全体・コスト順で固定し、出せない理由
   * (クールダウン / 控え / ほね不足)を枠の上に重ねて表すため、位置は動かない。
   * 構成が変わったときだけDOMを作り直す。毎状態受信(10Hz)で innerHTML を
   * 作り直すとクリック中のノードが差し替わり、PCで「クリックしても
   * レーン選択にならない」バグになる(修正要望②)。
   */
  function renderHand() {
    if (!state) return;
    const handEl = document.getElementById('hand');
    const slotState = petId => {
      const inHand = state.hand.includes(petId);
      const cd = state.cooldowns[petId];
      return { inHand, cd, affordable: inHand && state.bone >= petsById[petId].cost };
    };
    const sig = handSlots.map(id => {
      const s = slotState(id);
      const upCost = state.petUpgradeCosts?.[id] ?? 'x';
      return `${id}:${s.inHand ? 'h' : s.cd != null ? 'c' : 'r'}${s.affordable ? 1 : 0}`
        + `:${state.upgrades?.pets?.[id] || 0}:${upCost}:${state.bone >= (upCost === 'x' ? Infinity : upCost) ? 1 : 0}`;
    }).join(',') + `|${selectedPet}|${mapMode}`;
    if (sig === handSig) {
      // CDの残り秒数だけその場で更新
      handEl.querySelectorAll('[data-cdpet]').forEach(el => {
        const cd = state.cooldowns[el.dataset.cdpet];
        if (cd != null) el.textContent = Math.ceil(cd);
      });
      return;
    }
    handSig = sig;
    // 8体デッキでは横スクロールになる。作り直しで先頭へ戻ると
    // 「位置が動く」のと同じ体験になるため、スクロール位置は保つ
    const scrollLeft = handEl.scrollLeft;
    handEl.innerHTML = '';
    for (const petId of handSlots) {
      const pet = petsById[petId];
      const { inHand, cd, affordable } = slotState(petId);
      const card = document.createElement('div');
      card.className = 'hand-card' + (affordable ? '' : ' disabled') + (selectedPet === petId ? ' selected' : '');
      if (inHand) card.dataset.pet = petId; // 出撃できるのは手札にあるカードだけ
      const lv = state.upgrades?.pets?.[petId] || 0;
      const upCost = state.petUpgradeCosts?.[petId];
      // クールダウン中は残り秒、控えは「控え」を重ねる(枠自体は消さない)
      const mask = cd != null ? `<div class="cdmask" data-cdpet="${petId}">${Math.ceil(cd)}</div>`
        : !inHand ? '<div class="cdmask wait">控え</div>' : '';
      card.innerHTML = `<span class="pcost">${pet.cost}</span>
        ${lv > 0 ? `<span class="plv">Lv${lv}</span>` : ''}
        <img src="/assets/pets/${petId}/icon.png" alt="${esc(pet.name)}" draggable="false">
        <small>${esc(pet.name)}</small>
        ${mask}
        <button class="pet-up" data-uppet="${petId}" ${upCost == null || state.bone < upCost || mapMode ? 'disabled' : ''}>${upCost == null ? 'MAX' : `強化 🦴${upCost}`}</button>`;
      handEl.appendChild(card);
    }
    handEl.scrollLeft = scrollLeft;
  }

  /**
   * 試合内レベルアップ(ほね消費)。効果はこの試合の間だけで、
   * 試合が終わればリセットされる(永続的な育成差は生じない)。
   */
  const UPGRADES = [
    { key: 'boneCapacity', label: 'ほね容量' },
    { key: 'boneSpeed', label: 'ほね回復' },
    { key: 'mainHouse', label: 'おうち強化' },
  ];

  function renderUpgrades() {
    const row = document.getElementById('upgrade-row');
    if (!state || !state.upgradeCosts) {
      row.innerHTML = '';
      return;
    }
    const eff = state.upgradeEffects || {};
    const sig = UPGRADES.map(u => `${state.upgrades[u.key]}:${state.upgradeCosts[u.key]}:${state.bone >= (state.upgradeCosts[u.key] ?? Infinity) ? 1 : 0}`).join('|') + `|${mapMode}|${JSON.stringify(eff)}`;
    if (sig === upgradeSig) return;
    upgradeSig = sig;
    row.innerHTML = '';
    for (const u of UPGRADES) {
      const level = state.upgrades[u.key];
      const cost = state.upgradeCosts[u.key];
      const maxed = cost == null;
      const affordable = !maxed && state.bone >= cost;
      const btn = document.createElement('button');
      btn.className = 'up-btn' + (affordable && !mapMode ? ' ready' : '');
      btn.disabled = maxed || !affordable || mapMode;
      const effText = {
        boneCapacity: `上限${eff.boneCapacity ?? '-'}`,
        boneSpeed: `${eff.boneSpeedSec ?? '-'}秒/個`,
        mainHouse: `+${eff.mainHousePercent ?? 0}%`,
      }[u.key];
      btn.innerHTML = `<b>${u.label}</b>
        <span class="up-lv">Lv${level}</span>
        <span class="up-eff">${effText}</span>
        <span class="up-cost">${maxed ? 'MAX' : `🦴${cost}`}</span>`;
      btn.onclick = () => {
        if (mapMode) return;
        Net.sendOp({ type: 'upgrade', key: u.key });
      };
      row.appendChild(btn);
    }
  }

  function handleCardTap(card, target) {
    if (!card || !state || !running || mapMode) return; // マップ表示中は操作不可
    const upBtn = target && target.closest ? target.closest('.pet-up') : null;
    if (upBtn) {
      if (!upBtn.disabled) Net.sendOp({ type: 'upgrade', key: 'pets', petId: upBtn.dataset.uppet });
      return;
    }
    const petId = card.dataset.pet;
    if (!petId) return; // クールダウン中カード
    if (state.bone < petsById[petId].cost) {
      card.classList.add('shake');
      setTimeout(() => card.classList.remove('shake'), 350);
      return;
    }
    selectedPet = selectedPet === petId ? null : petId;
    document.getElementById('b-lane-hint').classList.toggle('hidden', !selectedPet);
    renderHand();
  }

  // マウスは pointerdown で即反応(再描画レースを回避)、タッチは click(スクロールと区別)
  {
    const handEl = document.getElementById('hand');
    let lastPointerType = 'mouse';
    handEl.addEventListener('pointerdown', e => {
      lastPointerType = e.pointerType;
      if (e.pointerType === 'mouse') {
        handleCardTap(e.target.closest('.hand-card'), e.target);
        e.preventDefault();
      }
    });
    handEl.addEventListener('click', e => {
      if (lastPointerType !== 'mouse') handleCardTap(e.target.closest('.hand-card'), e.target);
    });
  }

  // ─── カメラ操作: ホイールズーム / ドラッグパン / ピンチズーム(修正要望①) ──
  {
    const pointers = new Map();
    /** イベント位置 → canvas ピクセル座標 */
    function canvasPos(e) {
      const rect = canvas.getBoundingClientRect();
      return {
        x: (e.clientX - rect.left) * (canvas.width / rect.width),
        y: (e.clientY - rect.top) * (canvas.height / rect.height),
      };
    }
    function zoomAt(p, factor) {
      const T0 = currentT();
      const wx = p.x / T0 + cam.ox;
      const wy = p.y / T0 + cam.oy;
      cam.s *= factor;
      clampCam();
      const T1 = currentT();
      cam.ox = wx - p.x / T1;
      cam.oy = wy - p.y / T1;
      clampCam();
    }
    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      if (mapMode) return;
      zoomAt(canvasPos(e), Math.exp(-e.deltaY * 0.0015));
    }, { passive: false });
    canvas.addEventListener('pointerdown', e => {
      if (mapMode) return;
      pointers.set(e.pointerId, canvasPos(e));
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', e => {
      if (!pointers.has(e.pointerId)) return;
      const prev = pointers.get(e.pointerId);
      const cur = canvasPos(e);
      if (pointers.size === 1) {
        const T = currentT();
        cam.ox -= (cur.x - prev.x) / T;
        cam.oy -= (cur.y - prev.y) / T;
        clampCam();
        pointers.set(e.pointerId, cur);
      } else if (pointers.size === 2) {
        const otherId = [...pointers.keys()].find(id => id !== e.pointerId);
        const other = pointers.get(otherId);
        const d0 = Math.hypot(prev.x - other.x, prev.y - other.y);
        pointers.set(e.pointerId, cur);
        const d1 = Math.hypot(cur.x - other.x, cur.y - other.y);
        if (d0 > 4) {
          zoomAt({ x: (cur.x + other.x) / 2, y: (cur.y + other.y) / 2 }, d1 / d0);
        }
      }
    });
    for (const t of ['pointerup', 'pointercancel', 'pointerleave']) {
      canvas.addEventListener(t, e => pointers.delete(e.pointerId));
    }
    canvas.addEventListener('dblclick', () => {
      if (!mapMode) setDefaultCamera();
    });
    document.getElementById('btn-map').addEventListener('click', () => setMapMode(!mapMode));
  }

  function trySpawn(lane) {
    if (!selectedPet || mapMode) return;
    Net.sendOp({ type: 'spawn', petId: selectedPet, lane });
    selectedPet = null;
    document.getElementById('b-lane-hint').classList.add('hidden');
    renderHUD();
  }

  document.getElementById('b-lane-hint').addEventListener('click', e => {
    const lane = e.target.dataset.lane;
    if (lane) trySpawn(lane);
  });
  // キーボード: 1〜8(画面のカードと同じコスト順)で選択、W/↑=上、S/↓=下
  document.addEventListener('keydown', e => {
    if (!running || !state || mapMode) return;
    if (/^[1-8]$/.test(e.key)) {
      const petId = handSlots[Number(e.key) - 1];
      if (petId && state.hand.includes(petId) && state.bone >= petsById[petId].cost) {
        selectedPet = petId;
        document.getElementById('b-lane-hint').classList.remove('hidden');
        renderHUD();
      }
    }
    if (e.key === 'w' || e.key === 'ArrowUp') trySpawn('top');
    if (e.key === 's' || e.key === 'ArrowDown') trySpawn('bottom');
  });

  document.getElementById('btn-surrender').onclick = () => {
    if (confirm('降参しますか?')) Net.sendOp({ type: 'surrender' });
  };

  function showResult(msg) {
    stop();
    const overlay = document.getElementById('result-overlay');
    const body = document.getElementById('result-body');
    const title = msg.result === 'draw' ? '引き分け' : msg.youWon ? '勝利!' : '敗北…';
    const cls = msg.result === 'draw' ? 'draw' : msg.youWon ? 'win' : 'lose';
    const reasons = {
      main_destroyed: 'メインハウス破壊', surrender: '降参', disconnect: '切断',
      tiebreak_lanehouses: '判定: レーンハウス破壊数', tiebreak_damage: '判定: 総ダメージ',
      tiebreak_mainhp: '判定: メインハウス残HP', tiebreak_draw: '完全同値',
    };
    const r = msg.rewards;
    body.innerHTML = `
      <div class="result-title ${cls}">${title}</div>
      <p style="text-align:center;opacity:.8">${reasons[msg.reason] || msg.reason} ／ ポイント ${msg.points[ctxData.side]} - ${msg.points[1 - ctxData.side]}</p>
      ${r ? `
      <div class="reward-row"><span>経験値</span><span>+${r.xp}</span></div>
      <div class="reward-row"><span>コイン</span><span>+${r.coins}</span></div>
      <div class="reward-row"><span>レート</span><span>${r.ratingBefore} → ${r.ratingAfter}</span></div>
      ${r.levelUps ? `<div class="reward-row"><span>レベルアップ!</span><span>Lv${r.level}</span></div>` : ''}` : msg.practice ? '<p style="text-align:center;opacity:.8">練習試合(報酬・レート変動なし)</p>' : '<p>無効試合(報酬なし)</p>'}
      <button class="btn primary big" id="btn-result-home" style="margin-top:14px">ホームへ</button>`;
    overlay.classList.remove('hidden');
    document.getElementById('btn-result-home').onclick = () => {
      overlay.classList.add('hidden');
      if (onEnd) onEnd();
    };
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  return { start, stop, applyState, applySnapshot, onEvent, showResult };
})();
