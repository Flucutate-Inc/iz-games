/** 管理画面: バージョン管理・アカウント運用・分析・監査 */
(() => {
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let editingId = null;
  let editingSnapshot = null;
  let publishedId = null;

  const PET_FIELDS = ['cost', 'hp', 'attackPower', 'attackInterval', 'attackRange', 'moveSpeed', 'spawnDelay', 'rechargeSec'];
  const reason = () => $('draft-reason').value.trim() || undefined;

  async function boot() {
    try {
      const res = await Net.api('/me');
      if (!res.user.is_admin) throw new Error('管理者ではありません');
      $('admin-user').textContent = `${res.user.name}(管理者)`;
      $('admin-login-card').classList.add('hidden');
      $('admin-main').classList.remove('hidden');
      await Promise.all([loadVersions(), loadUsers(), loadAudit(), loadStats()]);
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

  // ─── バージョン ──────────────────────────────────────────────
  async function loadVersions() {
    const res = await Net.api('/admin/versions');
    publishedId = res.publishedId;
    const rows = res.versions.map(v => `
      <tr>
        <td>#${v.id}</td>
        <td><span class="badge ${v.status}">${v.status}</span></td>
        <td>${esc(v.label)}</td>
        <td>${esc(v.created_at)}</td>
        <td>${esc(v.published_at || '')}</td>
        <td class="row">
          ${['draft', 'testing'].includes(v.status) ? `<button class="btn small" data-edit="${v.id}">編集</button>` : ''}
          ${['archived', 'rolled_back'].includes(v.status) ? `<button class="btn small" data-rollback="${v.id}">この版へ戻す</button>` : ''}
          ${v.status !== 'published' ? '' : '<b>現行</b>'}
        </td>
      </tr>`).join('');
    $('version-table').innerHTML = `<tr><th>版</th><th>状態</th><th>ラベル</th><th>作成</th><th>公開</th><th>操作</th></tr>${rows}`;
    $('version-table').querySelectorAll('[data-edit]').forEach(b => (b.onclick = () => openEditor(Number(b.dataset.edit))));
    $('version-table').querySelectorAll('[data-rollback]').forEach(b => (b.onclick = async () => {
      if (!confirm(`版#${b.dataset.rollback} の内容へロールバックしますか?`)) return;
      await Net.api(`/admin/versions/${b.dataset.rollback}/rollback`, { body: { reason: reason() } });
      await loadVersions();
      await loadAudit();
    }));
  }

  $('btn-new-draft').onclick = async () => {
    const res = await Net.api('/admin/versions/draft', { body: { label: $('draft-label').value.trim(), reason: reason() } });
    await loadVersions();
    openEditor(res.id);
  };

  async function openEditor(id) {
    const v = await Net.api(`/admin/versions/${id}`);
    editingId = id;
    editingSnapshot = v.snapshot;
    $('edit-vid').textContent = `#${id}(${v.status})`;
    $('editor-card').classList.remove('hidden');
    $('diff-box').classList.add('hidden');
    $('edit-msg').textContent = '';
    renderRules();
    renderPetTable();
    $('editor-card').scrollIntoView({ behavior: 'smooth' });
  }

  function numInput(value, onChange, step = 'any') {
    const input = document.createElement('input');
    input.type = 'number';
    input.step = step;
    input.value = value;
    input.onchange = () => onChange(Number(input.value));
    return input;
  }

  function renderRules() {
    const s = editingSnapshot;
    const box = $('rules-fields');
    box.innerHTML = '';
    const fields = [
      ['通常時間(秒)', s.rules, 'normalTimeSec'],
      ['延長(秒)', s.rules, 'overtimeSec'],
      ['ほね開始', s.rules.bone, 'start'],
      ['ほね最大', s.rules.bone, 'max'],
      ['回復間隔(秒)', s.rules.bone, 'regenSec'],
      ['延長倍率', s.rules.bone, 'overtimeMultiplier'],
      ['手札', s.rules.hand, 'size'],
      ['デッキ最小', s.rules.deck, 'min'],
      ['デッキ最大', s.rules.deck, 'max'],
      ['出撃上限', s.rules.unitCaps, 'totalPerPlayer'],
      ['レーン上限', s.rules.unitCaps, 'perLane'],
      ['切断猶予(秒)', s.rules.disconnect, 'graceSec'],
      ['切断敗北(秒)', s.rules.disconnect, 'lossSec'],
      ['レーンハウスHP', s.facilities.laneHouse, 'hp'],
      ['レーンハウス攻撃', s.facilities.laneHouse, 'attackPower'],
      ['メインHP', s.facilities.mainHouse, 'hp'],
      ['メイン攻撃', s.facilities.mainHouse, 'attackPower'],
      ['勝利XP', s.progression.xp, 'win'],
      ['敗北XP', s.progression.xp, 'lose'],
      ['勝利コイン', s.progression.coins, 'win'],
      ['敗北コイン', s.progression.coins, 'lose'],
    ];
    if (s.upgrades) {
      const U = s.upgrades;
      fields.push(
        ['ほね容量: 最大Lv', U.boneCapacity, 'maxLevel'],
        ['ほね容量: 初期コスト', U.boneCapacity, 'baseCost'],
        ['ほね容量: 増加量', U.boneCapacity, 'increment'],
        ['ほね回復: 最大Lv', U.boneSpeed, 'maxLevel'],
        ['ほね回復: 初期コスト', U.boneSpeed, 'baseCost'],
        ['ほね回復: Lvあたり', U.boneSpeed, 'speedupPerLevel'],
        ['ペット強化: 最大Lv', U.pets, 'maxLevel'],
        ['ペット強化: 初期コスト', U.pets, 'baseCost'],
        ['ペット強化: HP/Lv', U.pets, 'hpPerLevel'],
        ['ペット強化: 攻撃/Lv', U.pets, 'attackPerLevel'],
        ['おうち強化: 最大Lv', U.mainHouse, 'maxLevel'],
        ['おうち強化: 初期コスト', U.mainHouse, 'baseCost'],
        ['おうち強化: HP/Lv', U.mainHouse, 'hpPerLevel'],
      );
    }
    for (const [label, obj, key] of fields) {
      const wrap = document.createElement('label');
      wrap.style.fontSize = '0.75rem';
      wrap.textContent = label;
      wrap.appendChild(numInput(obj[key], v => (obj[key] = v)));
      box.appendChild(wrap);
    }
  }

  function renderPetTable() {
    const table = $('pet-table');
    table.innerHTML = `<tr><th>ペット</th>${PET_FIELDS.map(f => `<th>${f}</th>`).join('')}<th>公開</th></tr>`;
    for (const pet of editingSnapshot.pets) {
      const tr = document.createElement('tr');
      const nameTd = document.createElement('td');
      nameTd.textContent = pet.name;
      tr.appendChild(nameTd);
      for (const f of PET_FIELDS) {
        const td = document.createElement('td');
        td.appendChild(numInput(pet[f], v => (pet[f] = v)));
        tr.appendChild(td);
      }
      const relTd = document.createElement('td');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!pet.released;
      cb.onchange = () => (pet.released = cb.checked);
      relTd.appendChild(cb);
      tr.appendChild(relTd);
      table.appendChild(tr);
    }
  }

  $('btn-save-draft').onclick = async () => {
    try {
      const res = await Net.api(`/admin/versions/${editingId}`, { method: 'PUT', body: { snapshot: editingSnapshot, reason: reason() } });
      $('edit-msg').innerHTML = res.ok
        ? `<span class="ok">保存しました</span>${res.warnings.length ? ` <span class="warn">警告: ${esc(res.warnings.join(' / '))}</span>` : ''}`
        : `<span class="error">${esc(res.errors.join(' / '))}</span>`;
      await loadAudit();
    } catch (e) {
      $('edit-msg').innerHTML = `<span class="error">${esc(e.message)}</span>`;
    }
  };

  $('btn-validate').onclick = async () => {
    const res = await Net.api(`/admin/versions/${editingId}/validate`, { body: {} });
    $('edit-msg').innerHTML = res.errors.length
      ? `<span class="error">${esc(res.errors.join(' / '))}</span>`
      : `<span class="ok">OK</span>${res.warnings.length ? ` <span class="warn">警告: ${esc(res.warnings.join(' / '))}</span>` : ''}`;
  };

  $('btn-diff').onclick = async () => {
    const res = await Net.api(`/admin/versions/${editingId}/diff/${publishedId}`);
    const box = $('diff-box');
    box.classList.remove('hidden');
    box.innerHTML = res.changes.length === 0
      ? '現行版との差分はありません'
      : res.changes.map(c => {
          const pct = typeof c.from === 'number' && typeof c.to === 'number' && c.from !== 0
            ? `(${c.to > c.from ? '+' : ''}${Math.round(((c.to - c.from) / c.from) * 100)}%)` : '';
          return `<div>${esc(c.path)}: ${esc(JSON.stringify(c.from))} → <b>${esc(JSON.stringify(c.to))}</b> ${pct}</div>`;
        }).join('');
  };

  $('btn-testing').onclick = async () => {
    try {
      await Net.api(`/admin/versions/${editingId}/testing`, { body: { reason: reason() } });
      $('edit-msg').innerHTML = '<span class="ok">テスト反映しました</span>';
      await loadVersions();
    } catch (e) {
      $('edit-msg').innerHTML = `<span class="error">${esc(e.message)}</span>`;
    }
  };

  $('btn-publish').onclick = async () => {
    if (!confirm('本番公開しますか?(進行中の試合は開始時の版のまま継続します)')) return;
    try {
      await Net.api(`/admin/versions/${editingId}/publish`, { body: { reason: reason() } });
      $('edit-msg').innerHTML = '<span class="ok">公開しました。以後の新規マッチに適用されます</span>';
      await loadVersions();
      await loadAudit();
    } catch (e) {
      $('edit-msg').innerHTML = `<span class="error">${esc(e.message)}</span>`;
    }
  };

  // ─── アカウント運用 ──────────────────────────────────────────
  async function loadUsers() {
    const res = await Net.api(`/admin/users?q=${encodeURIComponent($('user-q').value || '')}`);
    const rows = res.users.map(u => `
      <tr><td>${u.id}</td><td>${esc(u.name)}</td><td>Lv${u.level}</td><td>🪙${u.coins}</td><td>⭐${u.rating}</td>
      <td>${u.wins}勝${u.losses}敗</td><td>${u.status}</td>
      <td class="row">
        <button class="btn small" data-coin="${u.id}">+500🪙</button>
        <button class="btn small" data-sus="${u.id}">${u.status === 'active' ? '停止' : '再開'}</button>
      </td></tr>`).join('');
    $('user-table').innerHTML = `<tr><th>ID</th><th>名前</th><th>Lv</th><th>コイン</th><th>レート</th><th>戦績</th><th>状態</th><th>操作</th></tr>${rows}`;
    $('user-table').querySelectorAll('[data-coin]').forEach(b => (b.onclick = async () => {
      await Net.api(`/admin/users/${b.dataset.coin}/grant`, { body: { coins: 500, reason: 'admin grant' } });
      await loadUsers();
    }));
    $('user-table').querySelectorAll('[data-sus]').forEach(b => (b.onclick = async () => {
      const row = res.users.find(u => String(u.id) === b.dataset.sus);
      await Net.api(`/admin/users/${b.dataset.sus}/status`, { body: { status: row.status === 'active' ? 'suspended' : 'active', reason: 'admin' } });
      await loadUsers();
    }));
  }
  $('btn-user-search').onclick = loadUsers;

  // ─── 分析 ───────────────────────────────────────────────────
  async function loadStats() {
    const res = await Net.api('/admin/stats/pets');
    const rows = Object.entries(res.stats)
      .sort((a, b) => b[1].decks - a[1].decks)
      .map(([petId, s]) => {
        const winRate = s.decks ? Math.round((s.wins / s.decks) * 100) : 0;
        return `<tr><td>${esc(petId)}</td><td>${s.decks}</td><td>${winRate}%</td><td>${s.spawns}</td><td>${s.damage}</td><td>${s.facilityDamage}</td></tr>`;
      }).join('');
    $('stats-table').innerHTML = `<tr><th>ペット</th><th>採用数</th><th>勝率</th><th>出撃</th><th>与ダメージ</th><th>施設ダメージ</th></tr>${rows || '<tr><td colspan=6>データなし</td></tr>'}`;
  }
  $('btn-stats').onclick = loadStats;

  // ─── 監査 ───────────────────────────────────────────────────
  async function loadAudit() {
    const res = await Net.api('/admin/audit');
    const rows = res.audit.map(a => `
      <tr><td>${esc(a.created_at)}</td><td>${esc(a.admin_name)}</td><td>${esc(a.action)}</td><td>${esc(a.target)}</td>
      <td>${esc(a.reason || '')}</td><td style="max-width:260px;overflow:hidden;text-overflow:ellipsis">${esc(a.before_json || '')} → ${esc(a.after_json || '')}</td></tr>`).join('');
    $('audit-table').innerHTML = `<tr><th>日時</th><th>実行者</th><th>操作</th><th>対象</th><th>理由</th><th>変更</th></tr>${rows}`;
  }
  $('btn-audit').onclick = loadAudit;

  boot();
})();
