// submission.js — 人工提交表单（B站/QQ群/作者私发来源）
import { all, run, first } from './db.js';
import { json, err, parseBody, nowIso, clientIpHash, requireAdmin } from './utils.js';

// 简易限频：每个 IP 每小时最多 10 次提交（基于 D1 计数）
async function checkRateLimit(env, ipHash) {
  const oneHourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
  const row = await first(env,
    `SELECT COUNT(*) AS c FROM submissions WHERE created_at > ? AND submitter_contact LIKE ?`,
    [oneHourAgo, `%${ipHash}%`]
  );
  if (row && row.c >= 10) {
    return false;
  }
  return true;
}

// POST /api/submit — 公开接口，模组作者提交新版本通知
export async function submit(req, env) {
  const body = await parseBody(req);
  const rid = String(body.rid || '').trim().slice(0, 32);
  const submitterName = String(body.submitterName || '').trim().slice(0, 64);
  const submitterContact = String(body.submitterContact || '').trim().slice(0, 200);
  const newVersion = String(body.newVersion || '').trim().slice(0, 64);
  const downloadUrl = String(body.downloadUrl || '').trim().slice(0, 2048);
  const notes = String(body.notes || '').trim().slice(0, 2000);

  if (!submitterName) return err(400, '请填写提交者名称', req);
  if (!newVersion && !downloadUrl && !notes) return err(400, '至少填写新版本号 / 下载链接 / 备注之一', req);

  const ipHash = await clientIpHash(req);
  const allowed = await checkRateLimit(env, ipHash);
  if (!allowed) return err(429, '提交过于频繁，请稍后再试', req);

  // 把 ipHash 拼到 contact 末尾用于限频计数（不暴露原始 IP）
  const contactForStorage = submitterContact ? `${submitterContact}|${ipHash}` : `|${ipHash}`;

  await run(env,
    `INSERT INTO submissions (rid, submitter_name, submitter_contact, new_version, download_url, notes, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
    [rid || null, submitterName, contactForStorage, newVersion, downloadUrl, notes, nowIso()]
  );

  return json({ ok: true, message: '提交成功，等待管理员审核' }, {}, req);
}

// GET /api/admin/submissions?status=pending|approved|rejected — 管理员查看
export async function listSubmissions(req, env) {
  await requireAdmin(req, env);
  const url = new URL(req.url);
  const status = url.searchParams.get('status') || 'pending';
  const rows = await all(env,
    `SELECT id, rid, submitter_name, submitter_contact, new_version, download_url, notes, status, created_at
     FROM submissions WHERE status = ? ORDER BY created_at DESC LIMIT 200`,
    [status]
  );
  // 脱敏：去掉 contact 末尾的 ipHash
  const list = rows.map(r => ({
    ...r,
    submitter_contact: (r.submitter_contact || '').replace(/\|[a-f0-9]+$/, ''),
  }));
  return json({ list, total: list.length }, {}, req);
}

// POST /api/admin/submissions/:id/merge — 合并到 mods_staging（需配合 body 指定要更新的字段）
export async function mergeSubmission(req, env, params) {
  const admin = await requireAdmin(req, env);
  const id = Number(params.id);
  if (!id) return err(400, '无效的 id', req);
  const sub = await first(env, `SELECT * FROM submissions WHERE id = ?`, [id]);
  if (!sub) return err(404, '提交不存在', req);
  if (sub.status !== 'pending') return err(400, '该提交已处理', req);

  const body = await parseBody(req);
  // body.fieldUpdates: { badge, size, date, downloadLink: {url, text, category, version, size, date} }

  if (sub.rid && body.downloadLink) {
    // 在已有模组追加一条 downloadLink
    const row = await first(env, `SELECT data_json FROM mods_staging WHERE rid = ?`, [sub.rid]);
    if (!row) return err(404, `staging 中找不到 rid=${sub.rid} 的模组`, req);
    const mod = JSON.parse(row.data_json);
    if (!Array.isArray(mod.downloadLinks)) mod.downloadLinks = [];
    const dl = body.downloadLink;
    mod.downloadLinks.push({
      text: dl.text || `新版本 ${sub.new_version || ''}`.trim(),
      url: dl.url || sub.download_url,
      category: dl.category || 'testBranch',
      version: dl.version || sub.new_version,
      size: dl.size,
      date: dl.date || new Date().toISOString().slice(0, 10),
    });
    // 同步顶层 badge/date
    if (body.badge) mod.badge = body.badge;
    if (body.date) mod.date = body.date;
    if (body.size) mod.size = body.size;
    await run(env,
      `UPDATE mods_staging SET data_json = ?, updated_at = ?, updated_by = ? WHERE rid = ?`,
      [JSON.stringify(mod), nowIso(), admin.nickname, sub.rid]
    );
  }

  await run(env, `UPDATE submissions SET status = 'approved' WHERE id = ?`, [id]);
  return json({ ok: true, id, status: 'approved' }, {}, req);
}

// POST /api/admin/submissions/:id/reject
export async function rejectSubmission(req, env, params) {
  await requireAdmin(req, env);
  const id = Number(params.id);
  if (!id) return err(400, '无效的 id', req);
  await run(env, `UPDATE submissions SET status = 'rejected' WHERE id = ?`, [id]);
  return json({ ok: true, id, status: 'rejected' }, {}, req);
}
