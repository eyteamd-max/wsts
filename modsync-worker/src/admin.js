// admin.js — 管理 API（需 requireAdmin）
import { all, first, run } from './db.js';
import { json, err, parseBody, requireAdmin, nowIso, HttpError } from './utils.js';
import * as kvCache from './kvCache.js';
import { extractWorkshopId } from './steam.js';

// ---------- 待审核更新 ----------

// GET /api/admin/pending — 合并 pending_updates（steam 自动）+ submissions（人工）
export async function pending(req, env) {
  await requireAdmin(req, env);
  const [autoRows, manualRows] = await Promise.all([
    all(env, `SELECT id, rid, source_type, detected_at, old_version, new_version, payload_json, status FROM pending_updates WHERE status = 'pending' ORDER BY detected_at DESC LIMIT 200`),
    all(env, `SELECT id, rid, submitter_name, new_version, download_url, notes, created_at FROM submissions WHERE status = 'pending' ORDER BY created_at DESC LIMIT 200`),
  ]);

  const auto = autoRows.map(r => {
    let payload = {};
    try { payload = JSON.parse(r.payload_json); } catch {}
    return {
      id: r.id, kind: 'auto', rid: r.rid, sourceType: r.source_type,
      detectedAt: r.detected_at, oldVersion: r.old_version, newVersion: r.new_version,
      payload,
    };
  });
  const manual = manualRows.map(r => ({
    id: r.id, kind: 'manual', rid: r.rid, submitterName: r.submitter_name,
    newVersion: r.new_version, downloadUrl: r.download_url, notes: r.notes,
    detectedAt: r.created_at,
  }));

  return json({ auto, manual, total: auto.length + manual.length }, {}, req);
}

// POST /api/admin/pending/:id/approve — 通过自动检测的更新（将 payload 应用到 staging）
// body: { applyFields: { badge?, date?, size?, description?, downloadLink? } }
export async function approvePending(req, env, params) {
  const admin = await requireAdmin(req, env);
  const id = Number(params.id);
  if (!id) return err(400, '无效的 id', req);
  const p = await first(env, `SELECT * FROM pending_updates WHERE id = ?`, [id]);
  if (!p) return err(404, '待审核条目不存在', req);
  if (p.status !== 'pending') return err(400, '该条目已处理', req);

  const body = await parseBody(req);
  const applyFields = body.applyFields || {};

  if (p.rid && Object.keys(applyFields).length) {
    const row = await first(env, `SELECT data_json FROM mods_staging WHERE rid = ?`, [p.rid]);
    if (!row) return err(404, `staging 中找不到 rid=${p.rid}`, req);
    const mod = JSON.parse(row.data_json);

    if (applyFields.badge) mod.badge = applyFields.badge;
    if (applyFields.date) mod.date = applyFields.date;
    if (applyFields.size) mod.size = applyFields.size;
    if (applyFields.description) mod.description = applyFields.description;

    if (applyFields.downloadLink) {
      if (!Array.isArray(mod.downloadLinks)) mod.downloadLinks = [];
      const dl = applyFields.downloadLink;
      let payload = {};
      try { payload = JSON.parse(p.payload_json); } catch {}
      mod.downloadLinks.push({
        text: dl.text || `Steam 创意工坊更新`,
        url: dl.url || payload.workshop_url,
        category: dl.category || 'alternative',
        version: dl.version,
        size: dl.size,
        date: dl.date || new Date().toISOString().slice(0, 10),
      });
    }

    await run(env,
      `UPDATE mods_staging SET data_json = ?, badge = ?, date = ?, size = ?, description = ?, updated_at = ?, updated_by = ? WHERE rid = ?`,
      [JSON.stringify(mod), mod.badge || null, mod.date || null, mod.size || null, mod.description || null, nowIso(), admin.nickname, p.rid]
    );
    await kvCache.del(env, 'mods:staging:all');
  }

  await run(env, `UPDATE pending_updates SET status = 'approved', reviewed_at = ?, reviewed_by = ? WHERE id = ?`,
    [nowIso(), admin.nickname, id]);
  return json({ ok: true, id, status: 'approved' }, {}, req);
}

// POST /api/admin/pending/:id/reject
export async function rejectPending(req, env, params) {
  const admin = await requireAdmin(req, env);
  const id = Number(params.id);
  if (!id) return err(400, '无效的 id', req);
  await run(env, `UPDATE pending_updates SET status = 'rejected', reviewed_at = ?, reviewed_by = ? WHERE id = ?`,
    [nowIso(), admin.nickname, id]);
  return json({ ok: true, id, status: 'rejected' }, {}, req);
}

// ---------- 模组 CRUD ----------

// GET /api/admin/mods?q=&page=&pageSize= — 测试环境模组列表（分页/搜索）
export async function listMods(req, env) {
  await requireAdmin(req, env);
  const url = new URL(req.url);
  const q = (url.searchParams.get('q') || '').trim();
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
  const pageSize = Math.min(100, Math.max(10, parseInt(url.searchParams.get('pageSize') || '20', 10)));
  const offset = (page - 1) * pageSize;

  let where = '';
  const params = [];
  if (q) {
    where = `WHERE title LIKE ? OR rid LIKE ? OR author LIKE ? OR tags LIKE ?`;
    const kw = `%${q}%`;
    params.push(kw, kw, kw, kw);
  }
  const totalRow = await first(env, `SELECT COUNT(*) AS c FROM mods_staging ${where}`, params);
  const total = totalRow ? totalRow.c : 0;
  const rows = await all(env,
    `SELECT rid, title, badge, size, date, author, tags, updated_at FROM mods_staging ${where} ORDER BY date DESC, rid DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );
  return json({ list: rows, total, page, pageSize }, {}, req);
}

// GET /api/admin/mods/:rid — 单个模组完整数据
export async function getMod(req, env, params) {
  await requireAdmin(req, env);
  const rid = String(params.rid || '').trim();
  if (!rid) return err(400, '缺少 rid', req);
  const row = await first(env, `SELECT data_json, updated_at, updated_by FROM mods_staging WHERE rid = ?`, [rid]);
  if (!row) return err(404, '模组不存在', req);
  try {
    const mod = JSON.parse(row.data_json);
    return json({ mod, updatedAt: row.updated_at, updatedBy: row.updated_by }, {}, req);
  } catch {
    return err(500, '模组数据解析失败', req);
  }
}

// PUT /api/admin/mods/:rid — 全量替换模组数据
// body: { mod: <完整 mod 对象> }
export async function updateMod(req, env, params) {
  const admin = await requireAdmin(req, env);
  const rid = String(params.rid || '').trim();
  if (!rid) return err(400, '缺少 rid', req);
  const body = await parseBody(req);
  const mod = body.mod;
  if (!mod || typeof mod !== 'object') return err(400, 'body.mod 必须是模组对象', req);
  if (String(mod.rid || '').trim() !== rid) return err(400, 'body.mod.rid 与路径不一致', req);

  const dataJson = JSON.stringify(mod);
  const result = await run(env,
    `UPDATE mods_staging SET title=?, badge=?, size=?, date=?, tags=?, description=?, author=?, data_json=?, updated_at=?, updated_by=? WHERE rid=?`,
    [mod.title || null, mod.badge || null, mod.size || null, mod.date || null,
     Array.isArray(mod.tags) ? mod.tags.join(',') : (mod.tags || null),
     mod.description || null, mod.author || null, dataJson, nowIso(), admin.nickname, rid]
  );

  if (!result.meta || result.meta.changes === 0) {
    return err(404, `staging 中找不到 rid=${rid}，请用 POST 新增`, req);
  }
  await kvCache.del(env, 'mods:staging:all');
  return json({ ok: true, rid }, {}, req);
}

// POST /api/admin/mods — 新增模组
export async function createMod(req, env) {
  const admin = await requireAdmin(req, env);
  const body = await parseBody(req);
  const mod = body.mod;
  if (!mod || typeof mod !== 'object') return err(400, 'body.mod 必须是模组对象', req);
  const rid = String(mod.rid || '').trim();
  if (!rid) return err(400, 'mod.rid 必填', req);

  const exists = await first(env, `SELECT rid FROM mods_staging WHERE rid = ?`, [rid]);
  if (exists) return err(409, `rid=${rid} 已存在，请用 PUT 更新`, req);

  const dataJson = JSON.stringify(mod);
  await run(env,
    `INSERT INTO mods_staging (rid, title, badge, size, date, tags, description, author, data_json, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [rid, mod.title || null, mod.badge || null, mod.size || null, mod.date || null,
     Array.isArray(mod.tags) ? mod.tags.join(',') : (mod.tags || null),
     mod.description || null, mod.author || null, dataJson, nowIso(), admin.nickname]
  );
  await kvCache.del(env, 'mods:staging:all');
  return json({ ok: true, rid }, { status: 201 }, req);
}

// DELETE /api/admin/mods/:rid — 从 staging 删除（不删 prod）
export async function deleteMod(req, env, params) {
  const admin = await requireAdmin(req, env);
  const rid = String(params.rid || '').trim();
  if (!rid) return err(400, '缺少 rid', req);
  await run(env, `DELETE FROM mods_staging WHERE rid = ?`, [rid]);
  await run(env, `DELETE FROM mod_sources WHERE rid = ?`, [rid]);
  await kvCache.del(env, 'mods:staging:all');
  return json({ ok: true, rid, deletedBy: admin.nickname }, {}, req);
}

// ---------- 模组来源管理 ----------

// GET /api/admin/sources?rid=
export async function listSources(req, env) {
  await requireAdmin(req, env);
  const url = new URL(req.url);
  const rid = url.searchParams.get('rid');
  let rows;
  if (rid) {
    rows = await all(env, `SELECT id, rid, source_type, source_id, source_url, last_seen_updated_at, last_checked_at FROM mod_sources WHERE rid = ? ORDER BY id`, [rid]);
  } else {
    rows = await all(env, `SELECT id, rid, source_type, source_id, source_url, last_seen_updated_at, last_checked_at FROM mod_sources ORDER BY id DESC LIMIT 500`);
  }
  return json({ list: rows, total: rows.length }, {}, req);
}

// POST /api/admin/sources — 添加来源
// body: { rid, sourceType, sourceUrl } — sourceId 从 url 自动提取
export async function addSource(req, env) {
  await requireAdmin(req, env);
  const body = await parseBody(req);
  const rid = String(body.rid || '').trim();
  const sourceType = String(body.sourceType || '').trim();
  const sourceUrl = String(body.sourceUrl || '').trim();
  if (!rid || !sourceType || !sourceUrl) return err(400, 'rid / sourceType / sourceUrl 必填', req);
  if (!['steam', 'github', 'zoho', 'manual'].includes(sourceType)) return err(400, 'sourceType 必须是 steam/github/zoho/manual', req);

  let sourceId = null;
  if (sourceType === 'steam') sourceId = extractWorkshopId(sourceUrl);
  if (sourceType === 'steam' && !sourceId) return err(400, 'Steam 来源 URL 中未识别到 id 参数', req);

  try {
    await run(env,
      `INSERT INTO mod_sources (rid, source_type, source_id, source_url, last_checked_at) VALUES (?, ?, ?, ?, ?)`,
      [rid, sourceType, sourceId, sourceUrl, nowIso()]
    );
  } catch (e) {
    if (String(e.message || '').includes('UNIQUE')) return err(409, '该来源已存在', req);
    throw e;
  }
  return json({ ok: true, rid, sourceType, sourceId }, { status: 201 }, req);
}

// DELETE /api/admin/sources/:id
export async function deleteSource(req, env, params) {
  await requireAdmin(req, env);
  const id = Number(params.id);
  if (!id) return err(400, '无效的 id', req);
  await run(env, `DELETE FROM mod_sources WHERE id = ?`, [id]);
  return json({ ok: true, id }, {}, req);
}

// ---------- 重新同步 prod 镜像 ----------
// POST /api/admin/resync-prod — 从 GitHub 拉取当前生产 JSON，覆盖 mods_prod
export async function resyncProd(req, env) {
  const admin = await requireAdmin(req, env);
  if (!env.GH_TOKEN) return err(500, '未配置 GH_TOKEN', req);
  if (!env.GITHUB_REPO || env.GITHUB_REPO.includes('<')) return err(500, '未配置 GITHUB_REPO', req);

  const branch = env.GITHUB_BRANCH || 'main';
  const path = env.GITHUB_MOD_FILE_PATH || 'resources/json/post/sts2_mods/sts2_mods_1.json';
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}?ref=${branch}`;
  const resp = await fetch(url, {
    headers: { 'Authorization': `Bearer ${env.GH_TOKEN}`, 'Accept': 'application/vnd.github+json', 'User-Agent': 'sts2-modsync-worker' },
  });
  if (!resp.ok) return err(502, `拉取 GitHub 文件失败 ${resp.status}`, req);
  const data = await resp.json();
  const content = atob(data.content.replace(/\n/g, ''));
  let list;
  try { list = JSON.parse(content); } catch { return err(500, '生产 JSON 解析失败', req); }

  await run(env, `DELETE FROM mods_prod`);
  let inserted = 0;
  for (const mod of list) {
    if (!mod || !mod.rid) continue;
    await run(env,
      `INSERT INTO mods_prod (rid, title, badge, size, date, tags, description, author, data_json, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [String(mod.rid), mod.title || null, mod.badge || null, mod.size || null, mod.date || null,
       Array.isArray(mod.tags) ? mod.tags.join(',') : (mod.tags || null),
       mod.description || null, mod.author || null, JSON.stringify(mod), nowIso()]
    );
    inserted++;
  }
  await kvCache.del(env, 'mods:prod:all');
  return json({ ok: true, synced: inserted, by: admin.nickname }, {}, req);
}
