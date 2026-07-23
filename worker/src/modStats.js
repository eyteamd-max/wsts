// modStats.js — 帖子查看/下载量统计
import { all, first, run } from './db.js';
import { json, err } from './utils.js';
import * as kvCache from './kvCache.js';

// POST /api/mod-stats/:rid/view  — 查看量 +1（不要求登录）
export async function view(req, env, params) {
  const rid = String(params.rid || '').trim();
  if (!rid) return err(400, '缺少 rid', req);
  await run(
    env,
    `INSERT INTO mod_stats (rid, view_count) VALUES (?, 1)
     ON CONFLICT(rid) DO UPDATE SET view_count = view_count + 1, updated_at = datetime('now')`,
    [rid]
  );
  await kvCache.del(env, 'modstats:' + rid);
  return json({ ok: true }, {}, req);
}

// POST /api/mod-stats/:rid/download  — 下载量 +1（不要求登录）
export async function download(req, env, params) {
  const rid = String(params.rid || '').trim();
  if (!rid) return err(400, '缺少 rid', req);
  await run(
    env,
    `INSERT INTO mod_stats (rid, download_count) VALUES (?, 1)
     ON CONFLICT(rid) DO UPDATE SET download_count = download_count + 1, updated_at = datetime('now')`,
    [rid]
  );
  await kvCache.del(env, 'modstats:' + rid);
  return json({ ok: true }, {}, req);
}

// GET /api/mod-stats/:rid  — 查询单个统计
export async function get(req, env, params) {
  const rid = String(params.rid || '').trim();
  if (!rid) return err(400, '缺少 rid', req);
  const cached = await kvCache.get(env, 'modstats:' + rid);
  if (cached) {
    return json({ rid, viewCount: cached.viewCount, downloadCount: cached.downloadCount }, { headers: { 'X-Cache': 'HIT' } }, req);
  }
  const row = await first(env, 'SELECT rid, view_count, download_count FROM mod_stats WHERE rid = ?', [rid]);
  const viewCount = row ? row.view_count : 0;
  const downloadCount = row ? row.download_count : 0;
  await kvCache.set(env, 'modstats:' + rid, { viewCount, downloadCount }, 300);
  return json({
    rid,
    viewCount,
    downloadCount,
  }, { headers: { 'X-Cache': 'MISS' } }, req);
}

// GET /api/mod-stats?rids=r1,r2,r3  — 批量查询
export async function batch(req, env) {
  const url = new URL(req.url);
  const ridsParam = url.searchParams.get('rids') || '';
  const rids = ridsParam.split(',').map(s => s.trim()).filter(Boolean);
  if (!rids.length) return json({ stats: [] }, {}, req);

  const cacheMap = {};
  const missRids = [];
  let allHit = true;

  for (const rid of rids) {
    const cached = await kvCache.get(env, 'modstats:' + rid);
    if (cached) {
      cacheMap[rid] = cached;
    } else {
      missRids.push(rid);
      allHit = false;
    }
  }

  if (missRids.length > 0) {
    const ph = missRids.map(() => '?').join(',');
    const rows = await all(env, `SELECT rid, view_count, download_count FROM mod_stats WHERE rid IN (${ph})`, missRids);
    const dbMap = {};
    const cacheWrites = [];
    rows.forEach(r => {
      const viewCount = r.view_count;
      const downloadCount = r.download_count;
      dbMap[r.rid] = { viewCount, downloadCount };
      cacheWrites.push(kvCache.set(env, 'modstats:' + r.rid, { viewCount, downloadCount }, 300));
    });
    Promise.all(cacheWrites).catch(() => {});
    for (const rid of missRids) {
      cacheMap[rid] = dbMap[rid] || { viewCount: 0, downloadCount: 0 };
    }
  }

  const stats = rids.map(r => ({ rid: r, viewCount: cacheMap[r].viewCount, downloadCount: cacheMap[r].downloadCount }));
  return json({ stats }, { headers: { 'X-Cache': allHit ? 'HIT' : 'MISS' } }, req);
}
