// publicApi.js — 公开只读 API：GET /api/mods?env=staging|prod
import { all } from './db.js';
import { json, err } from './utils.js';
import * as kvCache from './kvCache.js';

// GET /api/mods?env=staging|prod&category=all|skin
export async function mods(req, env) {
  const url = new URL(req.url);
  const envName = (url.searchParams.get('env') || 'staging').toLowerCase();
  const category = (url.searchParams.get('category') || 'all').toLowerCase();

  if (envName !== 'staging' && envName !== 'prod') {
    return err(400, 'env 参数必须是 staging 或 prod', req);
  }

  const table = envName === 'staging' ? 'mods_staging' : 'mods_prod';
  const cacheKey = `mods:${envName}:${category}`;

  const cached = await kvCache.get(env, cacheKey);
  if (cached) {
    return json(cached, { headers: { 'X-Cache': 'HIT' } }, req);
  }

  // category=skin 暂时复用 sts2_mods 数据（O.o_interface 暂未纳入同步）
  // 后续可扩展独立的 staging 表
  const rows = await all(env, `SELECT data_json FROM ${table} ORDER BY date DESC`);
  const list = rows
    .map(r => {
      try { return JSON.parse(r.data_json); } catch { return null; }
    })
    .filter(Boolean);

  await kvCache.set(env, cacheKey, list, 60);
  return json(list, { headers: { 'X-Cache': 'MISS' } }, req);
}

// GET /api/mods/:rid?env=staging|prod — 单个模组
export async function modByRid(req, env, params) {
  const rid = String(params.rid || '').trim();
  if (!rid) return err(400, '缺少 rid', req);
  const url = new URL(req.url);
  const envName = (url.searchParams.get('env') || 'staging').toLowerCase();
  const table = envName === 'staging' ? 'mods_staging' : 'mods_prod';
  const { first } = await import('./db.js');
  const row = await first(env, `SELECT data_json FROM ${table} WHERE rid = ?`, [rid]);
  if (!row) return err(404, '模组不存在', req);
  try {
    return json(JSON.parse(row.data_json), {}, req);
  } catch {
    return err(500, '模组数据解析失败', req);
  }
}
