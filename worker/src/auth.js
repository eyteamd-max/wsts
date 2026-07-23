// auth.js — 注册/验证/登录/登出/当前用户/改资料
import { pbkdf2Hash, verifyPassword, signJWT, verifyJWT, randToken, bufToB64 } from './crypto.js';
import { first, run, all } from './db.js';
import { json, err, parseBody, publicUser, setAuthCookie, clearAuthCookie, requireAuth, getCookie, clientIpHash } from './utils.js';
import { sendVerifyEmail } from './email.js';
import { auditNickname, checkRegisterRateLimit, checkLoginRateLimit } from './moderation.js';

// 清理注册超过5分钟仍未验证邮箱的账号（释放邮箱供重新注册）
async function cleanupUnverified(env) {
  const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const expired = await all(env, 'SELECT id FROM users WHERE is_verified = 0 AND created_at < ?', [cutoff]);
  if (!expired.length) return;
  const ids = expired.map(u => u.id);
  const ph = ids.map(() => '?').join(',');
  await run(env, `DELETE FROM email_tokens WHERE user_id IN (${ph})`, ids);
  await run(env, `DELETE FROM moderation_log WHERE comment_id IN (SELECT id FROM comments WHERE user_id IN (${ph}))`, ids);
  await run(env, `DELETE FROM reports WHERE comment_id IN (SELECT id FROM comments WHERE user_id IN (${ph}))`, ids);
  await run(env, `DELETE FROM likes WHERE user_id IN (${ph})`, ids);
  await run(env, `DELETE FROM comment_attachments WHERE comment_id IN (SELECT id FROM comments WHERE user_id IN (${ph}))`, ids);
  await run(env, `DELETE FROM comments WHERE user_id IN (${ph})`, ids);
  await run(env, `DELETE FROM users WHERE id IN (${ph})`, ids);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function genSaltB64() {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return bufToB64(arr.buffer);
}

// POST /api/auth/register { email, password, nickname }
export async function register(req, env) {
  const ipHash = await clientIpHash(req);
  await checkRegisterRateLimit(env, ipHash);
  await cleanupUnverified(env);
  const { email, password, nickname } = await parseBody(req);
  const mail = String(email || '').trim().toLowerCase();
  const nick = String(nickname || '').trim();
  const pwd = String(password || '');
  if (!EMAIL_RE.test(mail)) return err(400, '邮箱格式不正确', req);
  if (pwd.length < 6 || pwd.length > 64) return err(400, '密码长度需 6-64 位', req);
  if (!nick || nick.length > 24) return err(400, '昵称需 1-24 字符', req);
  var nickAudit = auditNickname(nick);
  if (!nickAudit.ok) return err(400, nickAudit.reason, req);

  const exists = await first(env, 'SELECT id FROM users WHERE email = ?', [mail]);
  if (exists) return err(409, '该邮箱已注册', req);

  const nickExists = await first(env, 'SELECT id FROM users WHERE nickname = ?', [nick]);
  if (nickExists) return err(409, '该昵称已被使用', req);

  const salt = genSaltB64();
  const hash = await pbkdf2Hash(pwd, salt);

  // 首个注册用户自动成为管理员
  const countRow = await first(env, 'SELECT COUNT(*) AS c FROM users');
  const isAdmin = countRow && countRow.c === 0 ? 1 : 0;

  const ins = await run(
    env,
    'INSERT INTO users (email, nickname, password_hash, password_salt, is_verified, is_admin) VALUES (?, ?, ?, ?, 0, ?)',
    [mail, nick, hash, salt, isAdmin]
  );
  const userId = ins.meta.last_row_id;
  const user = await first(env, 'SELECT * FROM users WHERE id = ?', [userId]);

  // 生成验证 token（5 分钟有效，与自动清理同步）
  const token = randToken(32);
  const expires = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  await run(
    env,
    'INSERT INTO email_tokens (user_id, token, purpose, expires_at) VALUES (?, ?, ?, ?)',
    [userId, token, 'register', expires]
  );
  const mailRes = await sendVerifyEmail(env, user, token);

  return json({ user: publicUser(user), verify_sent: mailRes.ok, mail_error: mailRes.error || null }, {}, req);
}

// GET /api/auth/verify?token=xxx
export async function verify(req, env) {
  const url = new URL(req.url);
  const token = url.searchParams.get('token');
  if (!token) return err(400, '缺少 token', req);

  const row = await first(env, 'SELECT * FROM email_tokens WHERE token = ? AND used = 0', [token]);
  if (!row) return htmlRes('验证失败', '链接无效或已使用。', false);

  if (new Date(row.expires_at) < new Date()) {
    return htmlRes('验证失败', '链接已过期，请重新注册或重新发送验证邮件。', false);
  }
  await run(env, 'UPDATE users SET is_verified = 1 WHERE id = ?', [row.user_id]);
  await run(env, 'UPDATE email_tokens SET used = 1 WHERE id = ?', [row.id]);
  return htmlRes('验证成功', '你的邮箱已验证，现在可以去登录了。', true);
}

// POST /api/auth/login { email, password }
export async function login(req, env) {
  const ipHash = await clientIpHash(req);
  await checkLoginRateLimit(env, ipHash);
  await cleanupUnverified(env);
  const { email, password } = await parseBody(req);
  const mail = String(email || '').trim().toLowerCase();
  const pwd = String(password || '');
  if (!mail || !pwd) return err(400, '邮箱和密码不能为空', req);

  const user = await first(env, 'SELECT * FROM users WHERE email = ?', [mail]);
  if (!user) return err(401, '邮箱或密码错误', req);

  const ok = await verifyPassword(pwd, user.password_salt, user.password_hash);
  if (!ok) return err(401, '邮箱或密码错误', req);

  if (!user.is_verified) return err(403, '邮箱未验证，请先查收验证邮件', req);
  if (user.is_banned) return err(403, '账号已被封禁', req);

  await run(env, 'UPDATE users SET last_login_at = datetime(\'now\') WHERE id = ?', [user.id]);
  const jwt = await signJWT({ sub: user.id, email: user.email, isAdmin: !!user.is_admin }, env);

  const headers = { 'Set-Cookie': setAuthCookie(req, jwt) };
  return json({ user: publicUser(user) }, { headers }, req);
}

// POST /api/auth/logout
export async function logout(req, env) {
  return json({ ok: true }, { headers: { 'Set-Cookie': clearAuthCookie(req) } }, req);
}

// GET /api/auth/me
export async function me(req, env) {
  const token = getCookie(req, 'cm_token');
  if (!token) return json({ user: null }, {}, req);
  const payload = await verifyJWT(token, env);
  if (!payload || !payload.sub) return json({ user: null }, {}, req);
  const u = await first(env, 'SELECT * FROM users WHERE id = ?', [payload.sub]);
  if (!u || u.is_banned) return json({ user: null }, {}, req);

  const headers = {};
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp - now < 7 * 86400) {
    const newToken = await signJWT({ sub: u.id }, env);
    headers['Set-Cookie'] = setAuthCookie(req, newToken);
  }

  return json({ user: publicUser(u) }, { headers }, req);
}

// PATCH /api/auth/me { nickname?, avatarKey? }
export async function patchMe(req, env) {
  const user = await requireAuth(req, env);
  const { nickname, avatarKey } = await parseBody(req);
  if (nickname !== undefined) {
    const nick = String(nickname).trim();
    if (!nick || nick.length > 24) return err(400, '昵称需 1-24 字符', req);
    const nickExists = await first(env, 'SELECT id FROM users WHERE nickname = ? AND id != ?', [nick, user.id]);
    if (nickExists) return err(409, '该昵称已被使用', req);
    await run(env, 'UPDATE users SET nickname = ? WHERE id = ?', [nick, user.id]);
  }
  if (avatarKey !== undefined) {
    const key = String(avatarKey || '').trim();
    await run(env, 'UPDATE users SET avatar_key = ? WHERE id = ?', [key || null, user.id]);
  }
  const updated = await first(env, 'SELECT * FROM users WHERE id = ?', [user.id]);
  return json({ user: publicUser(updated) }, {}, req);
}

// 简单 HTML 响应（用于验证页）
function htmlRes(title, msg, ok) {
  const color = ok ? '#a8d8c8' : '#e89b9b';
  const html = `<!doctype html><meta charset="utf-8"><title>${title}</title>
  <div style="font-family:sans-serif;max-width:440px;margin:60px auto;text-align:center;padding:24px">
    <h2 style="color:${color}">${title}</h2>
    <p style="color:#555;line-height:1.7">${msg}</p>
    <p style="margin-top:24px"><a href="https://axxxx.cyou" style="color:#e89b9b">返回主站</a></p>
  </div>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
