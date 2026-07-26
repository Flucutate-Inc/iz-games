/**
 * マッチング: レーティング主軸+待機時間で許容差拡大+初心者保護+連続同一相手抑制。
 * ルームコード対戦も提供する(設計書 6.4)。
 */
const crypto = require('crypto');
const db = require('./db');
const balance = require('./balance');
const { Room } = require('./room');
const { Bot, BOT_DECK } = require('./bot');

const queue = []; // {userId, name, rating, matchesPlayed, deck, ws, joinedAt}
const roomCodes = new Map(); // code -> entry
const activeRooms = new Map(); // matchId -> Room
const userRoom = new Map(); // userId -> Room
const lastOpponent = new Map(); // userId -> {opponentId, at}

function selectedDeck(userId) {
  const deck = db.prepare('SELECT * FROM decks WHERE user_id = ? AND selected = 1').get(userId);
  if (!deck) return null;
  const pets = JSON.parse(deck.pets_json);
  const rules = balance.getPublished().snapshot.rules;
  if (pets.length < rules.deck.min || pets.length > rules.deck.max) return null;
  return pets;
}

function makeEntry(user, ws) {
  const deck = selectedDeck(user.id);
  if (!deck) return { error: `有効なデッキが選択されていません` };
  return {
    userId: user.id,
    name: user.name,
    rating: user.rating,
    matchesPlayed: user.matches_played,
    deck,
    ws,
    joinedAt: Date.now(),
  };
}

function joinQueue(user, ws) {
  if (userRoom.has(user.id)) return { error: '対戦中です' };
  if (queue.some(e => e.userId === user.id)) return { error: 'すでにマッチング中です' };
  const entry = makeEntry(user, ws);
  if (entry.error) return entry;
  queue.push(entry);
  return { ok: true };
}

function leaveQueue(userId) {
  const i = queue.findIndex(e => e.userId === userId);
  if (i >= 0) queue.splice(i, 1);
  for (const [code, entry] of roomCodes) {
    if (entry.userId === userId) roomCodes.delete(code);
  }
}

/** 1秒ごとにキューを走査してペアリング */
function pump() {
  const mm = balance.getPublished().snapshot.matchmaking;
  const now = Date.now();
  for (let i = 0; i < queue.length; i++) {
    for (let j = i + 1; j < queue.length; j++) {
      const a = queue[i];
      const b = queue[j];
      const waitSec = (now - Math.min(a.joinedAt, b.joinedAt)) / 1000;
      const allowed = mm.ratingWindowStart + Math.floor(waitSec / 5) * mm.ratingWindowGrowPer5Sec;
      if (Math.abs(a.rating - b.rating) > allowed) continue;
      // 初心者保護: 初心者(規定試合数未満)は待機30秒までは初心者同士のみ
      const aNew = a.matchesPlayed < mm.newbieMatchCount;
      const bNew = b.matchesPlayed < mm.newbieMatchCount;
      if (aNew !== bNew && waitSec < 30) continue;
      // 同一相手との短期連続マッチ抑制(3分・他候補がいる場合のみ)
      const last = lastOpponent.get(a.userId);
      if (last && last.opponentId === b.userId && now - last.at < 180000 && queue.length > 2) continue;

      queue.splice(j, 1);
      queue.splice(i, 1);
      startMatch(a, b);
      return pump(); // ペア成立後は残りを再走査
    }
  }
}
setInterval(pump, 1000).unref();

function createRoomCode(user, ws) {
  if (userRoom.has(user.id)) return { error: '対戦中です' };
  const entry = makeEntry(user, ws);
  if (entry.error) return entry;
  leaveQueue(user.id);
  const code = crypto.randomInt(0, 1000000).toString().padStart(6, '0');
  roomCodes.set(code, entry);
  return { ok: true, code };
}

function joinRoomCode(user, ws, code) {
  const host = roomCodes.get(code);
  if (!host) return { error: 'ルームが見つかりません' };
  if (host.userId === user.id) return { error: '自分のルームには参加できません' };
  const entry = makeEntry(user, ws);
  if (entry.error) return entry;
  roomCodes.delete(code);
  startMatch(host, entry);
  return { ok: true };
}

function startMatch(a, b) {
  // マッチ成立時点の published 版を固定(VERSION-01)
  const version = balance.getPublished();
  const room = new Room([a, b], version, r => {
    activeRooms.delete(r.id);
    for (const p of r.players) userRoom.delete(p.userId);
  });
  activeRooms.set(room.id, room);
  userRoom.set(a.userId, room);
  userRoom.set(b.userId, room);
  lastOpponent.set(a.userId, { opponentId: b.userId, at: Date.now() });
  lastOpponent.set(b.userId, { opponentId: a.userId, at: Date.now() });
}

/** 練習用CPU戦を開始する(報酬・レート・記録なし) */
function startPractice(user, ws) {
  if (userRoom.has(user.id)) return { error: '対戦中です' };
  const entry = makeEntry(user, ws);
  if (entry.error) return entry;
  leaveQueue(user.id);
  const version = balance.getPublished();
  const botEntry = {
    userId: -1,
    name: 'CPUわんこ(練習)',
    rating: user.rating,
    deck: BOT_DECK,
    ws: null,
    matchesPlayed: 0,
    bot: true,
  };
  const room = new Room([entry, botEntry], version, r => {
    activeRooms.delete(r.id);
    userRoom.delete(user.id);
  }, { practice: true });
  room.bot = new Bot(room.battle, 1);
  activeRooms.set(room.id, room);
  userRoom.set(user.id, room);
  return { ok: true };
}

function roomOf(userId) {
  return userRoom.get(userId) || null;
}

/** 管理画面の稼働状況用: 待機列(あいことば待ちを除く) */
function queueInfo() {
  const now = Date.now();
  return queue.map(e => ({
    userId: e.userId,
    name: e.name,
    rating: e.rating,
    waitSec: Math.round((now - e.joinedAt) / 1000),
  }));
}

/** 管理画面の稼働状況用: 発行済みのあいことば(コードは伏せる) */
function roomCodeInfo() {
  const now = Date.now();
  return [...roomCodes.values()].map(e => ({
    userId: e.userId,
    name: e.name,
    waitSec: Math.round((now - e.joinedAt) / 1000),
  }));
}

module.exports = {
  joinQueue, leaveQueue, createRoomCode, joinRoomCode, startPractice, roomOf,
  activeRooms, queueInfo, roomCodeInfo,
};
