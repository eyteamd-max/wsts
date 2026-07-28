#!/usr/bin/env node
// scripts/import-initial.mjs
// 首次部署后将生产环境 JSON 导入 D1（mods_prod + mods_staging）
//
// 用法：
//   cd modsync-worker
//   node ../scripts/import-initial.mjs           # 默认从 ../resources/json/post/sts2_mods 读取
//   node ../scripts/import-initial.mjs --db=sts2_modsync --remote   # 远程 D1
//   node ../scripts/import-initial.mjs --dry-run                    # 仅生成 SQL，不执行
//
// 前置条件：
//   1. 已通过 `wrangler d1 create sts2_modsync` 创建数据库
//   2. wrangler.toml 中 database_id 已填入
//   3. 已部署 Worker 一次（确保 ensureSchema 建表）或手动执行过 schema.sql
//
// 注意：本脚本会先清空 mods_prod / mods_staging 再导入（幂等）。
// 重复运行不会产生重复数据，但会覆盖手动在 staging 中做的修改。
// 如需保留 staging 改动，请加 --no-truncate 参数。

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ---------- 解析命令行参数 ----------
const args = process.argv.slice(2);
const opts = {
  db: 'sts2_modsync',
  remote: false,
  dryRun: false,
  noTruncate: false,
  source: resolve(ROOT, 'resources/json/post/sts2_mods'),
};
for (const a of args) {
  if (a.startsWith('--db=')) opts.db = a.slice(5);
  else if (a === '--remote') opts.remote = true;
  else if (a === '--dry-run') opts.dryRun = true;
  else if (a === '--no-truncate') opts.noTruncate = true;
  else if (a.startsWith('--source=')) opts.source = resolve(ROOT, a.slice(9));
}

// ---------- 读取 manifest 并加载所有 JSON ----------
function loadAllMods(sourceDir) {
  const manifestPath = join(sourceDir, 'manifest.json');
  let indices = [1];
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    const rangeStr = manifest.sts2_mods || manifest.all || '1~1';
    const m = String(rangeStr).match(/^(\d+)~(\d+)$/);
    if (m) {
      const start = parseInt(m[1], 10);
      const end = parseInt(m[2], 10);
      indices = [];
      for (let i = start; i <= end; i++) indices.push(i);
    }
  }
  const all = [];
  for (const idx of indices) {
    const file = join(sourceDir, `sts2_mods_${idx}.json`);
    if (!existsSync(file)) {
      console.warn(`[warn] 文件不存在，跳过: ${file}`);
      continue;
    }
    const data = JSON.parse(readFileSync(file, 'utf-8'));
    if (!Array.isArray(data)) {
      console.warn(`[warn] 非 JSON 数组，跳过: ${file}`);
      continue;
    }
    console.log(`[info] 加载 ${file}: ${data.length} 条`);
    all.push(...data);
  }
  return all;
}

// ---------- 生成 SQL ----------
// D1 执行 SQL 时，字符串需要单引号转义（单引号 → 两个单引号）
function sqlEscape(s) {
  return String(s == null ? '' : s).replace(/'/g, "''");
}

function buildInsertSql(table, mod, extraCols = {}) {
  const rid = sqlEscape(mod.rid);
  const title = sqlEscape(mod.title);
  const badge = sqlEscape(mod.badge);
  const size = sqlEscape(mod.size);
  const date = sqlEscape(mod.date);
  const tags = sqlEscape(Array.isArray(mod.tags) ? mod.tags.join(',') : (mod.tags || ''));
  const description = sqlEscape(mod.description);
  const author = sqlEscape(mod.author);
  const dataJson = sqlEscape(JSON.stringify(mod));
  const cols = ['rid', 'title', 'badge', 'size', 'date', 'tags', 'description', 'author', 'data_json'];
  const vals = [rid, title, badge, size, date, tags, description, author, dataJson];
  for (const [k, v] of Object.entries(extraCols)) {
    cols.push(k);
    vals.push(sqlEscape(v));
  }
  return `INSERT INTO ${table} (${cols.join(', ')}) VALUES ('${vals.join("', '")}');`;
}

function generateSql(mods) {
  const lines = [];
  lines.push('-- 自动生成：由 scripts/import-initial.mjs 生成');
  lines.push(`-- 生成时间: ${new Date().toISOString()}`);
  lines.push(`-- 模组数量: ${mods.length}`);
  lines.push('');
  if (!opts.noTruncate) {
    lines.push('DELETE FROM mods_prod;');
    lines.push('DELETE FROM mods_staging;');
    lines.push('');
  }
  const now = new Date().toISOString();
  for (const mod of mods) {
    if (!mod || !mod.rid) {
      console.warn('[warn] 跳过缺少 rid 的条目');
      continue;
    }
    lines.push(buildInsertSql('mods_prod', mod, { synced_at: now }));
    lines.push(buildInsertSql('mods_staging', mod, { updated_at: now, updated_by: 'import-initial' }));
  }
  lines.push('');
  lines.push('-- 完成');
  return lines.join('\n');
}

// ---------- 主流程 ----------
function main() {
  console.log('[info] 数据源目录:', opts.source);
  if (!existsSync(opts.source)) {
    console.error(`[error] 目录不存在: ${opts.source}`);
    process.exit(1);
  }

  const mods = loadAllMods(opts.source);
  console.log(`[info] 共加载 ${mods.length} 个模组`);

  if (!mods.length) {
    console.error('[error] 没有加载到任何模组数据');
    process.exit(1);
  }

  const sql = generateSql(mods);
  const sqlFile = resolve(__dirname, 'import-initial.sql');
  writeFileSync(sqlFile, sql, 'utf-8');
  console.log(`[info] SQL 已写入: ${sqlFile} (${sql.length} 字符)`);

  if (opts.dryRun) {
    console.log('[info] --dry-run 模式，不执行。SQL 文件已生成，可手动执行：');
    console.log(`  wrangler d1 execute ${opts.db} ${opts.remote ? '--remote' : '--local'} --file=${sqlFile}`);
    return;
  }

  // 通过 wrangler d1 execute 执行
  const cmd = `wrangler d1 execute ${opts.db} ${opts.remote ? '--remote' : '--local'} --file="${sqlFile}"`;
  console.log('[info] 执行:', cmd);
  try {
    execSync(cmd, { stdio: 'inherit', cwd: resolve(__dirname, '..', 'modsync-worker') });
    console.log('[info] 导入成功！');
  } catch (e) {
    console.error('[error] wrangler 执行失败:', e.message);
    console.error('[hint] 可检查 SQL 文件后手动执行：');
    console.error(`  wrangler d1 execute ${opts.db} ${opts.remote ? '--remote' : '--local'} --file="${sqlFile}"`);
    process.exit(1);
  }
}

main();
