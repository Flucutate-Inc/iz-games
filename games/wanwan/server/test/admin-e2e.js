/**
 * 管理画面APIのE2E。事前に `npm start` でサーバーを起動しておくこと。
 * 管理者は「最初に登録されたアカウント」なので、DBが空の状態で最初に作った
 * アカウントの表示名/パスワードを ADMIN_NAME / ADMIN_PASS で渡す。
 * 未指定時はこのテスト内で新規登録し、それが最初なら管理者になる。
 */
const BASE = process.env.BASE || 'http://localhost:8787';
const uniq = Math.random().toString(36).slice(2, 7);

let passed = 0;
let failed = 0;
function ok(cond, name, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name} ${detail}`); }
}

async function api(path, { token, body, method } = {}) {
  const res = await fetch(BASE + '/api' + path, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, ...json };
}

(async () => {
  console.log('管理画面 E2E:');

  const adminName = process.env.ADMIN_NAME;
  let admin;
  if (adminName) {
    admin = await api('/login', { body: { name: adminName, password: process.env.ADMIN_PASS } });
  } else {
    admin = await api('/register', { body: { name: `admin${uniq}`, password: 'pass123' } });
  }
  const T = admin.token;
  const me = await api('/me', { token: T });
  if (!me.user?.is_admin) {
    console.error('  ! 管理者アカウントでログインできません(ADMIN_NAME/ADMIN_PASS を指定してください)');
    process.exit(1);
  }
  ok(true, `管理者としてログイン(${me.user.name})`);

  // 一般ユーザー(操作対象)
  const target = await api('/register', { body: { name: `t${uniq}`, password: 'pass123' } });
  const targetId = target.user.id;

  // ── 権限 ──
  const anon = await api('/admin/versions');
  ok(anon.status === 401, 'ADMIN-00: 未認証は拒否');
  const asUser = await api('/admin/versions', { token: target.token });
  ok(asUser.status === 403, 'ADMIN-00: 非管理者は拒否');

  // ── アビリティカタログ ──
  const cat = await api('/admin/ability-types', { token: T });
  ok(cat.abilities.length > 0 && cat.abilities.every(a => a.type && a.label && Array.isArray(a.params)),
    'ADMIN-03: アビリティカタログを取得', `(${cat.abilities.length}種)`);
  const def = await api('/admin/ability-default/deathExplosion', { token: T });
  ok(def.ability.type === 'deathExplosion' && def.ability.radius > 0, 'ADMIN-03: 既定値つきアビリティを生成');
  ok((await api('/admin/ability-default/nope', { token: T })).status === 400, 'ADMIN-03: 未実装の型を拒否');

  // ── 理由必須 ──
  const draft = await api('/admin/versions/draft', { token: T, body: { label: 'e2e', reason: 'e2e' } });
  ok(draft.id > 0, 'ADMIN-01: 下書きを作成');
  const noReason = await api(`/admin/versions/${draft.id}/publish`, { token: T, body: {} });
  ok(noReason.status === 400, 'ADMIN-04: 理由なしの公開を拒否');

  // ── 編集(アビリティ・新規ペット) ──
  const v = await api(`/admin/versions/${draft.id}`, { token: T });
  const snap = v.snapshot;
  snap.rules.normalTimeSec = 190;
  snap.pets[0].abilities = [{ type: 'firstStrikeMultiplier', amount: 2 }];
  snap.pets.push({ ...JSON.parse(JSON.stringify(snap.pets[0])), id: `e2epet${uniq}`, name: 'E2Eわんこ', released: false, abilities: [] });
  const saved = await api(`/admin/versions/${draft.id}`, { token: T, method: 'PUT', body: { snapshot: snap, reason: 'e2e編集' } });
  ok(saved.ok && saved.changes > 0, 'ADMIN-01: 値・アビリティ・ペット追加を保存', JSON.stringify(saved.errors || ''));

  const badAbility = JSON.parse(JSON.stringify(snap));
  badAbility.pets[0].abilities = [{ type: 'notImplemented', amount: 1 }];
  const rejected = await api(`/admin/versions/${draft.id}`, { token: T, method: 'PUT', body: { snapshot: badAbility, reason: 'e2e' } });
  ok(rejected.status === 400 && rejected.errors.some(e => e.includes('未実装')), 'ADMIN-03: 未実装アビリティを保存時に拒否');

  const badRange = JSON.parse(JSON.stringify(snap));
  badRange.pets[0].abilities = [{ type: 'firstStrikeMultiplier', amount: 999 }];
  ok((await api(`/admin/versions/${draft.id}`, { token: T, method: 'PUT', body: { snapshot: badRange, reason: 'e2e' } })).status === 400,
    'ADMIN-03: アビリティの範囲外を拒否');

  // ── 差分・ラベル・エクスポート/インポート ──
  const diff = await api(`/admin/versions/${draft.id}/diff/${(await api('/admin/versions', { token: T })).publishedId}`, { token: T });
  ok(diff.changes.some(c => c.path === 'rules.normalTimeSec'), 'ADMIN-01: 差分に変更が出る');
  ok((await api(`/admin/versions/${draft.id}/label`, { token: T, method: 'PATCH', body: { label: 'e2e-renamed' } })).ok, 'ADMIN-05: ラベル変更');
  const exported = await api(`/admin/versions/${draft.id}/export`, { token: T });
  ok(exported.rules.normalTimeSec === 190, 'ADMIN-05: エクスポート');
  const imported = await api('/admin/versions/import', { token: T, body: { snapshot: exported, label: 'e2e-import', reason: 'e2e取り込み' } });
  ok(imported.ok && imported.id > 0, 'ADMIN-05: インポートで下書き作成');
  const badImport = await api('/admin/versions/import', { token: T, body: { snapshot: { pets: [] }, reason: 'e2e' } });
  ok(!badImport.ok && badImport.errors.length > 0, 'ADMIN-05: 壊れたJSONの取り込みを拒否');

  // ── 予約公開 ──
  const at = new Date(Date.now() + 3600000).toISOString();
  const sch = await api(`/admin/versions/${imported.id}/schedule`, { token: T, body: { at, reason: 'e2e予約' } });
  ok(sch.ok, 'ADMIN-02: 公開予約');
  const listed = (await api('/admin/versions', { token: T })).versions.find(x => x.id === imported.id);
  ok(listed.status === 'scheduled' && listed.scheduled_at, 'ADMIN-02: 予約が一覧に出る');
  ok((await api(`/admin/versions/${imported.id}/schedule`, { token: T, body: { at: '2000-01-01T00:00:00Z', reason: 'e2e' } })).status >= 400,
    'ADMIN-02: 過去日時の予約を拒否');
  ok((await api(`/admin/versions/${imported.id}/schedule/cancel`, { token: T, body: { reason: 'e2e取消' } })).ok, 'ADMIN-02: 予約取消');

  // ── 削除 ──
  ok((await api(`/admin/versions/${imported.id}`, { token: T, method: 'DELETE', body: { reason: 'e2e削除' } })).ok, 'ADMIN-05: 下書き削除');
  const publishedId = (await api('/admin/versions', { token: T })).publishedId;
  ok((await api(`/admin/versions/${publishedId}`, { token: T, method: 'DELETE', body: { reason: 'e2e' } })).status >= 400,
    'ADMIN-05: 公開中の版は削除できない');

  // ── アカウント運用 ──
  const found = await api(`/admin/users?q=${targetId}`, { token: T });
  ok(found.users.some(u => u.id === targetId), 'ADMIN-06: IDで検索できる');
  const detail = await api(`/admin/users/${targetId}`, { token: T });
  ok(detail.user.id === targetId && detail.pets.length === 4 && detail.decks.length === 1, 'ADMIN-06: ユーザー詳細(所持・デッキ)');

  const before = detail.user.coins;
  const granted = await api(`/admin/users/${targetId}/grant`, {
    token: T, body: { coins: 1234, xp: 10, rating: -50, petId: 'great-dane-king', reason: 'e2e付与' },
  });
  ok(granted.user.coins === before + 1234 && granted.user.rating === detail.user.rating - 50, 'ADMIN-07: コイン/XP/レートの増減');
  const after = await api(`/admin/users/${targetId}`, { token: T });
  ok(after.pets.some(p => p.id === 'great-dane-king'), 'ADMIN-07: ペット付与');
  await api(`/admin/users/${targetId}/grant`, { token: T, body: { removePetId: 'great-dane-king', reason: 'e2e剥奪' } });
  ok(!(await api(`/admin/users/${targetId}`, { token: T })).pets.some(p => p.id === 'great-dane-king'), 'ADMIN-07: ペット剥奪');
  ok((await api(`/admin/users/${targetId}/grant`, { token: T, body: { coins: 1 } })).status === 400, 'ADMIN-04: 理由なしの付与を拒否');

  ok((await api(`/admin/users/${targetId}/admin`, { token: T, body: { isAdmin: true, reason: 'e2e権限' } })).ok, 'ADMIN-08: 管理者権限を付与');
  ok((await api('/admin/versions', { token: target.token })).versions.length > 0, 'ADMIN-08: 付与後は管理APIを使える');
  ok((await api(`/admin/users/${targetId}/admin`, { token: T, body: { isAdmin: false, reason: 'e2e権限' } })).ok, 'ADMIN-08: 管理者権限を剥奪');
  ok((await api(`/admin/users/${me.user.id}/admin`, { token: T, body: { isAdmin: false, reason: 'e2e' } })).status === 400,
    'ADMIN-08: 最後の管理者は剥奪できない');

  ok((await api(`/admin/users/${targetId}/status`, { token: T, body: { status: 'suspended', reason: 'e2e停止' } })).ok, 'ADMIN-09: 停止');
  ok((await api('/me', { token: target.token })).status === 401, 'ADMIN-09: 停止で即ログアウト');
  await api(`/admin/users/${targetId}/status`, { token: T, body: { status: 'active', reason: 'e2e再開' } });

  // ── 試合・分析・稼働・監査 ──
  const matches = await api('/admin/matches?limit=10', { token: T });
  ok(Array.isArray(matches.matches), 'ADMIN-10: 試合一覧');
  if (matches.matches[0]) {
    const md = await api(`/admin/matches/${matches.matches[0].id}`, { token: T });
    ok(Array.isArray(md.events) && md.match.p1Deck.length > 0, 'ADMIN-10: 試合詳細(イベント)');
  } else {
    console.log('  - ADMIN-10: 試合詳細は対象データなしのためスキップ');
  }

  const ov = await api('/admin/stats/overview', { token: T });
  ok(ov.totals.users > 0 && Array.isArray(ov.ratingBuckets), 'ADMIN-11: KPI(ユーザー・レート分布)');
  const ps = await api('/admin/stats/pets?versionId=' + publishedId, { token: T });
  ok(ps.meta && typeof ps.totalMatches === 'number', 'ADMIN-11: ペット分析(版フィルタ)');
  const gs = await api('/admin/stats/gacha', { token: T });
  ok(Array.isArray(gs.rarities) && gs.rarities.every(r => 'theoreticalRate' in r), 'ADMIN-11: ガチャ分析(実績vs理論)');
  const rev = await api('/admin/stats/revenue', { token: T });
  ok(typeof rev.totalIz === 'number', 'ADMIN-11: 売上集計');

  const live = await api('/admin/live', { token: T });
  ok(Array.isArray(live.rooms) && Array.isArray(live.queue) && live.publishedVersionId > 0, 'ADMIN-12: 稼働状況');

  const audit = await api('/admin/audit?limit=10', { token: T });
  ok(audit.audit.length > 0 && audit.actions.includes('grant'), 'ADMIN-13: 監査ログ(操作一覧つき)');
  const searched = await api('/admin/audit?q=e2e付与', { token: T });
  ok(searched.audit.some(a => a.reason === 'e2e付与'), 'ADMIN-13: 監査ログを理由で検索');
  const csv = await api('/admin/audit.csv?limit=10', { token: T });
  ok(String(csv.raw || '').includes('日時,実行者'), 'ADMIN-13: 監査CSV');

  // 後片付け: e2e で作った下書きを消す
  await api(`/admin/versions/${draft.id}`, { token: T, method: 'DELETE', body: { reason: 'e2e後片付け' } });

  console.log(`\n${passed} passed / ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => {
  console.error('管理E2E 異常終了:', e);
  process.exit(1);
});
