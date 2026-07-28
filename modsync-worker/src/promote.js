// promote.js — 迁移 staging 到生产（GitHub REST API commit）
// 通过 GitHub Contents API 直接提交 JSON 文件覆盖生产静态站数据
// 需要 env.GH_TOKEN secret（Personal Access Token，需 repo 权限）
import { all, first, run } from './db.js';
import { json, err, nowIso, requireAdmin } from './utils.js';
import * as kvCache from './kvCache.js';

const GITHUB_API = 'https://api.github.com';

function b64encode(text) {
  // UTF-8 安全的 base64 编码
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

// 获取 GitHub 文件当前 sha（用于覆盖更新）
async function getFileSha(env) {
  const repo = env.GITHUB_REPO;
  const branch = env.GITHUB_BRANCH || 'main';
  const path = env.GITHUB_MOD_FILE_PATH || 'resources/json/post/sts2_mods/sts2_mods_1.json';
  const url = `${GITHUB_API}/repos/${repo}/contents/${path}?ref=${branch}`;
  const resp = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${env.GH_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'sts2-modsync-worker',
    },
  });
  if (resp.status === 404) return { sha: null, exists: false };
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`GitHub getFileSha 失败 ${resp.status}: ${t.slice(0, 200)}`);
  }
  const data = await resp.json();
  return { sha: data.sha, exists: true };
}

// 收集 staging 全量数据 → 拼装 JSON 数组
async function collectStagingSnapshot(env) {
  const rows = await all(env, `SELECT data_json FROM mods_staging ORDER BY date DESC, rid DESC`);
  return rows.map(r => {
    try { return JSON.parse(r.data_json); } catch { return null; }
  }).filter(Boolean);
}

// 计算 staging vs prod 的差异摘要
export async function computeDiff(env) {
  const stagingRows = await all(env, `SELECT rid, badge, date, size, title FROM mods_staging`);
  const prodRows = await all(env, `SELECT rid, badge, date, size, title FROM mods_prod`);
  const prodMap = {};
  prodRows.forEach(r => { prodMap[r.rid] = r; });

  const added = [];
  const modified = [];
  const removed = [];

  for (const s of stagingRows) {
    const p = prodMap[s.rid];
    if (!p) {
      added.push({ rid: s.rid, title: s.title, badge: s.badge });
    } else if (p.badge !== s.badge || p.date !== s.date || p.size !== s.size || p.title !== s.title) {
      modified.push({
        rid: s.rid, title: s.title,
        old: { badge: p.badge, date: p.date, size: p.size, title: p.title },
        new: { badge: s.badge, date: s.date, size: s.size, title: s.title },
      });
    }
  }

  const stagingMap = {};
  stagingRows.forEach(r => { stagingMap[r.rid] = r; });
  for (const p of prodRows) {
    if (!stagingMap[p.rid]) {
      removed.push({ rid: p.rid, title: p.title, badge: p.badge });
    }
  }

  return {
    added, modified, removed,
    summary: {
      added: added.length, modified: modified.length, removed: removed.length,
      stagingTotal: stagingRows.length, prodTotal: prodRows.length,
    },
  };
}

// GET /api/admin/diff — 返回差异预览（不执行迁移）
export async function diff(req, env) {
  await requireAdmin(req, env);
  const result = await computeDiff(env);
  return json(result, {}, req);
}

// POST /api/admin/promote — 迁移到生产
// body: { confirm: true/false }
//   - confirm=false 或缺省：返回 dry-run 预览（diff + 即将提交的 commit message）
//   - confirm=true：真正执行 GitHub commit
export async function promote(req, env) {
  const admin = await requireAdmin(req, env);
  const body = await (req.text().then(t => t ? JSON.parse(t) : {}).catch(() => ({})));
  const diffResult = await computeDiff(env);

  if (!body.confirm) {
    return json({
      ok: true,
      dryRun: true,
      diff: diffResult,
      pendingCommit: {
        repo: env.GITHUB_REPO,
        branch: env.GITHUB_BRANCH || 'main',
        path: env.GITHUB_MOD_FILE_PATH,
        message: `chore(mods): sync staging → prod (${diffResult.summary.added}+ ${diffResult.summary.modified}~ ${diffResult.summary.removed}-)`,
      },
      message: '请检查 diff，确认无误后带 confirm=true 重新请求',
    }, {}, req);
  }

  // 二次确认：要求 body.confirmPhrase === 'MIGRATE'
  if (body.confirmPhrase !== 'MIGRATE') {
    return err(400, '请传入 confirmPhrase="MIGRATE" 以确认迁移', req);
  }

  // 校验前置条件
  if (!env.GH_TOKEN) return err(500, '未配置 GH_TOKEN secret，无法提交到 GitHub', req);
  if (!env.GITHUB_REPO || env.GITHUB_REPO.includes('<')) return err(500, '未配置 GITHUB_REPO', req);

  // 收集 staging 快照
  const snapshot = await collectStagingSnapshot(env);
  const newContent = JSON.stringify(snapshot, null, 2);
  const commitMessage = `chore(mods): sync staging → prod (${diffResult.summary.added}+ ${diffResult.summary.modified}~ ${diffResult.summary.removed}-)\n\nSource: ${env.API_ORIGIN || 'https://sync.axxxx.cyou'}/admin\nPromoted at: ${nowIso()}`;

  // 获取当前文件 sha
  const { sha, exists } = await getFileSha(env);

  // 提交
  const repo = env.GITHUB_REPO;
  const branch = env.GITHUB_BRANCH || 'main';
  const path = env.GITHUB_MOD_FILE_PATH || 'resources/json/post/sts2_mods/sts2_mods_1.json';
  const url = `${GITHUB_API}/repos/${repo}/contents/${path}`;
  const payload = {
    message: commitMessage,
    content: b64encode(newContent),
    branch,
  };
  if (sha) payload.sha = sha;

  const resp = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${env.GH_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'sts2-modsync-worker',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    return err(502, `GitHub 提交失败 ${resp.status}: ${t.slice(0, 300)}`, req);
  }

  const data = await resp.json();
  const commitSha = data.commit && data.commit.sha;

  // 记录日志
  await run(env,
    `INSERT INTO promotions_log (promoted_at, by_user, commit_sha, mods_count, snapshot_json)
     VALUES (?, ?, ?, ?, ?)`,
    [nowIso(), admin.nickname, commitSha, snapshot.length, JSON.stringify(diffResult.summary)]
  );

  // 同步 mods_prod = mods_staging（迁移后两者一致）
  await run(env, `DELETE FROM mods_prod`);
  const stagingRows = await all(env, `SELECT rid, title, badge, size, date, tags, description, author, data_json FROM mods_staging`);
  for (const r of stagingRows) {
    await run(env,
      `INSERT INTO mods_prod (rid, title, badge, size, date, tags, description, author, data_json, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [r.rid, r.title, r.badge, r.size, r.date, r.tags, r.description, r.author, r.data_json, nowIso()]
    );
  }

  // 清缓存
  await kvCache.del(env, 'mods:prod:all');
  await kvCache.del(env, 'mods:staging:all');

  return json({
    ok: true,
    commitSha,
    commitUrl: data.commit && data.commit.html_url,
    modsCount: snapshot.length,
    diff: diffResult.summary,
    message: '迁移成功！Cloudflare Pages 将在 ~30 秒内自动重建生产站',
  }, {}, req);
}

// GET /api/admin/promotions — 迁移历史
export async function promotions(req, env) {
  await requireAdmin(req, env);
  const rows = await all(env,
    `SELECT id, promoted_at, by_user, commit_sha, mods_count, snapshot_json
     FROM promotions_log ORDER BY id DESC LIMIT 50`
  );
  return json({ list: rows }, {}, req);
}
