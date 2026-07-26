/**
 * Durable Objects の SQLite を better-sqlite3 と同じ形で使えるようにするアダプタ。
 *
 * wrangler の alias で `better-sqlite3` をこのモジュールに差し替えることで、
 * サーバー側のコード(db.js / auth.js / api.js / admin.js …)を無改修のまま
 * Workers 上で動かす。Node 側は本物の better-sqlite3 をそのまま使う。
 *
 * DO の SQL ハンドルは「DOインスタンスが生きている間だけ」存在するため、
 * モジュール読み込み時点では未接続で、DOのコンストラクタで attachSql() する。
 * (db.js の初期化は init() として遅延させてある)
 */

// db.js は CommonJS の require('better-sqlite3') で読み込むため、
// このモジュールも CommonJS 形式(module.exports = クラス)で公開する。
let SQL = null; // SqlStorage
let TXN = null; // ctx.storage.transactionSync

/** DO のコンストラクタから SQL ハンドルを渡す */
function attachSql(sql, transactionSync) {
  SQL = sql;
  TXN = transactionSync;
}

function requireSql() {
  if (!SQL) throw new Error('SQLite が未接続です(attachSql を先に呼んでください)');
  return SQL;
}

/** DO SQLite が受け取れる型へ寄せる(boolean/undefined を許容する) */
function normalize(params) {
  return params.map(p => {
    if (p === undefined) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    if (typeof p === 'bigint') return Number(p);
    return p;
  });
}

const isInsert = sql => /^\s*insert\b/i.test(sql);

class Statement {
  constructor(sql) {
    this.sql = sql;
  }

  get(...params) {
    const rows = requireSql().exec(this.sql, ...normalize(params)).toArray();
    return rows.length > 0 ? rows[0] : undefined;
  }

  all(...params) {
    return requireSql().exec(this.sql, ...normalize(params)).toArray();
  }

  run(...params) {
    const cursor = requireSql().exec(this.sql, ...normalize(params));
    // toArray() を呼ばないと RETURNING 付き文の実行が完了しないため必ず読み切る
    const rows = cursor.toArray();
    const result = { changes: cursor.rowsWritten ?? 0, rows };
    if (isInsert(this.sql)) {
      result.lastInsertRowid = Number(requireSql().exec('SELECT last_insert_rowid() AS id').one().id);
    }
    return result;
  }

  /** better-sqlite3 互換(未使用だが念のため) */
  iterate(...params) {
    return this.all(...params)[Symbol.iterator]();
  }

  pluck() { return this; }
  raw() { return this; }
}

class Database {
  constructor() {
    // 接続文字列(ファイルパス)は DO では意味を持たないため無視する
  }

  prepare(sql) {
    return new Statement(sql);
  }

  /** 複数文をまとめて実行する(スキーマ作成用) */
  exec(sqlText) {
    const sql = requireSql();
    for (const stmt of splitStatements(sqlText)) sql.exec(stmt);
    return this;
  }

  /** DO SQLite は常にWAL相当・外部キーは既定で有効なので何もしない */
  pragma() {
    return [];
  }

  /**
   * better-sqlite3 と同じ「トランザクション化した関数を返す」形。
   * DO では storage.transactionSync() で同期トランザクションを張れる。
   */
  transaction(fn) {
    return (...args) => {
      if (!TXN) return fn(...args);
      let out;
      TXN(() => { out = fn(...args); });
      return out;
    };
  }

  close() {}
}

/** 素朴な複数文分割(文字列リテラル内のセミコロンを無視する) */
function splitStatements(text) {
  const out = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
      cur += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; cur += c; continue; }
    if (c === ';') {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

module.exports = Database;
module.exports.attachSql = attachSql;
