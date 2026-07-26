/**
 * 管理画面: バランス版(編集・アビリティ・予約・入出力) / アカウント運用 /
 * 試合調査 / 分析(KPI・ペット・ガチャ・売上) / 稼働状況 / 監査ログ。
 *
 * 表示するバランス値はすべて編集中スナップショットの実データ。
 * 危険操作はサーバー側で理由必須のため、理由欄を送る。
 */
(() => {
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = v => (v == null ? '' : Number(v).toLocaleString('ja-JP'));

  let editingId = null;
  let editingSnapshot = null;
  let publishedId = null;
  let versions = [];
  let dirty = false;
  let abilityCatalog = [];
  let selectedPetId = null;
  let selectedUserId = null;
  let auditOffset = 0;

  const reason = () => $('draft-reason').value.trim();

  /**
   * 認証つきのダウンロード。トークンはURLに載せない(ログに残るため)ので、
   * ヘッダー付き fetch → Blob 経由で保存する。
   */
  async function download(path, filename) {
    const res = await fetch(`/api${path}`, { headers: { Authorization: `Bearer ${Net.token}` } });
    if (!res.ok) { alert(`ダウンロードに失敗しました: HTTP ${res.status}`); return; }
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }
  const setDirty = v => { dirty = v; $('edit-dirty').textContent = v ? '● 未保存の変更があります' : ''; };
  const msg = (html, cls = '') => { $('edit-msg').innerHTML = cls ? `<span class="${cls}">${html}</span>` : html; };

  window.addEventListener('beforeunload', e => {
    if (dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  // ─── タブ ───────────────────────────────────────────────────
  document.querySelectorAll('[data-tab]').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.pane').forEach(p => p.classList.toggle('active', p.id === `pane-${btn.dataset.tab}`));
      if (btn.dataset.tab === 'stats') void loadStats();
      if (btn.dataset.tab === 'live') void loadLive();
      if (btn.dataset.tab === 'audit') void loadAudit(true);
      if (btn.dataset.tab === 'matches') void loadMatches();
    };
  });

  async function boot() {
    try {
      const res = await Net.api('/me');
      if (!res.user.is_admin) throw new Error('管理者ではありません');
      $('admin-user').textContent = `${res.user.name}(管理者)`;
      $('admin-login-card').classList.add('hidden');
      $('admin-main').classList.remove('hidden');
      abilityCatalog = (await Net.api('/admin/ability-types')).abilities;
      await Promise.all([loadVersions(), loadUsers(), loadAudit(true)]);
    } catch {
      $('admin-login-card').classList.remove('hidden');
      $('admin-main').classList.add('hidden');
    }
  }

  $('a-login').onclick = async () => {
    $('a-error').textContent = '';
    try {
      const res = await Net.api('/login', { body: { name: $('a-name').value.trim(), password: $('a-pass').value } });
      Net.setToken(res.token);
      await boot();
    } catch (e) {
      $('a-error').textContent = e.message;
    }
  };

  /** 危険操作の共通ラッパー(理由必須をUI側でも案内する) */
  async function withReason(fn) {
    if (!reason()) {
      msg('変更理由を入力してください(監査ログに残ります)', 'error');
      $('draft-reason').focus();
      return;
    }
    try {
      await fn(reason());
    } catch (e) {
      msg(esc(e.message), 'error');
    }
  }

  // ─── バランス: 版一覧 ─────────────────────────────────────────
  async function loadVersions() {
    const res = await Net.api('/admin/versions');
    versions = res.versions;
    publishedId = res.publishedId;
    const rows = versions.map(v => `
      <tr>
        <td>#${v.id}</td>
        <td><span class="badge ${v.status}">${v.status}</span>${v.id === publishedId ? ' <b>現行</b>' : ''}</td>
        <td><input data-label="${v.id}" value="${esc(v.label)}" style="width:150px"></td>
        <td>${esc(v.created_by_name || '')}</td>
        <td>${esc(v.created_at)}</td>
        <td>${esc(v.published_at || '')}</td>
        <td>${esc(v.scheduled_at ? new Date(v.scheduled_at).toLocaleString('ja-JP') : '')}</td>
        <td class="row">
          ${['draft', 'testing', 'scheduled'].includes(v.status) ? `<button class="btn small" data-edit="${v.id}">編集</button>` : ''}
          ${v.status === 'scheduled' ? `<button class="btn small" data-unschedule="${v.id}">予約取消</button>` : ''}
          <button class="btn small" data-export="${v.id}">JSON</button>
          <button class="btn small" data-copy="${v.id}">複製</button>
          ${['archived', 'rolled_back'].includes(v.status) ? `<button class="btn small" data-rollback="${v.id}">この版へ戻す</button>` : ''}
          ${['draft', 'testing', 'scheduled'].includes(v.status) ? `<button class="btn small" data-del="${v.id}">削除</button>` : ''}
        </td>
      </tr>`).join('');
    $('version-table').innerHTML =
      `<tr><th>版</th><th>状態</th><th>ラベル</th><th>作成者</th><th>作成</th><th>公開</th><th>予約</th><th>操作</th></tr>${rows}`;

    const t = $('version-table');
    t.querySelectorAll('[data-edit]').forEach(b => (b.onclick = () => openEditor(Number(b.dataset.edit))));
    t.querySelectorAll('[data-export]').forEach(b => (b.onclick = () =>
      download(`/admin/versions/${b.dataset.export}/export`, `wanwan-balance-v${b.dataset.export}.json`)));
    t.querySelectorAll('[data-copy]').forEach(b => (b.onclick = async () => {
      const res2 = await Net.api('/admin/versions/draft', { body: { baseId: Number(b.dataset.copy), label: $('draft-label').value.trim(), reason: reason() } });
      await loadVersions();
      openEditor(res2.id);
    }));
    t.querySelectorAll('[data-rollback]').forEach(b => (b.onclick = () => withReason(async r => {
      if (!confirm(`版#${b.dataset.rollback} の内容へロールバックしますか?`)) return;
      await Net.api(`/admin/versions/${b.dataset.rollback}/rollback`, { body: { reason: r } });
      await loadVersions();
      await loadAudit(true);
    })));
    t.querySelectorAll('[data-unschedule]').forEach(b => (b.onclick = () => withReason(async r => {
      await Net.api(`/admin/versions/${b.dataset.unschedule}/schedule/cancel`, { body: { reason: r } });
      await loadVersions();
    })));
    t.querySelectorAll('[data-del]').forEach(b => (b.onclick = () => withReason(async r => {
      if (!confirm(`版#${b.dataset.del} を削除しますか?`)) return;
      await Net.api(`/admin/versions/${b.dataset.del}`, { method: 'DELETE', body: { reason: r } });
      if (editingId === Number(b.dataset.del)) { $('editor-card').classList.add('hidden'); editingId = null; }
      await loadVersions();
    })));
    t.querySelectorAll('[data-label]').forEach(inp => (inp.onchange = async () => {
      await Net.api(`/admin/versions/${inp.dataset.label}/label`, { method: 'PATCH', body: { label: inp.value } });
      await loadVersions();
    }));

    // 版セレクト(比較先・分析・試合フィルタ)
    const opts = versions.map(v => `<option value="${v.id}">#${v.id} ${esc(v.label || v.status)}</option>`).join('');
    $('diff-target').innerHTML = opts;
    $('diff-target').value = String(publishedId);
    for (const id of ['m-version', 's-version']) {
      const cur = $(id).value;
      $(id).innerHTML = `<option value="">全バランス版</option>${opts}`;
      $(id).value = cur;
    }
  }

  $('btn-new-draft').onclick = async () => {
    const res = await Net.api('/admin/versions/draft', { body: { label: $('draft-label').value.trim(), reason: reason() } });
    await loadVersions();
    openEditor(res.id);
  };

  $('btn-import').onclick = () => $('import-file').click();
  $('import-file').onchange = async () => {
    const file = $('import-file').files[0];
    if (!file) return;
    if (!reason()) { alert('変更理由を入力してください'); return; }
    try {
      const snapshot = JSON.parse(await file.text());
      const res = await Net.api('/admin/versions/import', { body: { snapshot, label: $('draft-label').value.trim() || file.name, reason: reason() } });
      if (!res.ok) { alert(`取り込めません:\n${res.errors.join('\n')}`); return; }
      await loadVersions();
      openEditor(res.id);
    } catch (e) {
      alert(`取り込みに失敗しました: ${e.message}`);
    } finally {
      $('import-file').value = '';
    }
  };

  // ─── バランス: エディタ ───────────────────────────────────────
  async function openEditor(id) {
    if (dirty && !confirm('未保存の変更があります。破棄して別の版を開きますか?')) return;
    const v = await Net.api(`/admin/versions/${id}`);
    editingId = id;
    editingSnapshot = v.snapshot;
    selectedPetId = editingSnapshot.pets[0]?.id || null;
    $('edit-vid').textContent = `#${id}(${v.status})`;
    $('editor-card').classList.remove('hidden');
    $('diff-box').classList.add('hidden');
    setDirty(false);
    msg('');
    renderAllFields();
    renderPetList();
    renderPetDetail();
    $('editor-card').scrollIntoView({ behavior: 'smooth' });
  }

  /** path 指定で編集中スナップショットを読み書きする */
  const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
  function setPath(obj, path, value) {
    const keys = path.split('.');
    const last = keys.pop();
    const target = keys.reduce((o, k) => (o[k] = o[k] || {}), obj);
    target[last] = value;
  }

  const N = (path, label, step = 'any') => ({ path, label, type: 'number', step });
  const S = (path, label, options) => ({ path, label, type: 'select', options });

  /** 編集できる値の定義(コードに値は持たず、パスとラベルだけを持つ) */
  const SECTIONS = {
    'f-rules': () => [
      N('rules.normalTimeSec', '通常時間(秒)'), N('rules.overtimeSec', '延長(秒)'),
      N('rules.bone.start', 'ほね開始'), N('rules.bone.max', 'ほね最大'),
      N('rules.bone.regenSec', '回復間隔(秒)'), N('rules.bone.overtimeMultiplier', '延長倍率'),
      N('rules.hand.size', '手札'), N('rules.deck.min', 'デッキ最小'), N('rules.deck.max', 'デッキ最大'),
      N('rules.unitCaps.totalPerPlayer', '出撃上限'), N('rules.unitCaps.perLane', 'レーン上限'),
      N('rules.disconnect.graceSec', '切断猶予(秒)'), N('rules.disconnect.lossSec', '切断敗北(秒)'),
      N('rules.spawnDelayByWeight.light', '出撃遅延: 軽'), N('rules.spawnDelayByWeight.medium', '出撃遅延: 中'),
      N('rules.spawnDelayByWeight.heavy', '出撃遅延: 重'),
    ],
    'f-facilities': () => [
      N('facilities.laneHouse.hp', 'レーンHP'), N('facilities.laneHouse.attackPower', 'レーン攻撃'),
      N('facilities.laneHouse.attackRange', 'レーン射程'), N('facilities.laneHouse.attackInterval', 'レーン攻撃間隔'),
      N('facilities.laneHouse.point', 'レーン破壊ポイント'),
      N('facilities.mainHouse.hp', 'メインHP'), N('facilities.mainHouse.attackPower', 'メイン攻撃'),
      N('facilities.mainHouse.attackRange', 'メイン射程'), N('facilities.mainHouse.attackInterval', 'メイン攻撃間隔'),
    ],
    'f-progression': () => [
      N('progression.initialCoins', '初期コイン'),
      N('progression.xp.win', '勝利XP'), N('progression.xp.lose', '敗北XP'), N('progression.xp.draw', '引分XP'),
      N('progression.coins.win', '勝利コイン'), N('progression.coins.lose', '敗北コイン'), N('progression.coins.draw', '引分コイン'),
      N('progression.levelXp.base', 'Lv必要XP(基礎)'), N('progression.levelXp.perLevel', 'Lv必要XP(増分)'),
    ],
    'f-matchmaking': () => [
      N('matchmaking.initialRating', '初期レート'), N('matchmaking.eloK', 'Elo K'),
      N('matchmaking.ratingWindowStart', 'レート許容差'), N('matchmaking.ratingWindowGrowPer5Sec', '5秒ごとの拡大'),
      N('matchmaking.newbieMatchCount', '初心者保護(試合数)'),
    ],
    'f-gacha': () => {
      const f = [
        N('gacha.singleCost', '単発コスト'), N('gacha.multiCount', 'まとめ引き回数'), N('gacha.multiCost', 'まとめ引きコスト'),
        S('gacha.multiGuaranteeRarity', '確定レアリティ', (editingSnapshot.gacha?.rarities || []).map(r => r.id)),
      ];
      (editingSnapshot.gacha?.rarities || []).forEach((r, i) => {
        f.push(N(`gacha.rarities.${i}.weight`, `${r.id}: 排出重み`), N(`gacha.rarities.${i}.duplicateCoins`, `${r.id}: 重複コイン`));
      });
      return f;
    },
    'f-upgrades': () => {
      const f = [];
      const labels = { boneCapacity: 'ほね容量', boneSpeed: 'ほね回復', pets: 'ペット強化', mainHouse: 'おうち強化' };
      for (const [key, label] of Object.entries(labels)) {
        const conf = editingSnapshot.upgrades?.[key];
        if (!conf) continue;
        for (const k of Object.keys(conf)) f.push(N(`upgrades.${key}.${k}`, `${label}: ${k}`));
      }
      return f;
    },
  };

  function renderAllFields() {
    for (const [boxId, build] of Object.entries(SECTIONS)) {
      const box = $(boxId);
      box.innerHTML = '';
      for (const f of build()) {
        const wrap = document.createElement('label');
        wrap.textContent = f.label;
        let input;
        if (f.type === 'select') {
          input = document.createElement('select');
          input.innerHTML = f.options.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('');
          input.value = getPath(editingSnapshot, f.path) ?? '';
          input.onchange = () => { setPath(editingSnapshot, f.path, input.value); setDirty(true); };
        } else {
          input = document.createElement('input');
          input.type = 'number';
          input.step = f.step;
          input.value = getPath(editingSnapshot, f.path) ?? 0;
          input.onchange = () => { setPath(editingSnapshot, f.path, Number(input.value)); setDirty(true); };
        }
        wrap.appendChild(input);
        box.appendChild(wrap);
      }
    }
  }

  // ペット編集
  const PET_NUM = [
    ['cost', 'コスト'], ['hp', 'HP'], ['attackPower', '攻撃力'], ['attackInterval', '攻撃間隔'],
    ['attackRange', '射程'], ['moveSpeed', '速度'], ['spawnDelay', '出撃遅延'], ['rechargeSec', '再使用'],
    ['collisionRadius', '当たり半径'], ['knockbackCount', 'KB回数'], ['areaRadius', '範囲半径'],
    ['buildingAttackPower', '対施設攻撃力'], ['buildingDamageRatio', '対施設倍率'], ['healPower', '回復量'],
    ['spawnCount', '出撃数'], ['spawnStun', '出撃硬直'],
  ];
  const PET_SEL = [
    ['rarity', 'レアリティ', () => (editingSnapshot.gacha?.rarities || []).map(r => r.id)],
    ['attackType', '攻撃種別', () => ['single', 'area', 'areaSmall', 'heal']],
    ['targetType', '対象', () => ['all', 'buildings', 'allies']],
    ['movement', '移動', () => ['ground', 'flying']],
    ['weightClass', '重さ', () => ['light', 'medium', 'heavy']],
  ];

  function renderPetList() {
    const box = $('pet-list');
    box.innerHTML = '';
    for (const p of editingSnapshot.pets) {
      const b = document.createElement('button');
      b.className = 'btn small' + (p.id === selectedPetId ? ' sel' : '');
      b.textContent = `${p.released === false ? '(非公開) ' : ''}${p.name || p.id}`;
      b.onclick = () => { selectedPetId = p.id; renderPetList(); renderPetDetail(); };
      box.appendChild(b);
    }
  }

  function renderPetDetail() {
    const box = $('pet-detail');
    const pet = editingSnapshot.pets.find(p => p.id === selectedPetId);
    if (!pet) { box.innerHTML = '<p class="muted">ペットを選択してください</p>'; return; }
    box.innerHTML = '<div class="fields" id="pet-fields"></div><h3>アビリティ</h3><div id="pet-abilities"></div>';
    const fields = $('pet-fields');

    const addText = (key, label, wide = false) => {
      const wrap = document.createElement('label');
      wrap.textContent = label;
      const input = document.createElement('input');
      if (wide) input.className = 'wide';
      input.value = pet[key] ?? '';
      input.onchange = () => { pet[key] = input.value; setDirty(true); if (key === 'name') renderPetList(); };
      wrap.appendChild(input);
      fields.appendChild(wrap);
    };
    addText('id', 'ID(素材フォルダ名)');
    addText('name', '名前');
    addText('role', 'ロール');
    addText('description', '説明', true);

    for (const [key, label] of PET_NUM) {
      const wrap = document.createElement('label');
      wrap.textContent = label;
      const input = document.createElement('input');
      input.type = 'number';
      input.step = 'any';
      input.value = pet[key] ?? '';
      input.placeholder = '未設定';
      input.onchange = () => {
        if (input.value === '') delete pet[key];
        else pet[key] = Number(input.value);
        setDirty(true);
      };
      wrap.appendChild(input);
      fields.appendChild(wrap);
    }
    for (const [key, label, opts] of PET_SEL) {
      const wrap = document.createElement('label');
      wrap.textContent = label;
      const sel = document.createElement('select');
      sel.innerHTML = ['', ...opts()].map(o => `<option value="${esc(o)}">${o || '(未設定)'}</option>`).join('');
      sel.value = pet[key] ?? '';
      sel.onchange = () => { if (sel.value === '') delete pet[key]; else pet[key] = sel.value; setDirty(true); };
      wrap.appendChild(sel);
      fields.appendChild(wrap);
    }
    const relWrap = document.createElement('label');
    relWrap.textContent = '公開(released)';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = pet.released !== false;
    cb.onchange = () => { pet.released = cb.checked; setDirty(true); renderPetList(); };
    relWrap.appendChild(cb);
    fields.appendChild(relWrap);

    renderAbilities(pet);
  }

  function renderAbilities(pet) {
    const box = $('pet-abilities');
    box.innerHTML = '';
    pet.abilities = pet.abilities || [];
    pet.abilities.forEach((ab, i) => {
      const def = abilityCatalog.find(a => a.type === ab.type);
      const card = document.createElement('div');
      card.className = 'ability-card';
      card.innerHTML = `<div class="row"><b>${esc(def ? def.label : ab.type)}</b>
        <span class="muted">${esc(def ? `${def.trigger} → ${def.target}` : '未実装の型')}</span>
        <button class="btn small" data-rm="${i}" style="margin-left:auto">削除</button></div>
        <p class="terms">${esc(def?.desc || '')}</p>
        <div class="fields" data-params="${i}"></div>`;
      box.appendChild(card);
      const params = card.querySelector(`[data-params="${i}"]`);
      for (const p of def?.params || []) {
        const wrap = document.createElement('label');
        wrap.textContent = `${p.label}${p.unit ? ` ${p.unit}` : ''}`;
        const input = document.createElement('input');
        if (p.type === 'boolean') {
          input.type = 'checkbox';
          input.checked = !!ab[p.key];
          input.onchange = () => { ab[p.key] = input.checked; setDirty(true); };
        } else {
          input.type = 'number';
          input.step = p.step;
          input.value = ab[p.key] ?? p.def;
          input.onchange = () => { ab[p.key] = Number(input.value); setDirty(true); };
        }
        wrap.appendChild(input);
        params.appendChild(wrap);
      }
      card.querySelector('[data-rm]').onclick = () => { pet.abilities.splice(i, 1); setDirty(true); renderAbilities(pet); };
    });

    const add = document.createElement('div');
    add.className = 'row';
    add.innerHTML = `<select id="ab-type" style="width:auto">${
      abilityCatalog.map(a => `<option value="${a.type}">${esc(a.label)}</option>`).join('')}</select>
      <button class="btn small" id="btn-ab-add">アビリティを追加</button>`;
    box.appendChild(add);
    $('btn-ab-add').onclick = async () => {
      const res = await Net.api(`/admin/ability-default/${$('ab-type').value}`);
      pet.abilities.push(res.ability);
      setDirty(true);
      renderAbilities(pet);
    };
  }

  $('btn-pet-add').onclick = () => {
    const id = prompt('新しいペットのID(素材フォルダ名。英小文字とハイフン)');
    if (!id) return;
    if (editingSnapshot.pets.some(p => p.id === id)) { alert('そのIDは既にあります'); return; }
    const base = editingSnapshot.pets[0];
    editingSnapshot.pets.push({
      ...JSON.parse(JSON.stringify(base)), id, name: id, description: '', role: '', abilities: [], released: false,
    });
    selectedPetId = id;
    setDirty(true);
    renderPetList();
    renderPetDetail();
  };
  $('btn-pet-dup').onclick = () => {
    const pet = editingSnapshot.pets.find(p => p.id === selectedPetId);
    if (!pet) return;
    const id = prompt('複製先のID', `${pet.id}-copy`);
    if (!id || editingSnapshot.pets.some(p => p.id === id)) { if (id) alert('そのIDは既にあります'); return; }
    editingSnapshot.pets.push({ ...JSON.parse(JSON.stringify(pet)), id, name: `${pet.name}(複製)`, released: false });
    selectedPetId = id;
    setDirty(true);
    renderPetList();
    renderPetDetail();
  };
  $('btn-pet-del').onclick = () => {
    const pet = editingSnapshot.pets.find(p => p.id === selectedPetId);
    if (!pet || !confirm(`${pet.name} を削除しますか?(所持済みプレイヤーのデッキから外れます)`)) return;
    editingSnapshot.pets = editingSnapshot.pets.filter(p => p.id !== pet.id);
    selectedPetId = editingSnapshot.pets[0]?.id || null;
    setDirty(true);
    renderAllFields();
    renderPetList();
    renderPetDetail();
  };

  $('btn-save-draft').onclick = async () => {
    try {
      const res = await Net.api(`/admin/versions/${editingId}`, { method: 'PUT', body: { snapshot: editingSnapshot, reason: reason() } });
      if (res.ok) {
        setDirty(false);
        msg(`保存しました(変更 ${res.changes} 件)${res.warnings.length ? ` <span class="warn">警告: ${esc(res.warnings.join(' / '))}</span>` : ''}`, 'ok');
        await loadAudit(true);
      } else {
        msg(esc(res.errors.join(' / ')), 'error');
      }
    } catch (e) {
      msg(esc(e.message), 'error');
    }
  };

  $('btn-validate').onclick = async () => {
    const res = await Net.api(`/admin/versions/${editingId}/validate`, { body: {} });
    msg(res.errors.length
      ? `<span class="error">${esc(res.errors.join(' / '))}</span>`
      : `<span class="ok">OK</span>${res.warnings.length ? ` <span class="warn">警告: ${esc(res.warnings.join(' / '))}</span>` : ''}`);
  };

  $('btn-diff').onclick = async () => {
    const other = $('diff-target').value;
    const res = await Net.api(`/admin/versions/${editingId}/diff/${other}`);
    const box = $('diff-box');
    box.classList.remove('hidden');
    box.innerHTML = res.changes.length === 0
      ? `版#${other} との差分はありません`
      : `<b>版#${other} → #${editingId}(${res.changes.length}件)</b>` + res.changes.map(c => {
          const pct = typeof c.from === 'number' && typeof c.to === 'number' && c.from !== 0
            ? `(${c.to > c.from ? '+' : ''}${Math.round(((c.to - c.from) / c.from) * 100)}%)` : '';
          return `<div>${esc(c.path)}: ${esc(JSON.stringify(c.from))} → <b>${esc(JSON.stringify(c.to))}</b> ${pct}</div>`;
        }).join('');
  };

  $('btn-testing').onclick = async () => {
    try {
      await Net.api(`/admin/versions/${editingId}/testing`, { body: { reason: reason() } });
      msg('テスト反映しました', 'ok');
      await loadVersions();
    } catch (e) {
      msg(esc(e.message), 'error');
    }
  };

  $('btn-schedule').onclick = () => withReason(async r => {
    const at = $('schedule-at').value;
    if (!at) { msg('公開日時を選んでください', 'error'); return; }
    const res = await Net.api(`/admin/versions/${editingId}/schedule`, { body: { at: new Date(at).toISOString(), reason: r } });
    msg(`${new Date(res.at).toLocaleString('ja-JP')} に自動公開されます`, 'ok');
    await loadVersions();
  });

  $('btn-publish').onclick = () => withReason(async r => {
    if (dirty && !confirm('未保存の変更があります。保存前の内容で公開しますか?')) return;
    if (!confirm('本番公開しますか?(進行中の試合は開始時の版のまま継続します)')) return;
    await Net.api(`/admin/versions/${editingId}/publish`, { body: { reason: r } });
    msg('公開しました。以後の新規マッチに適用されます', 'ok');
    await loadVersions();
    await loadAudit(true);
  });

  // ─── アカウント ──────────────────────────────────────────────
  async function loadUsers() {
    const q = new URLSearchParams({
      q: $('user-q').value || '',
      status: $('user-status').value || '',
      sort: $('user-sort').value || 'id',
      admin: $('user-admin-only').checked ? '1' : '',
    });
    const res = await Net.api(`/admin/users?${q}`);
    $('user-total').textContent = `${res.total}件`;
    const rows = res.users.map(u => `
      <tr data-user="${u.id}">
        <td class="clickable">${u.id}</td>
        <td class="clickable">${esc(u.name)}${u.is_admin ? ' 🛠' : ''}${u.firebase_uid ? ' <span class="muted">IZ</span>' : ''}</td>
        <td>Lv${u.level}</td><td><i class="coin"></i>${num(u.coins)}</td><td>⭐${u.rating}</td>
        <td>${u.wins}勝${u.losses}敗${u.draws}分</td><td>${u.matches_played}</td>
        <td>${u.status === 'active' ? 'active' : `<span class="error">${esc(u.status)}</span>`}</td>
        <td>${esc((u.last_login_at || '').slice(0, 16))}</td>
      </tr>`).join('');
    $('user-table').innerHTML =
      `<tr><th>ID</th><th>名前</th><th>Lv</th><th>コイン</th><th>レート</th><th>戦績</th><th>試合</th><th>状態</th><th>最終ログイン</th></tr>${rows}`;
    $('user-table').querySelectorAll('[data-user]').forEach(tr => {
      tr.querySelectorAll('.clickable').forEach(td => (td.onclick = () => showUser(Number(tr.dataset.user))));
    });
  }
  $('btn-user-search').onclick = loadUsers;
  $('user-q').addEventListener('keydown', e => { if (e.key === 'Enter') loadUsers(); });
  ['user-status', 'user-sort', 'user-admin-only'].forEach(id => ($(id).onchange = loadUsers));

  async function showUser(id) {
    selectedUserId = id;
    const d = await Net.api(`/admin/users/${id}`);
    const u = d.user;
    $('user-detail-card').classList.remove('hidden');
    $('user-detail').innerHTML = `
      <h2>${esc(u.name)} <span class="muted">#${u.id}${u.firebase_uid ? ' / IZ連携' : ''}</span></h2>
      <div class="kpis">
        <div class="kpi"><b>Lv${u.level}</b><span>XP ${num(u.xp)}</span></div>
        <div class="kpi"><b>${num(u.coins)}</b><span>コイン</span></div>
        <div class="kpi"><b>${u.rating}</b><span>レート</span></div>
        <div class="kpi"><b>${u.wins}/${u.losses}/${u.draws}</b><span>勝/敗/分</span></div>
        <div class="kpi"><b>${u.matches_played}</b><span>試合数</span></div>
        <div class="kpi"><b>${u.disconnects}</b><span>切断</span></div>
        <div class="kpi"><b>${esc(u.status)}</b><span>状態</span></div>
        <div class="kpi"><b>${u.is_admin ? 'あり' : 'なし'}</b><span>管理者権限</span></div>
      </div>

      <h3>調整(理由は上の「変更理由」欄を使います)</h3>
      <div class="row">
        <label style="font-size:11px">コイン<input id="g-coins" type="number" value="0" style="width:100px"></label>
        <label style="font-size:11px">XP<input id="g-xp" type="number" value="0" style="width:100px"></label>
        <label style="font-size:11px">レート<input id="g-rating" type="number" value="0" style="width:100px"></label>
        <label style="font-size:11px">レベル<input id="g-level" type="number" value="0" style="width:100px"></label>
        <label style="font-size:11px">ペット付与
          <select id="g-pet" style="width:auto"><option value="">選択</option>${
            d.allPets.filter(p => !d.pets.some(o => o.id === p.id)).map(p => `<option value="${p.id}">${esc(p.name)}(${p.rarity})</option>`).join('')}</select>
        </label>
        <button class="btn small primary" id="btn-grant">反映</button>
        <button class="btn small" id="btn-status">${u.status === 'active' ? '停止する' : '再開する'}</button>
        <button class="btn small" id="btn-admin">${u.is_admin ? '管理者権限を外す' : '管理者にする'}</button>
        <span id="user-msg"></span>
      </div>

      <h3>所持ペット(${d.pets.length})</h3>
      <div class="row">${d.pets.map(p => `<button class="btn small" data-rmpet="${p.id}">${esc(p.name)} ✕</button>`).join('') || '<span class="muted">なし</span>'}</div>

      <h3>デッキ</h3>
      <div class="scroll"><table class="admin">${d.decks.map(dk => `<tr><td>${esc(dk.name)}${dk.selected ? ' ✓使用中' : ''}</td><td>${dk.pets.map(esc).join(', ')}</td></tr>`).join('') || '<tr><td>なし</td></tr>'}</table></div>

      <h3>直近の試合</h3>
      <div class="scroll"><table class="admin">
        <tr><th>日時</th><th>対戦</th><th>結果</th><th>版</th><th>秒</th></tr>
        ${d.matches.map(m => {
          const win = m.winner_id === u.id ? '勝ち' : m.result === 'draw' ? '引分' : m.result === 'invalid' ? '無効' : '負け';
          return `<tr><td>${esc(m.started_at)}</td><td>${esc(m.p1_name)} vs ${esc(m.p2_name)}</td><td>${win}</td><td>#${m.balance_version_id}</td><td>${Math.round(m.duration_sec || 0)}</td></tr>`;
        }).join('') || '<tr><td>なし</td></tr>'}
      </table></div>

      <h3>ガチャ履歴</h3>
      <div class="scroll"><table class="admin">
        ${d.gacha.map(g => `<tr><td>${esc(g.created_at)}</td><td>${esc(g.rarity)}</td><td>${esc(g.pet_id)}</td><td>${g.duplicate ? `重複 +${g.coins_refund}` : 'NEW'}</td></tr>`).join('') || '<tr><td>なし</td></tr>'}
      </table></div>

      <h3>IZ課金</h3>
      <div class="scroll"><table class="admin">
        ${d.purchases.map(p => `<tr><td>${esc(p.created_at)}</td><td>${p.iz_amount} IZ</td><td>${num(p.coins)} コイン</td></tr>`).join('') || '<tr><td>なし</td></tr>'}
      </table></div>`;

    const userMsg = (text, cls) => { $('user-msg').innerHTML = `<span class="${cls}">${esc(text)}</span>`; };
    $('btn-grant').onclick = () => withReason(async r => {
      await Net.api(`/admin/users/${id}/grant`, {
        body: { coins: $('g-coins').value, xp: $('g-xp').value, rating: $('g-rating').value, level: $('g-level').value, petId: $('g-pet').value || undefined, reason: r },
      });
      userMsg('反映しました', 'ok');
      await Promise.all([loadUsers(), showUser(id), loadAudit(true)]);
    });
    $('btn-status').onclick = () => withReason(async r => {
      await Net.api(`/admin/users/${id}/status`, { body: { status: u.status === 'active' ? 'suspended' : 'active', reason: r } });
      await Promise.all([loadUsers(), showUser(id), loadAudit(true)]);
    });
    $('btn-admin').onclick = () => withReason(async r => {
      await Net.api(`/admin/users/${id}/admin`, { body: { isAdmin: !u.is_admin, reason: r } });
      await Promise.all([loadUsers(), showUser(id), loadAudit(true)]);
    });
    $('user-detail').querySelectorAll('[data-rmpet]').forEach(b => (b.onclick = () => withReason(async r => {
      if (!confirm(`${b.dataset.rmpet} を剥奪しますか?`)) return;
      await Net.api(`/admin/users/${id}/grant`, { body: { removePetId: b.dataset.rmpet, reason: r } });
      await showUser(id);
    })));
  }

  // ─── 試合調査 ────────────────────────────────────────────────
  async function loadMatches() {
    const q = new URLSearchParams({
      from: $('m-from').value, to: $('m-to').value, versionId: $('m-version').value,
      result: $('m-result').value, userId: $('m-user').value,
    });
    const res = await Net.api(`/admin/matches?${q}`);
    const rows = res.matches.map(m => `
      <tr data-match="${m.id}"><td class="clickable">${esc(m.startedAt)}</td>
      <td class="clickable">${esc(m.p1)} vs ${esc(m.p2)}</td>
      <td>${esc(m.result || '')}</td><td>${esc(m.reason || '')}</td><td>#${m.versionId}</td>
      <td>${Math.round(m.durationSec || 0)}秒</td><td>${m.p1Deck.length}/${m.p2Deck.length}体</td></tr>`).join('');
    $('match-table').innerHTML =
      `<tr><th>開始</th><th>対戦</th><th>結果</th><th>決着理由</th><th>版</th><th>時間</th><th>デッキ</th></tr>${rows || '<tr><td colspan=7>データなし</td></tr>'}`;
    $('match-table').querySelectorAll('[data-match]').forEach(tr => {
      tr.querySelectorAll('.clickable').forEach(td => (td.onclick = () => showMatch(tr.dataset.match)));
    });
  }
  $('btn-match-search').onclick = loadMatches;

  async function showMatch(id) {
    const d = await Net.api(`/admin/matches/${id}`);
    const m = d.match;
    $('match-detail-card').classList.remove('hidden');
    $('match-detail').innerHTML = `
      <h2>試合 ${esc(m.id.slice(0, 8))} <span class="muted">版#${m.balance_version_id}</span></h2>
      <div class="kpis">
        <div class="kpi"><b>${esc(m.p1_name)}</b><span>P1 ${m.p1_rating_before}→${m.p1_rating_after ?? '-'}</span></div>
        <div class="kpi"><b>${esc(m.p2_name)}</b><span>P2 ${m.p2_rating_before}→${m.p2_rating_after ?? '-'}</span></div>
        <div class="kpi"><b>${esc(m.result || '進行中')}</b><span>${Math.round(m.duration_sec || 0)}秒</span></div>
      </div>
      <h3>デッキ</h3>
      <div class="row"><span>P1: ${m.p1Deck.map(esc).join(', ')}</span></div>
      <div class="row"><span>P2: ${m.p2Deck.map(esc).join(', ')}</span></div>
      <h3>イベント(${d.events.length})</h3>
      <div class="timeline">${d.events.map(e => `<div>${String(e.t).padStart(6)}s  <b>${esc(e.type)}</b> ${esc(JSON.stringify(e.data))}</div>`).join('')}</div>`;
    $('match-detail-card').scrollIntoView({ behavior: 'smooth' });
  }

  // ─── 分析 ────────────────────────────────────────────────────
  const statsQuery = () => new URLSearchParams({ from: $('s-from').value, to: $('s-to').value, versionId: $('s-version').value });

  function bars(el, items, unit = '') {
    const max = Math.max(1, ...items.map(i => i.value));
    el.innerHTML = items.map(i => `
      <div class="bar"><span>${esc(i.label)}</span><i style="width:${Math.round((i.value / max) * 100)}%"></i>
      <span>${num(i.value)}${unit}</span></div>`).join('') || '<span class="muted">データなし</span>';
  }

  async function loadStats() {
    const q = statsQuery();
    const [ov, pets, gc, rev] = await Promise.all([
      Net.api(`/admin/stats/overview?${q}`), Net.api(`/admin/stats/pets?${q}`),
      Net.api(`/admin/stats/gacha?${q}`), Net.api(`/admin/stats/revenue?${q}`),
    ]);

    const t = ov.totals;
    $('kpi-box').innerHTML = [
      ['総ユーザー', t.users], ['新規24h', t.newUsers24h], ['新規7日', t.newUsers7d],
      ['アクティブ24h', t.activeUsers24h], ['アクティブ7日', t.activeUsers7d],
      ['試合数', t.matches], ['引き分け', t.draws],
      ['平均試合時間', `${t.avgDurationSec}秒`], ['中央値', `${t.medianDurationSec}秒`], ['切断(累計)', t.disconnects],
    ].map(([label, v]) => `<div class="kpi"><b>${typeof v === 'number' ? num(v) : esc(v)}</b><span>${label}</span></div>`).join('');

    bars($('bars-matches'), ov.matchesByDay.map(d => ({ label: d.day, value: d.n })), '件');
    const reasonLabel = { main_destroyed: 'メイン破壊', tiebreak: '判定', surrender: '降参', disconnect: '切断', unknown: '不明' };
    bars($('bars-reasons'), Object.entries(ov.endReasons).map(([k, v]) => ({ label: reasonLabel[k] || k, value: v })), '件');
    bars($('bars-ratings'), ov.ratingBuckets.map(b => ({ label: `${b.rating}〜`, value: b.n })), '人');

    const petRows = Object.entries(pets.stats).sort((a, b) => b[1].decks - a[1].decks).map(([petId, s]) => {
      const meta = pets.meta[petId] || {};
      const winRate = s.decks ? Math.round((s.wins / s.decks) * 100) : 0;
      const pickRate = pets.totalMatches ? Math.round((s.decks / (pets.totalMatches * 2)) * 100) : 0;
      return `<tr><td>${esc(meta.name || petId)}</td><td>${esc(meta.rarity || '')}</td><td>${meta.cost ?? ''}</td>
        <td>${s.decks}(${pickRate}%)</td><td>${winRate}%</td><td>${num(s.spawns)}</td><td>${num(Math.round(s.damage))}</td><td>${num(Math.round(s.facilityDamage))}</td></tr>`;
    }).join('');
    $('stats-table').innerHTML = `<tr><th>ペット</th><th>レア</th><th>コスト</th><th>採用(率)</th><th>勝率</th><th>出撃</th><th>与ダメージ</th><th>施設ダメージ</th></tr>${petRows || '<tr><td colspan=8>データなし</td></tr>'}`;

    $('gacha-kpis').innerHTML = [
      ['抽選回数', gc.totalPulls], ['利用者', gc.users], ['消費コイン', gc.coinsSpent],
      ['還元コイン', gc.coinsRefunded], ['重複率', `${gc.duplicateRate}%`],
    ].map(([label, v]) => `<div class="kpi"><b>${typeof v === 'number' ? num(v) : esc(v)}</b><span>${label}</span></div>`).join('');
    $('gacha-rarity-table').innerHTML = `<tr><th>レアリティ</th><th>回数</th><th>実績率</th><th>理論率</th><th>乖離</th><th>重複</th></tr>${
      gc.rarities.map(r => {
        const gap = Math.round((r.actualRate - r.theoreticalRate) * 10) / 10;
        return `<tr><td>${esc(r.id)}</td><td>${r.pulls}</td><td>${r.actualRate}%</td><td>${r.theoreticalRate}%</td>
          <td class="${Math.abs(gap) > 5 ? 'warn' : ''}">${gap > 0 ? '+' : ''}${gap}pt</td><td>${r.duplicates}</td></tr>`;
      }).join('') || '<tr><td colspan=6>データなし</td></tr>'}`;
    $('gacha-pet-table').innerHTML = `<tr><th>ペット</th><th>排出</th><th>うち重複</th></tr>${
      gc.pets.map(p => `<tr><td>${esc(p.name)}</td><td>${p.pulls}</td><td>${p.duplicates}</td></tr>`).join('') || '<tr><td colspan=3>データなし</td></tr>'}`;

    $('rev-kpis').innerHTML = [
      ['売上(IZ)', rev.totalIz], ['付与コイン', rev.totalCoins], ['購入回数', rev.count], ['課金者', rev.payers],
    ].map(([label, v]) => `<div class="kpi"><b>${num(v)}</b><span>${label}</span></div>`).join('');
    bars($('bars-revenue'), rev.byDay.map(d => ({ label: d.day, value: d.iz })), ' IZ');
    $('rev-table').innerHTML = `<tr><th>ユーザー</th><th>IZ</th><th>コイン</th><th>回数</th></tr>${
      rev.byUser.map(u => `<tr><td>${esc(u.name)}</td><td>${num(u.iz)}</td><td>${num(u.coins)}</td><td>${u.count}</td></tr>`).join('') || '<tr><td colspan=4>データなし</td></tr>'}`;
  }
  $('btn-stats').onclick = loadStats;

  // ─── 稼働状況 ────────────────────────────────────────────────
  let liveTimer = null;
  async function loadLive() {
    const res = await Net.api('/admin/live');
    $('live-at').textContent = new Date(res.now).toLocaleTimeString('ja-JP');
    $('live-kpis').innerHTML = [
      ['進行中の試合', res.rooms.length], ['接続中プレイヤー', res.connections],
      ['マッチング待機', res.queue.length], ['あいことば待ち', res.roomCodes.length],
      ['現行バランス版', `#${res.publishedVersionId}`],
    ].map(([label, v]) => `<div class="kpi"><b>${typeof v === 'number' ? num(v) : esc(v)}</b><span>${label}</span></div>`).join('');
    $('live-rooms').innerHTML = `<tr><th>試合</th><th>対戦</th><th>経過</th><th>フェーズ</th><th>メインHP</th><th>版</th></tr>${
      res.rooms.map(r => `<tr><td>${esc(r.id.slice(0, 8))}${r.practice ? ' (CPU)' : ''}</td>
        <td>${r.players.map(p => `${esc(p.name)}${p.connected ? '' : '<span class="error">(切断)</span>'}`).join(' vs ')}</td>
        <td>${r.elapsedSec}秒</td><td>${esc(r.phase)}</td><td>${r.mainHp.map(num).join(' / ')}</td><td>#${r.versionId}</td></tr>`).join('')
      || '<tr><td colspan=6>進行中の試合はありません</td></tr>'}`;
    $('live-queue').innerHTML = `<tr><th>種別</th><th>ユーザー</th><th>レート</th><th>待機</th></tr>${
      res.queue.map(q => `<tr><td>ランダム</td><td>${esc(q.name)}</td><td>⭐${q.rating}</td><td>${q.waitSec}秒</td></tr>`).join('')
      + res.roomCodes.map(q => `<tr><td>あいことば</td><td>${esc(q.name)}</td><td>-</td><td>${q.waitSec}秒</td></tr>`).join('')
      || '<tr><td colspan=4>待機なし</td></tr>'}`;
  }
  $('btn-live').onclick = loadLive;
  $('live-auto').onchange = () => {
    clearInterval(liveTimer);
    if ($('live-auto').checked) liveTimer = setInterval(() => { if ($('pane-live').classList.contains('active')) void loadLive(); }, 5000);
  };
  liveTimer = setInterval(() => { if ($('pane-live').classList.contains('active') && $('live-auto').checked) void loadLive(); }, 5000);

  // ─── 監査 ────────────────────────────────────────────────────
  async function loadAudit(reset = false) {
    if (reset) auditOffset = 0;
    const q = new URLSearchParams({
      action: $('au-action').value, from: $('au-from').value, to: $('au-to').value,
      q: $('au-q').value, limit: '100', offset: String(auditOffset),
    });
    const res = await Net.api(`/admin/audit?${q}`);
    $('au-total').textContent = `全${res.total}件`;
    const cur = $('au-action').value;
    $('au-action').innerHTML = `<option value="">全操作</option>${res.actions.map(a => `<option value="${a}">${a}</option>`).join('')}`;
    $('au-action').value = cur;
    const rows = res.audit.map(a => `
      <tr><td>${esc(a.created_at)}</td><td>${esc(a.admin_name)}</td><td>${esc(a.action)}</td><td>${esc(a.target)}</td>
      <td>${esc(a.reason || '')}</td>
      <td style="white-space:normal;max-width:420px">${esc(a.before_json || '')} → ${esc(a.after_json || '')}</td></tr>`).join('');
    const header = '<tr><th>日時</th><th>実行者</th><th>操作</th><th>対象</th><th>理由</th><th>変更</th></tr>';
    if (reset) $('audit-table').innerHTML = header + rows;
    else $('audit-table').insertAdjacentHTML('beforeend', rows);
    $('btn-audit-more').classList.toggle('hidden', res.audit.length < 100);
  }
  $('btn-audit').onclick = () => loadAudit(true);
  $('btn-audit-more').onclick = () => { auditOffset += 100; void loadAudit(false); };
  $('btn-audit-csv').onclick = () => {
    const q = new URLSearchParams({
      action: $('au-action').value, from: $('au-from').value, to: $('au-to').value, q: $('au-q').value,
    });
    void download(`/admin/audit.csv?${q}`, 'wanwan-audit.csv');
  };

  boot();
})();
