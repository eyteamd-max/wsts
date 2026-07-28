// db.js — D1 查询封装
// 与现有 cmt worker 接口风格一致：all / first / run / batch

export async function all(env, sql, params = []) {
  const stmt = env.DB.prepare(sql);
  const result = params.length ? await stmt.bind(...params).all() : await stmt.all();
  return result.results || [];
}

export async function first(env, sql, params = []) {
  const stmt = env.DB.prepare(sql);
  const result = params.length ? await stmt.bind(...params).first() : await stmt.first();
  return result;
}

export async function run(env, sql, params = []) {
  const stmt = env.DB.prepare(sql);
  const result = params.length ? await stmt.bind(...params).run() : await stmt.run();
  return result;
}

export async function batch(env, statements) {
  return await env.DB.batch(statements.map(s => env.DB.prepare(s.sql).bind(...(s.params || []))));
}

// 建表（幂等，首次部署后由 index.js 启动时调用）
export async function ensureSchema(env) {
  const sqls = [
    `CREATE TABLE IF NOT EXISTS mods_prod (
      rid TEXT PRIMARY KEY, title TEXT, badge TEXT, size TEXT, date TEXT,
      tags TEXT, description TEXT, author TEXT, data_json TEXT NOT NULL, synced_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS mods_staging (
      rid TEXT PRIMARY KEY, title TEXT, badge TEXT, size TEXT, date TEXT,
      tags TEXT, description TEXT, author TEXT, data_json TEXT NOT NULL,
      updated_at TEXT NOT NULL, updated_by TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS mod_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT, rid TEXT NOT NULL, source_type TEXT NOT NULL,
      source_id TEXT, source_url TEXT NOT NULL, last_seen_updated_at INTEGER, last_checked_at TEXT,
      UNIQUE(rid, source_type, source_id)
    )`,
    `CREATE TABLE IF NOT EXISTS pending_updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT, rid TEXT NOT NULL, source_type TEXT NOT NULL,
      detected_at TEXT NOT NULL, old_version TEXT, new_version TEXT, payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', reviewed_at TEXT, reviewed_by TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_pending_status ON pending_updates(status)`,
    `CREATE TABLE IF NOT EXISTS promotions_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, promoted_at TEXT NOT NULL, by_user TEXT NOT NULL,
      commit_sha TEXT, mods_count INTEGER, snapshot_json TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, rid TEXT, submitter_name TEXT, submitter_contact TEXT,
      new_version TEXT, download_url TEXT, notes TEXT, status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status)`,
  ];
  for (const sql of sqls) {
    await env.DB.prepare(sql).run();
  }
}
