// admin.js — 待审核列表 / 通过 / 拒绝 / 批量管理
import { all, first, run, batch } from './db.js';
import { json, err, requireAdmin, parseBody, publicUser } from './utils.js';
import { create as createNotification } from './notifications.js';
import * as kvCache from './kvCache.js';

async function invalidateCommentCache(env, rid) {
  await kvCache.del(env, 'comments:' + rid + ':hot');
  await kvCache.del(env, 'comments:' + rid + ':time');
}

function attachmentUrl(env, key) {
  const origin = env.API_ORIGIN || 'https://cmt.axxxx.cyou';
  return `${origin}/api/files/${key}`;
}

// GET /api/admin/comments/pending
export async function pending(req, env) {
  await requireAdmin(req, env);
  const rows = await all(
    env,
    `SELECT c.id, c.rid, c.user_id, c.parent_id, c.content, c.status, c.report_count, c.ip_hash, c.created_at,
            u.nickname, u.avatar_key
       FROM comments c
       JOIN users u ON u.id = c.user_id
      WHERE c.status IN ('pending', 'reported')
      ORDER BY c.report_count DESC, c.created_at DESC`
  );
  let list = rows.map(r => ({
    id: r.id, rid: r.rid, parentId: r.parent_id, content: r.content,
    status: r.status, createdAt: r.created_at, ipHash: r.ip_hash,
    author: { id: r.user_id, nickname: r.nickname, avatarKey: r.avatar_key },
    attachments: [],
  }));

  if (list.length) {
    const ids = list.map(c => c.id);
    const atts = await all(
      env,
      `SELECT id, comment_id, r2_key, filename, mime, size, kind FROM comment_attachments WHERE comment_id IN (${ids.map(() => '?').join(',')}) ORDER BY id ASC`,
      ids
    );
    const map = atts.reduce((m, a) => {
      (m[a.comment_id] = m[a.comment_id] || []).push({
        id: a.id, key: a.r2_key, url: attachmentUrl(env, a.r2_key),
        name: a.filename, mime: a.mime, size: a.size, kind: a.kind,
      });
      return m;
    }, {});
    list = list.map(c => ({ ...c, attachments: map[c.id] || [] }));
  }

  return json({ list, total: list.length }, {}, req);
}

// POST /api/admin/comments/:id/approve
export async function approve(req, env, params) {
  const admin = await requireAdmin(req, env);
  const id = Number(params.id);
  if (!id) return err(400, '无效的评论 id', req);
  const c = await first(env, 'SELECT id, rid FROM comments WHERE id = ?', [id]);
  if (!c) return err(404, '评论不存在', req);
  await run(env, "UPDATE comments SET status = 'approved' WHERE id = ?", [id]);
  await run(env, 'INSERT INTO moderation_log (comment_id, moderator_id, action, reason) VALUES (?, ?, ?, ?)', [id, admin.id, 'approve', null]);
  await invalidateCommentCache(env, c.rid);
  return json({ ok: true, id, status: 'approved' }, {}, req);
}

// POST /api/admin/comments/:id/reject  { reason? } — 拒绝并硬删除
export async function reject(req, env, params) {
  const admin = await requireAdmin(req, env);
  const id = Number(params.id);
  if (!id) return err(400, '无效的评论 id', req);
  const body = await parseBody(req);
  const reason = String(body.reason || '').slice(0, 200) || null;
  const c = await first(env, 'SELECT c.*, u.nickname AS author_nickname FROM comments c JOIN users u ON u.id = c.user_id WHERE c.id = ?', [id]);
  if (!c) return err(404, '评论不存在', req);
  // 先通知用户
  createNotification(env, {
    userId: c.user_id,
    type: 'reject',
    message: `你的评论未通过审核${reason ? '，原因：' + reason : ''}`,
    data: { commentId: id, rid: c.rid, reason },
  }).catch(e => console.log('[reject notify]', e.message));
  // 硬删除评论及关联数据
  const allIds = await getAllCommentIds(env, id);
  const ph = allIds.map(() => '?').join(',');
  const stmts = [
    { sql: 'INSERT INTO moderation_log (comment_id, moderator_id, action, reason) VALUES (?, ?, ?, ?)', params: [id, admin.id, 'reject', reason] },
    { sql: `DELETE FROM moderation_log WHERE comment_id IN (${ph})`, params: allIds },
    { sql: `DELETE FROM comment_attachments WHERE comment_id IN (${ph})`, params: allIds },
    { sql: `DELETE FROM likes WHERE comment_id IN (${ph})`, params: allIds },
    { sql: `DELETE FROM comments WHERE id IN (${ph})`, params: allIds },
  ];
  await batch(env, stmts);
  await invalidateCommentCache(env, c.rid);
  return json({ ok: true, id }, {}, req);
}

// PATCH /api/admin/users/:id { nickname? | avatarKey? | email? }
export async function patchUser(req, env, params) {
  await requireAdmin(req, env);
  const userId = Number(params.id);
  if (!userId) return err(400, '无效的用户 id', req);
  const body = await parseBody(req);

  const user = await first(env, 'SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) return err(404, '用户不存在', req);

  if (body.nickname !== undefined) {
    const nick = String(body.nickname).trim();
    if (!nick || nick.length > 24) return err(400, '昵称需 1-24 字符', req);
    const nickExists = await first(env, 'SELECT id FROM users WHERE nickname = ? AND id != ?', [nick, userId]);
    if (nickExists) return err(409, '该昵称已被使用', req);
    await run(env, 'UPDATE users SET nickname = ? WHERE id = ?', [nick, userId]);
  }

  if (body.avatarKey !== undefined) {
    const key = body.avatarKey === null || body.avatarKey === '' ? null : String(body.avatarKey);
    await run(env, 'UPDATE users SET avatar_key = ? WHERE id = ?', [key, userId]);
  }

  if (body.email !== undefined) {
    const mail = String(body.email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) return err(400, '邮箱格式不正确', req);
    const mailExists = await first(env, 'SELECT id FROM users WHERE email = ? AND id != ?', [mail, userId]);
    if (mailExists) return err(409, '该邮箱已被使用', req);
    await run(env, 'UPDATE users SET email = ? WHERE id = ?', [mail, userId]);
  }

  const updated = await first(env, 'SELECT * FROM users WHERE id = ?', [userId]);
  return json({ ok: true, user: publicUser(updated) }, {}, req);
}

// POST /api/admin/users/:id/mute { minutes }
export async function muteUser(req, env, params) {
  const admin = await requireAdmin(req, env);
  const userId = Number(params.id);
  if (!userId) return err(400, '无效的用户 id', req);

  const user = await first(env, 'SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) return err(404, '用户不存在', req);
  if (user.is_admin) return err(403, '不能禁言管理员', req);

  const body = await parseBody(req);
  const minutes = Number(body.minutes) || 60;
  if (minutes <= 0 || minutes > 43200) return err(400, '禁言时长需 1-43200 分钟（30天）', req);

  const mutedUntil = new Date(Date.now() + minutes * 60 * 1000).toISOString();
  await run(env, 'UPDATE users SET muted_until = ? WHERE id = ?', [mutedUntil, userId]);

  createNotification(env, {
    userId: userId,
    type: 'mute',
    message: `你已被管理员禁言 ${minutes} 分钟，禁言结束时间：${new Date(mutedUntil).toLocaleString()}`,
    data: { minutes, mutedUntil },
  }).catch(e => console.log('[mute notify]', e.message));

  const updated = await first(env, 'SELECT * FROM users WHERE id = ?', [userId]);
  return json({ ok: true, user: publicUser(updated), mutedUntil }, {}, req);
}

// POST /api/admin/users/:id/unmute
export async function unmuteUser(req, env, params) {
  await requireAdmin(req, env);
  const userId = Number(params.id);
  if (!userId) return err(400, '无效的用户 id', req);

  const user = await first(env, 'SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) return err(404, '用户不存在', req);

  await run(env, 'UPDATE users SET muted_until = NULL WHERE id = ?', [userId]);

  createNotification(env, {
    userId: userId,
    type: 'unmute',
    message: '你的禁言已解除，现在可以正常发表评论了',
    data: {},
  }).catch(e => console.log('[unmute notify]', e.message));

  const updated = await first(env, 'SELECT * FROM users WHERE id = ?', [userId]);
  return json({ ok: true, user: publicUser(updated) }, {}, req);
}

// GET /api/admin/users — 用户列表
export async function listUsers(req, env) {
  await requireAdmin(req, env);
  const url = new URL(req.url);
  const q = url.searchParams.get('q') || '';
  let sql = `SELECT id, email, nickname, avatar_key, is_admin, is_banned, muted_until, created_at, last_login_at FROM users`;
  let params = [];
  if (q) {
    sql += ` WHERE nickname LIKE ? OR email LIKE ?`;
    params = ['%' + q + '%', '%' + q + '%'];
  }
  sql += ` ORDER BY created_at DESC LIMIT 200`;
  const rows = await all(env, sql, params);
  return json({ list: rows.map(r => ({
    id: r.id, email: r.email, nickname: r.nickname, avatarKey: r.avatar_key,
    isAdmin: !!r.is_admin, isBanned: !!r.is_banned,
    mutedUntil: r.muted_until, createdAt: r.created_at, lastLoginAt: r.last_login_at,
  })) }, {}, req);
}

// GET /api/admin/comments — 全部评论管理（支持 status/rid/q/page/size 筛选）
export async function listComments(req, env) {
  await requireAdmin(req, env);
  const url = new URL(req.url);
  const status = url.searchParams.get('status');
  const rid = url.searchParams.get('rid');
  const q = url.searchParams.get('q') || '';
  const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
  const size = Math.min(200, Math.max(1, Number(url.searchParams.get('size')) || 50));
  const offset = (page - 1) * size;

  let where = '1=1';
  let params = [];
  if (status) { where += ` AND c.status = ?`; params.push(status); }
  if (rid) { where += ` AND c.rid = ?`; params.push(rid); }
  if (q) {
    where += ` AND (c.content LIKE ? OR u.nickname LIKE ? OR c.rid LIKE ?)`;
    params.push('%' + q + '%', '%' + q + '%', '%' + q + '%');
  }

  // 统计总数
  const countRow = await first(
    env,
    `SELECT COUNT(*) AS total FROM comments c JOIN users u ON u.id = c.user_id WHERE ${where}`,
    params
  );
  const total = countRow ? countRow.total : 0;

  let sql = `SELECT c.id, c.rid, c.user_id, c.parent_id, c.content, c.status, c.created_at,
            c.pinned, c.pinned_at,
            u.nickname, u.avatar_key
       FROM comments c
       JOIN users u ON u.id = c.user_id WHERE ${where}
      ORDER BY c.pinned DESC, COALESCE(c.pinned_at, c.created_at) DESC, c.created_at DESC
      LIMIT ? OFFSET ?`;
  const rows = await all(env, sql, [...params, size, offset]);
  let list = rows.map(r => ({
    id: r.id, rid: r.rid, parentId: r.parent_id, content: r.content,
    status: r.status, createdAt: r.created_at,
    pinned: !!r.pinned, pinnedAt: r.pinned_at,
    author: { id: r.user_id, nickname: r.nickname, avatarKey: r.avatar_key },
  }));

  if (list.length) {
    const ids = list.map(c => c.id);
    const atts = await all(
      env,
      `SELECT id, comment_id, r2_key, filename, mime, size, kind FROM comment_attachments WHERE comment_id IN (${ids.map(() => '?').join(',')}) ORDER BY id ASC`,
      ids
    );
    const map = atts.reduce((m, a) => {
      (m[a.comment_id] = m[a.comment_id] || []).push({
        id: a.id, key: a.r2_key, url: attachmentUrl(env, a.r2_key),
        name: a.filename, mime: a.mime, size: a.size, kind: a.kind,
      });
      return m;
    }, {});
    list = list.map(c => ({ ...c, attachments: map[c.id] || [] }));
  }

  return json({ list, total, page, size }, {}, req);
}

// POST /api/admin/comments/batch-delete { ids: [1,2,3] }
export async function batchDeleteComments(req, env) {
  await requireAdmin(req, env);
  const body = await parseBody(req);
  const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(n => n > 0) : [];
  if (!ids.length) return err(400, 'ids 必填', req);
  if (ids.length > 200) return err(400, '单次最多删除 200 条', req);

  const ph = ids.map(() => '?').join(',');
  const ridRows = await all(env, `SELECT DISTINCT rid FROM comments WHERE id IN (${ph})`, ids);
  const rids = ridRows.map(r => r.rid);

  const allTargets = new Set(ids);
  const children = await all(
    env,
    `SELECT id FROM comments WHERE parent_id IN (${ph})`,
    ids
  );
  children.forEach(c => allTargets.add(c.id));

  const targetIds = [...allTargets];
  const targetPh = targetIds.map(() => '?').join(',');
  const stmts = [
    { sql: `DELETE FROM comment_attachments WHERE comment_id IN (${targetPh})`, params: targetIds },
    { sql: `DELETE FROM moderation_log WHERE comment_id IN (${targetPh})`, params: targetIds },
    { sql: `DELETE FROM comments WHERE id IN (${targetPh})`, params: targetIds },
  ];
  await batch(env, stmts);

  for (const rid of rids) {
    await invalidateCommentCache(env, rid);
  }

  return json({ ok: true, deleted: targetIds.length, requested: ids.length }, {}, req);
}

// DELETE /api/admin/comments/:id — 管理员硬删除评论
export async function deleteComment(req, env, params) {
  const admin = await requireAdmin(req, env);
  const id = Number(params.id);
  if (!id) return err(400, '无效的评论 id', req);

  const c = await first(env, 'SELECT * FROM comments WHERE id = ?', [id]);
  if (!c) return err(404, '评论不存在', req);

  // 收集该评论及所有子回复的 id
  const allIds = await getAllCommentIds(env, id);
  const ph = allIds.map(() => '?').join(',');

  const stmts = [
    { sql: 'INSERT INTO moderation_log (comment_id, moderator_id, action, reason) VALUES (?, ?, ?, ?)', params: [id, admin.id, 'delete', '管理员删除'] },
    { sql: `DELETE FROM moderation_log WHERE comment_id IN (${ph})`, params: allIds },
    { sql: `DELETE FROM comment_attachments WHERE comment_id IN (${ph})`, params: allIds },
    { sql: `DELETE FROM likes WHERE comment_id IN (${ph})`, params: allIds },
    { sql: `DELETE FROM reports WHERE comment_id IN (${ph})`, params: allIds },
    { sql: `DELETE FROM notifications WHERE comment_id IN (${ph})`, params: allIds },
    { sql: `DELETE FROM comments WHERE id IN (${ph})`, params: allIds },
  ];
  await batch(env, stmts);
  await invalidateCommentCache(env, c.rid);
  return json({ ok: true, id }, {}, req);
}

async function getAllCommentIds(env, rootId) {
  const ids = [rootId];
  let pending = [rootId];
  while (pending.length) {
    const pid = pending.shift();
    const rows = await all(env, 'SELECT id FROM comments WHERE parent_id = ?', [pid]);
    for (const r of rows) {
      ids.push(r.id);
      pending.push(r.id);
    }
  }
  return ids;
}

// POST /api/admin/comments/:id/edit { content }
export async function editComment(req, env, params) {
  await requireAdmin(req, env);
  const id = Number(params.id);
  if (!id) return err(400, '无效的评论 id', req);
  const body = await parseBody(req);
  const content = String(body.content || '').trim();
  if (!content) return err(400, '评论内容不能为空', req);
  if (content.length > 5000) return err(400, '评论内容不能超过 5000 字符', req);

  const c = await first(env, 'SELECT id, rid FROM comments WHERE id = ?', [id]);
  if (!c) return err(404, '评论不存在', req);
  // 仅更新 content，保留 parent_id（不影响子回复）和 rid
  await run(env, 'UPDATE comments SET content = ? WHERE id = ?', [content, id]);
  await invalidateCommentCache(env, c.rid);
  return json({ ok: true, id, content }, {}, req);
}

// POST /api/admin/comments/:id/pin { pinned: true|false }
export async function pinComment(req, env, params) {
  await requireAdmin(req, env);
  const id = Number(params.id);
  if (!id) return err(400, '无效的评论 id', req);
  const body = await parseBody(req);
  const pinned = body.pinned === true || body.pinned === 1 || body.pinned === '1';

  const c = await first(env, 'SELECT id, rid, pinned FROM comments WHERE id = ?', [id]);
  if (!c) return err(404, '评论不存在', req);

  if (pinned) {
    await run(env, "UPDATE comments SET pinned = 1, pinned_at = datetime('now') WHERE id = ?", [id]);
  } else {
    await run(env, "UPDATE comments SET pinned = 0, pinned_at = NULL WHERE id = ?", [id]);
  }
  await invalidateCommentCache(env, c.rid);
  return json({ ok: true, id, pinned }, {}, req);
}
