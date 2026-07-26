/**
 * ガチャの抽選ロジック(純粋関数・I/Oなし)。
 * 排出率・コスト・重複時の還元コインはすべてバランススナップショットの gacha から取る
 * (design/spec.md §0: バランス値をコードに直書きしない)。
 */

/** 抽選対象(公開中のペット)をレアリティごとに分類する */
function poolByRarity(gacha, pets) {
  const pool = {};
  for (const r of gacha.rarities) pool[r.id] = [];
  for (const p of pets) {
    if (p.released === false) continue;
    if (pool[p.rarity]) pool[p.rarity].push(p.id);
  }
  return pool;
}

/** レアリティの希少度(配列の後ろほど希少) */
function rarityRank(gacha, id) {
  return gacha.rarities.findIndex(r => r.id === id);
}

/** 重み付き抽選。minRank 以上のレアリティのみを対象にできる(10連の確定枠用) */
function pickRarity(gacha, pool, rng, minRank = 0) {
  const candidates = gacha.rarities
    .map((r, i) => ({ ...r, rank: i }))
    .filter(r => r.rank >= minRank && r.weight > 0 && pool[r.id].length > 0);
  if (candidates.length === 0) return null;
  const total = candidates.reduce((a, r) => a + r.weight, 0);
  let x = rng() * total;
  for (const r of candidates) {
    x -= r.weight;
    if (x < 0) return r;
  }
  return candidates[candidates.length - 1];
}

/**
 * count 回ぶんの抽選結果を返す(DB更新はしない)。
 * すでに所有しているペットが出たときは重複としてコインを還元する。
 * 同じ抽選内で2回出た場合も2回目は重複になる。
 *
 * @returns {{ results: Array<{petId, rarity, duplicate, coins}>, newPetIds: string[], refundCoins: number }}
 */
function draw({ gacha, pets, owned, count, rng }) {
  const pool = poolByRarity(gacha, pets);
  const have = new Set(owned);
  const guaranteeRank = count >= gacha.multiCount && gacha.multiGuaranteeRarity
    ? rarityRank(gacha, gacha.multiGuaranteeRarity)
    : -1;

  const results = [];
  const newPetIds = [];
  let refundCoins = 0;
  for (let i = 0; i < count; i++) {
    // 10連の最後の1枠は、それまでに確定レアリティ以上が出ていなければ確定枠にする
    const needGuarantee = guaranteeRank >= 0
      && i === count - 1
      && !results.some(r => rarityRank(gacha, r.rarity) >= guaranteeRank);
    let r = pickRarity(gacha, pool, rng, needGuarantee ? guaranteeRank : 0);
    if (!r) r = pickRarity(gacha, pool, rng, 0); // 確定枠の在庫がない場合は通常抽選へ
    if (!r) throw new Error('抽選できるペットがいません');
    const candidates = pool[r.id];
    const petId = candidates[Math.floor(rng() * candidates.length) % candidates.length];
    const duplicate = have.has(petId);
    const coins = duplicate ? r.duplicateCoins : 0;
    if (duplicate) refundCoins += coins;
    else {
      have.add(petId);
      newPetIds.push(petId);
    }
    results.push({ petId, rarity: r.id, duplicate, coins });
  }
  return { results, newPetIds, refundCoins };
}

/** 表示用の排出率(%)。合計が100になるよう weight を正規化する */
function rates(gacha, pets) {
  const pool = poolByRarity(gacha, pets);
  const active = gacha.rarities.filter(r => r.weight > 0 && pool[r.id].length > 0);
  const total = active.reduce((a, r) => a + r.weight, 0) || 1;
  return gacha.rarities.map(r => ({
    id: r.id,
    name: r.name,
    duplicateCoins: r.duplicateCoins,
    rate: active.includes(r) ? Math.round((r.weight / total) * 1000) / 10 : 0,
    petIds: pool[r.id],
  }));
}

/** 引く回数に対する必要コイン(1回 or multiCount 回のみ) */
function costFor(gacha, count) {
  if (count === 1) return gacha.singleCost;
  if (count === gacha.multiCount) return gacha.multiCost;
  return null;
}

module.exports = { draw, rates, costFor, poolByRarity, rarityRank };
