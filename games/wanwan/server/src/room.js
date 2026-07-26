/**
 * 対戦ルーム: tick 駆動、操作検証、状態配信、切断・再接続、結果確定と報酬。
 * バランス版はルーム生成時に固定される(VERSION-01)。
 */
const crypto = require('crypto');
const db = require('./db');
const engine = require('./engine');

const TICK_MS = 50; // 20Hz(設計書 6.2)
const STATE_EVERY = 2; // 状態送信 10Hz
const SNAPSHOT_EVERY = 40; // フルスナップショット 2秒ごと

class Room {
  /**
   * players: [{userId, name, rating, deck, ws, matchesPlayed, bot?}]
   * options.practice: 練習試合(CPU戦)。DB記録・報酬・レート変動なし。
   */
  constructor(players, balanceVersion, onEnd, options = {}) {
    this.id = crypto.randomUUID();
    this.practice = !!options.practice;
    this.balanceVersionId = balanceVersion.id;
    this.snapshot = balanceVersion.snapshot; // マッチ中は不変
    this.players = players.map(p => ({
      ...p,
      connected: true,
      disconnectedAt: null,
      lastSeq: 0,
    }));
    this.onEnd = onEnd;
    this.tickCount = 0;
    this.endedNotified = false;
    this.startedAtMs = Date.now();

    this.battle = engine.createBattle({
      snapshot: this.snapshot,
      decks: [players[0].deck, players[1].deck],
      seed: crypto.randomBytes(4).readUInt32LE(0),
    });

    if (!this.practice) {
      db.prepare(
        `INSERT INTO matches (id, p1_id, p2_id, balance_version_id, p1_deck_json, p2_deck_json, p1_rating_before, p2_rating_before)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(this.id, players[0].userId, players[1].userId, this.balanceVersionId,
        JSON.stringify(players[0].deck), JSON.stringify(players[1].deck),
        players[0].rating, players[1].rating);
    }

    for (let side = 0; side < 2; side++) {
      this.send(side, { type: 'match_start', ...this.fullSnapshot(side) });
    }
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  sideOf(userId) {
    return this.players.findIndex(p => p.userId === userId);
  }

  send(side, msg) {
    const p = this.players[side];
    if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(msg));
  }

  broadcast(msg) {
    this.send(0, msg);
    this.send(1, msg);
  }

  /** 完全スナップショット(再接続復帰にも使用: NET-01) */
  fullSnapshot(side) {
    const b = this.battle;
    const me = b.players[side];
    const opp = this.players[1 - side];
    return {
      matchId: this.id,
      side,
      balanceVersionId: this.balanceVersionId,
      pets: this.snapshot.pets,
      rules: this.snapshot.rules,
      facilitiesConf: this.snapshot.facilities,
      opponent: { name: opp.name, rating: opp.rating },
      you: { name: this.players[side].name, rating: this.players[side].rating },
      state: this.publicState(side),
      hand: { hand: me.hand, reserve: me.reserve.length, cooldowns: me.cooldowns, deck: me.deck },
      lastSeq: this.players[side].lastSeq,
    };
  }

  /** 状態(相手の手札・正確なほねは含めない: 設計書 §22 相当) */
  publicState(side) {
    const b = this.battle;
    const me = b.players[side];
    return {
      t: Math.round(b.t * 100) / 100,
      phase: b.phase,
      bone: Math.round(me.bone * 100) / 100,
      boneMax: engine.boneMax(b, side),
      upgrades: { ...me.upgrades, pets: { ...me.upgrades.pets } },
      upgradeCosts: Object.fromEntries(
        ['boneCapacity', 'boneSpeed', 'mainHouse'].map(k => [k, engine.upgradeCost(b, side, k)]),
      ),
      // ペット強化はペットごと(デッキ内の全ペット分)
      petUpgradeCosts: Object.fromEntries(me.deck.map(id => [id, engine.upgradeCost(b, side, 'pets', id)])),
      upgradeEffects: engine.upgradeEffects(b, side),
      hand: me.hand,
      cooldowns: Object.fromEntries(Object.entries(me.cooldowns).map(([k, v]) => [k, Math.round(v * 10) / 10])),
      reserveCount: me.reserve.length,
      points: [b.players[0].points, b.players[1].points],
      facilities: b.players.map(p => ({
        top: { hp: Math.max(0, Math.round(p.facilities.top.hp)), maxHp: p.facilities.top.maxHp, destroyed: p.facilities.top.destroyed },
        bottom: { hp: Math.max(0, Math.round(p.facilities.bottom.hp)), maxHp: p.facilities.bottom.maxHp, destroyed: p.facilities.bottom.destroyed },
        main: { hp: Math.max(0, Math.round(p.facilities.main.hp)), maxHp: p.facilities.main.maxHp, destroyed: p.facilities.main.destroyed },
      })),
      units: b.units.map(u => ({
        id: u.id, owner: u.owner, petId: u.petId, lane: u.lane,
        x: Math.round(u.x), hp: Math.max(0, Math.round(u.hp)), maxHp: u.maxHp,
        anim: u.hp <= 0 ? 'death' : u.anim, flying: u.flying,
      })),
      pending: b.pendingSpawns.map(s => ({ owner: s.owner, petId: s.petId, lane: s.lane, remain: Math.round(s.remain * 100) / 100 })),
      connection: [this.players[0].connected, this.players[1].connected],
    };
  }

  /** クライアント操作(連番検証・重複防止: NET-02) */
  handleOp(userId, msg) {
    const side = this.sideOf(userId);
    if (side < 0) return;
    if (this.battle.phase === 'ended') return this.send(side, { type: 'op_rejected', seq: msg.seq, error: '試合は終了しています' });

    if (typeof msg.seq !== 'number' || msg.seq <= this.players[side].lastSeq) {
      return this.send(side, { type: 'op_rejected', seq: msg.seq, error: '操作の連番が不正です(重複または逆転)' });
    }
    this.players[side].lastSeq = msg.seq;

    if (msg.type === 'spawn') {
      const owned = this.players[side].deck.includes(msg.petId);
      const result = owned ? engine.spawn(this.battle, side, msg.petId, msg.lane) : { error: '編成外のペットです' };
      if (result.error) {
        this.send(side, { type: 'op_rejected', seq: msg.seq, error: result.error });
      } else {
        this.recordEvent('op_spawn', { side, petId: msg.petId, lane: msg.lane, bone: this.battle.players[side].bone });
        this.send(side, { type: 'op_accepted', seq: msg.seq });
      }
    } else if (msg.type === 'upgrade') {
      const result = engine.upgrade(this.battle, side, msg.key, msg.petId);
      if (result.error) {
        this.send(side, { type: 'op_rejected', seq: msg.seq, error: result.error });
      } else {
        this.recordEvent('op_upgrade', { side, key: msg.key, petId: msg.petId, level: result.level });
        this.send(side, { type: 'op_accepted', seq: msg.seq });
      }
    } else if (msg.type === 'surrender') {
      this.recordEvent('surrender', { side });
      engine.surrender(this.battle, side);
    }
  }

  handleDisconnect(userId) {
    const side = this.sideOf(userId);
    if (side < 0) return;
    this.players[side].connected = false;
    this.players[side].disconnectedAt = Date.now();
    this.players[side].ws = null;
    this.recordEvent('disconnect', { side });
    this.send(1 - side, { type: 'opponent_connection', connected: false });
  }

  handleReconnect(userId, ws) {
    const side = this.sideOf(userId);
    if (side < 0) return false;
    this.players[side].ws = ws;
    this.players[side].connected = true;
    this.players[side].disconnectedAt = null;
    this.recordEvent('reconnect', { side });
    this.send(side, { type: 'match_start', reconnected: true, ...this.fullSnapshot(side) });
    this.send(1 - side, { type: 'opponent_connection', connected: true });
    return true;
  }

  recordEvent(type, data) {
    if (this.practice) return;
    db.prepare('INSERT INTO match_events (match_id, t, type, data_json) VALUES (?, ?, ?, ?)').run(
      this.id, Math.round(this.battle.t * 100) / 100, type, JSON.stringify(data),
    );
  }

  tick() {
    const b = this.battle;
    engine.tick(b, TICK_MS / 1000);
    this.tickCount++;
    if (this.bot) this.bot.think(TICK_MS / 1000);

    // エンジンイベントを配信+重要イベントを永続化
    for (const ev of b.events) {
      this.broadcast({ type: 'event', ev });
      if (!this.practice && ['spawn', 'facility_destroyed', 'overtime_start', 'match_end', 'death'].includes(ev.type)) {
        db.prepare('INSERT INTO match_events (match_id, t, type, data_json) VALUES (?, ?, ?, ?)').run(
          this.id, ev.t, ev.type, JSON.stringify(ev.data),
        );
      }
    }
    b.events = [];

    // 切断敗北(猶予はルールから: 設計書 6.3)
    const lossMs = (b.rules.disconnect?.lossSec ?? 30) * 1000;
    for (let side = 0; side < 2; side++) {
      const p = this.players[side];
      if (!p.connected && p.disconnectedAt && Date.now() - p.disconnectedAt > lossMs && b.phase !== 'ended') {
        this.recordEvent('disconnect_loss', { side });
        engine.finish(b, side === 0 ? 'p2' : 'p1', 'disconnect');
      }
    }

    if (this.tickCount % STATE_EVERY === 0 && b.phase !== 'ended') {
      for (let side = 0; side < 2; side++) this.send(side, { type: 'state', state: this.publicState(side) });
    }
    if (this.tickCount % SNAPSHOT_EVERY === 0 && b.phase !== 'ended') {
      for (let side = 0; side < 2; side++) this.send(side, { type: 'snapshot', ...this.fullSnapshot(side) });
    }

    if (b.phase === 'ended' && !this.endedNotified) {
      this.endedNotified = true;
      this.finalize();
    }
  }

  /** 結果確定・報酬(冪等: REWARD-01)・後片付け */
  finalize() {
    clearInterval(this.timer);
    const b = this.battle;
    const { result, reason } = b.result;

    // 練習試合は報酬・レート・DB記録なし
    const rewards = this.practice ? [null, null] : applyRewards(this.id, this.players, b, result);

    // ペット別ダメージ集計を保存(分析用)
    if (!this.practice) {
      for (let side = 0; side < 2; side++) {
        for (const [petId, s] of Object.entries(b.players[side].petDamage)) {
          db.prepare('INSERT INTO match_events (match_id, t, type, data_json) VALUES (?, ?, ?, ?)').run(
            this.id, b.t, 'damage_summary', JSON.stringify({ side, petId, ...s, damage: Math.round(s.damage), facilityDamage: Math.round(s.facilityDamage) }),
          );
        }
      }
    }

    for (let side = 0; side < 2; side++) {
      this.send(side, {
        type: 'match_end',
        result,
        reason,
        practice: this.practice,
        youWon: result === 'draw' ? null : (result === 'p1') === (side === 0),
        points: [b.players[0].points, b.players[1].points],
        rewards: rewards[side],
        state: this.publicState(side),
      });
    }
    this.onEnd(this);
  }
}

/** 報酬・レート・戦績を一度だけ適用する(トランザクション+rewarded フラグ) */
function applyRewards(matchId, players, battle, result) {
  const prog = battle.snapshot.progression;
  const mm = battle.snapshot.matchmaking;
  const out = [null, null];

  const tx = db.transaction(() => {
    const m = db.prepare('SELECT rewarded FROM matches WHERE id = ?').get(matchId);
    if (!m || m.rewarded) return; // 冪等

    const ratings = [players[0].rating, players[1].rating];
    const scores = result === 'draw' ? [0.5, 0.5] : result === 'p1' ? [1, 0] : [0, 1];
    const newRatings = [0, 1].map(i => {
      const expected = 1 / (1 + 10 ** ((ratings[1 - i] - ratings[i]) / 400));
      return Math.round(ratings[i] + mm.eloK * (scores[i] - expected));
    });

    for (let i = 0; i < 2; i++) {
      const key = scores[i] === 1 ? 'win' : scores[i] === 0 ? 'lose' : 'draw';
      const xpGain = prog.xp[key];
      const coinGain = prog.coins[key];
      const u = db.prepare('SELECT * FROM users WHERE id = ?').get(players[i].userId);
      let { level, xp } = u;
      xp += xpGain;
      let need = prog.levelXp.base + (level - 1) * prog.levelXp.perLevel;
      let levelUps = 0;
      while (xp >= need) {
        xp -= need;
        level++;
        levelUps++;
        need = prog.levelXp.base + (level - 1) * prog.levelXp.perLevel;
      }
      db.prepare(
        `UPDATE users SET xp = ?, level = ?, coins = coins + ?, rating = ?,
         wins = wins + ?, losses = losses + ?, draws = draws + ?, matches_played = matches_played + 1 WHERE id = ?`,
      ).run(xp, level, coinGain, newRatings[i],
        key === 'win' ? 1 : 0, key === 'lose' ? 1 : 0, key === 'draw' ? 1 : 0, players[i].userId);
      out[i] = { xp: xpGain, coins: coinGain, ratingBefore: ratings[i], ratingAfter: newRatings[i], levelUps, level };
    }

    db.prepare(
      `UPDATE matches SET winner_id = ?, result = ?, ended_at = datetime('now'), duration_sec = ?,
       p1_rating_after = ?, p2_rating_after = ?, points_json = ?, rewarded = 1 WHERE id = ?`,
    ).run(
      result === 'p1' ? players[0].userId : result === 'p2' ? players[1].userId : null,
      result, Math.round(battle.t * 10) / 10,
      newRatings[0], newRatings[1],
      JSON.stringify([battle.players[0].points, battle.players[1].points]),
      matchId,
    );
  });
  tx();
  return out;
}

module.exports = { Room };
