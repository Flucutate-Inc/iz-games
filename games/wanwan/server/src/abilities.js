/**
 * アビリティのカタログ。
 * 「トリガー+条件+対象+効果+制限」をデータで組み合わせ、特殊挙動は
 * サーバー実装済みハンドラー(engine.js)を選ぶ方式(design/spec.md §5)。
 *
 * ここに定義した型・パラメータだけが管理画面に出て、バリデーションもこれを使う。
 * engine.js に実装のない型を足してはいけない(足す場合はハンドラーと対で追加する。
 * ユニットテスト「カタログの型はすべてエンジンに実装がある」で機械的に担保している)。
 *
 * 回復役(うさぎ救護班)は attackType='heal' + healPower で挙動が決まるため、
 * アビリティとしては持たない。
 */

const num = (key, label, { min = 0, max = 100000, step = 'any', def = 0, unit = '' } = {}) =>
  ({ key, label, type: 'number', min, max, step, def, unit });
const bool = (key, label, def = false) => ({ key, label, type: 'boolean', def });

const ABILITIES = [
  {
    type: 'damageReduction',
    label: '出撃直後の被ダメージ軽減',
    trigger: '出撃時',
    target: '自分',
    desc: '出撃してから一定時間、受けるダメージを軽減する。',
    params: [
      num('amount', '軽減率', { max: 0.95, def: 0.25, unit: '(0〜0.95)' }),
      num('duration', '持続', { max: 60, def: 3, unit: '秒' }),
    ],
    fixed: { trigger: 'onSpawn' },
  },
  {
    type: 'firstStrikeMultiplier',
    label: '初撃ダメージ倍率',
    trigger: '最初の攻撃',
    target: '敵',
    desc: '1回目の攻撃だけダメージが倍率ぶん増える。',
    params: [num('amount', '倍率', { min: 1, max: 10, def: 1.7, unit: '倍' })],
  },
  {
    type: 'auraAttackBuff',
    label: 'オーラ: 味方攻撃力アップ',
    trigger: '常時',
    target: '同レーンの味方',
    desc: '半径内の味方の攻撃力を上げる(同効果は重複せず最大値を採用)。',
    params: [
      num('amount', '上昇率', { max: 5, def: 0.15, unit: '(0.15=+15%)' }),
      num('radius', '半径', { min: 1, max: 1000, def: 160 }),
      bool('stacking', '重複可', false),
    ],
  },
  {
    type: 'auraDamageReduction',
    label: 'オーラ: 味方被ダメージ軽減',
    trigger: '常時',
    target: '同レーンの味方',
    desc: '半径内の味方が受けるダメージを軽減する(同効果は重複しない)。',
    params: [
      num('amount', '軽減率', { max: 0.95, def: 0.1, unit: '(0〜0.95)' }),
      num('radius', '半径', { min: 1, max: 1000, def: 160 }),
    ],
  },
  {
    type: 'stunOnFirstHit',
    label: '命中時スタン',
    trigger: '攻撃命中',
    target: '敵',
    desc: '攻撃を当てた相手を気絶させる。連続スタンは免疫時間で防ぐ。',
    params: [
      num('duration', '気絶時間', { max: 30, def: 1.5, unit: '秒' }),
      num('reStunImmunity', '再スタン免疫', { max: 60, def: 6, unit: '秒' }),
    ],
  },
  {
    type: 'attackSpeedOnKill',
    label: '撃破時に攻撃速度アップ',
    trigger: '敵を倒したとき',
    target: '自分',
    desc: '敵を倒すたび攻撃速度が上がる(上限スタックまで)。',
    params: [
      num('amount', '上昇率', { max: 5, def: 0.15, unit: '(0.15=+15%)' }),
      num('duration', '持続', { max: 60, def: 5, unit: '秒' }),
      num('maxStacks', '最大スタック', { min: 1, max: 10, step: 1, def: 2 }),
    ],
  },
  {
    type: 'attackDebuffOnHit',
    label: '命中時に敵の攻撃力ダウン',
    trigger: '攻撃命中',
    target: '敵',
    desc: '攻撃を当てた相手の攻撃力を一定時間下げる(重ねがけはしない)。',
    params: [
      num('amount', '低下率', { max: 0.95, def: 0.3, unit: '(0〜0.95)' }),
      num('duration', '持続', { max: 60, def: 4, unit: '秒' }),
    ],
  },
  {
    type: 'deathExplosion',
    label: '死亡時に範囲ダメージ',
    trigger: '自分が倒れたとき',
    target: '同レーンの敵・施設',
    desc: '倒れた地点で爆発し、半径内の敵と施設にダメージを与える。',
    params: [
      num('radius', '半径', { min: 1, max: 1000, def: 90 }),
      num('damage', 'ダメージ', { max: 20000, def: 900 }),
      num('buildingDamageRatio', '対施設倍率', { max: 10, def: 1, unit: '倍' }),
    ],
  },
  {
    type: 'knockbackImmune',
    label: 'ノックバック無効',
    trigger: '常時',
    target: '自分',
    desc: 'HPが減ってもノックバックしない。',
    params: [],
  },
];

const BY_TYPE = Object.fromEntries(ABILITIES.map(a => [a.type, a]));

/** 1体ぶんのアビリティ配列を検証する(エラー文字列の配列を返す) */
function validateAbilities(petId, abilities) {
  const errors = [];
  if (abilities == null) return errors;
  if (!Array.isArray(abilities)) return [`${petId}.abilities が配列ではありません`];
  for (const ab of abilities) {
    const def = BY_TYPE[ab?.type];
    if (!def) {
      errors.push(`${petId}: 未実装のアビリティです: ${ab?.type}`);
      continue;
    }
    for (const p of def.params) {
      const v = ab[p.key];
      if (p.type === 'boolean') {
        if (v != null && typeof v !== 'boolean') errors.push(`${petId}.${ab.type}.${p.key} は true/false です`);
        continue;
      }
      if (typeof v !== 'number' || Number.isNaN(v)) {
        errors.push(`${petId}.${ab.type}.${p.key} が数値ではありません`);
      } else if (v < p.min || v > p.max) {
        errors.push(`${petId}.${ab.type}.${p.key} が範囲外です(${p.min}〜${p.max}): ${v}`);
      }
    }
  }
  return errors;
}

/** 型の既定値でアビリティを1つ作る(管理画面の追加ボタン用) */
function makeDefault(type) {
  const def = BY_TYPE[type];
  if (!def) throw new Error(`未知のアビリティ: ${type}`);
  const ab = { type, ...(def.fixed || {}) };
  for (const p of def.params) ab[p.key] = p.def;
  return ab;
}

module.exports = { ABILITIES, BY_TYPE, validateAbilities, makeDefault };
