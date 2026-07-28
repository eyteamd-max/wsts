-- sts2_modsync 数据库表结构
-- 首次部署后通过 `wrangler d1 execute sts2_modsync --file=src/schema.sql` 执行

-- 生产模组数据镜像（用于 diff）
CREATE TABLE IF NOT EXISTS mods_prod (
  rid TEXT PRIMARY KEY,
  title TEXT,
  badge TEXT,
  size TEXT,
  date TEXT,
  tags TEXT,
  description TEXT,
  author TEXT,
  data_json TEXT NOT NULL,
  synced_at TEXT NOT NULL
);

-- 测试模组数据（可编辑）
CREATE TABLE IF NOT EXISTS mods_staging (
  rid TEXT PRIMARY KEY,
  title TEXT,
  badge TEXT,
  size TEXT,
  date TEXT,
  tags TEXT,
  description TEXT,
  author TEXT,
  data_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);

-- 模组来源（用于自动轮询）
CREATE TABLE IF NOT EXISTS mod_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rid TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT,
  source_url TEXT NOT NULL,
  last_seen_updated_at INTEGER,
  last_checked_at TEXT,
  UNIQUE(rid, source_type, source_id)
);

-- 待审核更新（自动检测 + 人工提交合并视图）
CREATE TABLE IF NOT EXISTS pending_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rid TEXT NOT NULL,
  source_type TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  old_version TEXT,
  new_version TEXT,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  reviewed_at TEXT,
  reviewed_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_pending_status ON pending_updates(status);

-- 迁移日志（审计）
CREATE TABLE IF NOT EXISTS promotions_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  promoted_at TEXT NOT NULL,
  by_user TEXT NOT NULL,
  commit_sha TEXT,
  mods_count INTEGER,
  snapshot_json TEXT NOT NULL
);

-- 人工提交（B站/QQ 来源）
CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rid TEXT,
  submitter_name TEXT,
  submitter_contact TEXT,
  new_version TEXT,
  download_url TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status);
