/**
 * 練習用CPU(設計書 §24 フェーズ2 の思考方針):
 *   - 敵が来たら同じレーンへ防衛(群体には範囲攻撃を優先)
 *   - ほねが8以上なら攻める(施設HPが低いレーンを優先)
 *   - 相手が高コストを出したら逆レーンを攻める
 * engine.spawn の検証を通して出撃するため、CPUもルール上の不正はできない。
 */
const engine = require('./engine');

const THINK_INTERVAL = 1.0; // 秒
const LANES = ['top', 'bottom'];

class Bot {
  /** side: ボットのサイド(通常1) */
  constructor(battle, side) {
    this.battle = battle;
    this.side = side;
    this.cooldown = 2.0; // 開幕は少し待つ
    this.lastEnemyHeavyLane = null;
  }

  think(dt) {
    const b = this.battle;
    if (b.phase === 'ended') return;
    this.cooldown -= dt;

    // 相手の高コスト出撃を観測(予告中に逆レーン攻撃の判断材料にする)
    for (const s of b.pendingSpawns) {
      if (s.owner !== this.side && b.petsById[s.petId].cost >= 6) {
        this.lastEnemyHeavyLane = s.lane;
      }
    }

    if (this.cooldown > 0) return;
    this.cooldown = THINK_INTERVAL;

    const me = b.players[this.side];
    const hand = me.hand.map(id => b.petsById[id]).filter(p => p.cost <= me.bone);
    if (hand.length === 0) return;

    const enemyCount = { top: 0, bottom: 0 };
    const myCount = { top: 0, bottom: 0 };
    for (const u of b.units) {
      if (u.hp <= 0) continue;
      const bucket = u.owner === this.side ? myCount : enemyCount;
      bucket[u.lane]++;
    }

    // 1) 防衛: 敵が優勢なレーンに出す
    for (const lane of LANES) {
      if (enemyCount[lane] > myCount[lane]) {
        // 群体(3体以上)には範囲攻撃を優先
        const area = hand.find(p => p.attackType === 'area' || p.attackType === 'areaSmall');
        const wall = hand.filter(p => p.hp >= 1500).sort((a, b2) => b2.hp - a.hp)[0];
        const pick = (enemyCount[lane] >= 3 && area) || wall || hand[0];
        this.spawn(pick.id, lane);
        return;
      }
    }

    // 2) 相手が高コストを出したら逆レーンへ圧力
    if (this.lastEnemyHeavyLane && me.bone >= 4) {
      const opposite = this.lastEnemyHeavyLane === 'top' ? 'bottom' : 'top';
      this.lastEnemyHeavyLane = null;
      const attacker = hand.sort((a, b2) => b2.cost - a.cost)[0];
      this.spawn(attacker.id, opposite);
      return;
    }

    // 3) 攻撃: ほね8以上なら、敵施設HPが低いレーンへ高コストから出す
    if (me.bone >= 8) {
      const enemy = b.players[1 - this.side];
      const laneHp = lane => (enemy.facilities[lane].destroyed ? -1 : enemy.facilities[lane].hp);
      const target = laneHp('top') <= laneHp('bottom') ? 'top' : 'bottom';
      const attacker = hand.sort((a, b2) => b2.cost - a.cost)[0];
      this.spawn(attacker.id, target);
      return;
    }

    // 4) 余裕があるときは強化(働きネコ相当)。序盤はほね経済、後半は戦力
    if (me.bone >= 8 && enemyCount.top + enemyCount.bottom === 0) {
      const order = b.t < 60 ? ['boneSpeed', 'boneCapacity'] : ['mainHouse', 'boneCapacity', 'boneSpeed'];
      for (const key of order) {
        const cost = engine.upgradeCost(b, this.side, key);
        if (cost != null && me.bone >= cost) {
          engine.upgrade(b, this.side, key);
          return;
        }
      }
      // ペット強化は手札の中で一番強化が進んでいないものから
      const petTargets = me.hand
        .map(id => ({ id, level: engine.upgradeLevel(b, this.side, 'pets', id), cost: engine.upgradeCost(b, this.side, 'pets', id) }))
        .filter(t => t.cost != null && me.bone >= t.cost)
        .sort((x, y) => x.level - y.level || x.cost - y.cost);
      if (petTargets.length > 0) {
        engine.upgrade(b, this.side, 'pets', petTargets[0].id);
        return;
      }
    }

    // 5) ほねが溢れそうなら安いペットを流す
    if (me.bone >= engine.boneMax(b, this.side) - 0.5) {
      const cheap = hand.sort((a, b2) => a.cost - b2.cost)[0];
      this.spawn(cheap.id, Math.random() < 0.5 ? 'top' : 'bottom');
    }
  }

  spawn(petId, lane) {
    engine.spawn(this.battle, this.side, petId, lane); // 失敗(上限等)は無視して次のthinkで再判断
  }
}

/** CPUのデッキ(壁・範囲・遠距離・回復のバランス型) */
const BOT_DECK = [
  'mame-shiba',
  'bulldog',
  'chihuahua-assault',
  'dachs-sniper',
  'pomeranian-squad',
  'husky-artillery',
  'border-collie',
  'beagle-expedition',
];

module.exports = { Bot, BOT_DECK };
