# STS2 模组同步与测试环境方案

## 概述

为「杀戮尖塔2娘化MOD站」搭建一套**测试环境 + 自动检测 + 审核发布**的工作流，解决 200+ 模组在多游戏分支（v0.107.1 正式版 / v0.108.0 / v0.109.0 等 beta 分支）下手动同步更新状态困难的问题。

- 测试域名：`test.axxxx.cyou`（独立部署，不影响 `www.axxxx.cyou` / `axxxx.cyou`）
- 生产迁移：**仅在用户明确同意后**由 Worker 提交 GitHub commit 触发 Cloudflare Pages 重建
- 维护成本预估：**0–35 元/月**（Cloudflare 免费额度内 + Steam Web API 免费），远低于 500 元/月预算

---

## 当前状态分析

### 站点架构（已确认）
- **静态站**：Cloudflare Pages，根目录 `index.html` + `resources/` + `_headers`（`Cache-Control: no-store` 用于 JSON）
- **模组数据源**：单文件 `resources/json/post/sts2_mods/sts2_mods_1.json`（约 200 条），由 `manifest.json`（`"sts2_mods": "1~1"`）索引
- **前端加载**：[main.js#L315-318](file:///workspace/resources/js/main.js#L315-L318) 中 `dataSources = { all: 'resources/json/post/sts2_mods/sts2_mods_1.json', skin: '...' }`，配合 [loadManifest/loadJsonByManifest](file:///workspace/resources/js/main.js#L964-L1004) 按文件索引拉取
- **下载链接分类**：`downloadLinks[].category` ∈ `latest` / `testBranch` / `alternative` / `history`，由 [cLL() 函数](file:///workspace/resources/js/main.js#L911-L929) 分类渲染
- **现有 Worker**：`cmt.axxxx.cyou`（评论系统），已具备 D1 + 双 KV + admin/auth/notifications 基础设施；但 `worker/src/index.js`、`db.js`、`utils.js`、`crypto.js`、`email.js` 在工作区缺失

### 痛点
1. 模组作者在 Steam 创意工坊 / B站 / QQ群发布新版本后，站长需要**手动下载、手动编辑 JSON、手动重新部署**才能更新站点
2. 杀戮尖塔2 频繁发布测试版分支，每条分支都要为每个模组维护一份兼容性信息
3. 200+ 模组 × N 个游戏分支 = 灾难性维护成本
4. 任何 JSON 编辑错误会**直接影响生产站**，没有安全预览环境

### 来源分布（用户已确认）
- **Steam 创意工坊**：可用 Steam Web API 自动轮询（免费）
- **B站/QQ群/作者私发**：无公开 API，只能走**人工提交表单**
- （注：GitHub Releases 仅用于启动器，已被 `resources/game-update/` 覆盖，不在本方案范围内）

---

## 关键决策

### 决策 1：新建独立 Worker，不改动现有 `cmt.axxxx.cyou` Worker
**原因**：
- 现有 Worker 的 `index.js` / `db.js` / `utils.js` / `crypto.js` / `email.js` 不在工作区，无法安全扩展
- 评论系统是生产关键路径，任何改动风险高
- 用户明确要求「不要影响 www.axxxx.cyou / axxxx.cyou 用户使用」

**新 Worker 名称**：`sts2-modsync`，绑定域名 `sync.axxxx.cyou`（API）+ `test.axxxx.cyou`（静态站 + 管理 UI）

### 决策 2：生产数据流保持不变，仅测试环境切换数据源
**生产站（`axxxx.cyou` / `www.axxxx.cyou`）**：
- 继续读 `resources/json/post/sts2_mods/sts2_mods_1.json`（静态文件）
- **零代码改动**

**测试站（`test.axxxx.cyou`）**：
- 同一份静态站代码（Cloudflare Pages 同 repo 不同 branch 或同 repo 路由）
- [main.js](file:///workspace/resources/js/main.js#L315-L318) 增加 hostname 判断：当 `location.hostname === 'test.axxxx.cyou'` 时，`dataSources.all` 改为 `https://sync.axxxx.cyou/api/mods?env=staging`
- 这样测试站 UI/代码与生产完全一致，仅数据源不同，预览效果真实

### 决策 3：迁移生产 = Git commit（非侵入式）
- 用户在管理 UI 点「迁移到生产」→ Worker 调用 GitHub MCP（`create_or_update_file`）将 staging JSON 覆盖到 `resources/json/post/sts2_mods/sts2_mods_1.json`
- Cloudflare Pages 检测到 push 自动重建生产站
- **不修改生产任何代码**，仅替换数据文件
- 全程需用户二次确认（弹窗 + 输入确认词）

### 决策 4：自动检测仅覆盖 Steam 创意工坊
- Steam Web API `ISteamRemoteStorage/GetPublishedFileDetails`（免费，无需 API Key 的公开端点）
- 每 6 小时 Cron 轮询一次所有 Steam 创意工坊 `alternative` 链接
- B站/QQ群来源走**人工提交表单**（模组作者或管理员提交「新版本通知」）

---

## 提议改动

### A. 新建目录：`/workspace/modsync-worker/`

#### A1. `modsync-worker/wrangler.toml`
```toml
name = "sts2-modsync"
main = "src/index.js"
compatibility_date = "2024-09-23"
compatibility_flags = ["nodejs_compat"]

routes = [
  { custom_domain = true, pattern = "sync.axxxx.cyou" },
  { custom_domain = true, pattern = "test.axxxx.cyou" }
]

[[d1_databases]]
binding = "DB"
database_name = "sts2_modsync"
database_id = "<部署后填入>"

[[kv_namespaces]]
binding = "MOD_CACHE"
id = "<部署后填入>"

[vars]
SITE_ORIGIN = "https://axxxx.cyou"
TEST_SITE_ORIGIN = "https://test.axxxx.cyou"
GITHUB_REPO = "<用户补充：存放静态站的 GitHub 仓库 owner/repo>"
GITHUB_BRANCH = "main"
STEAM_WORKSHOP_BULK_ENDPOINT = "https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/"

[triggers]
crons = ["0 */6 * * *"]   # 每 6 小时轮询一次 Steam 创意工坊

[observability]
enabled = true
```

#### A2. `modsync-worker/src/index.js`（入口 + 路由）
- 路由分发：`/api/mods` / `/api/admin/*` / `/api/submit/*` / `/api/steam/poll` / `/api/promote`
- 复用现有的 `kvCache` 思路（独立实现，不 import 旧 worker）
- 简单 admin auth：从 `cmt.axxxx.cyou` 复用 JWT cookie（SameSite=Lax，已配同站），或独立 admin token

#### A3. `modsync-worker/src/db.js`
- D1 查询封装（`all` / `first` / `run` / `batch`），与现有 cmt worker 同接口风格
- 表结构初始化（首次部署自动建表）

#### A4. `modsync-worker/src/schema.sql`（D1 表结构）
```sql
-- 生产模组数据镜像（用于 diff）
CREATE TABLE IF NOT EXISTS mods_prod (
  rid TEXT PRIMARY KEY,
  title TEXT, badge TEXT, size TEXT, date TEXT,
  tags TEXT, description TEXT, author TEXT,
  data_json TEXT NOT NULL,           -- 完整 mod 对象
  synced_at TEXT NOT NULL
);

-- 测试模组数据（可编辑）
CREATE TABLE IF NOT EXISTS mods_staging (
  rid TEXT PRIMARY KEY,
  title TEXT, badge TEXT, size TEXT, date TEXT,
  tags TEXT, description TEXT, author TEXT,
  data_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);

-- 模组来源（用于自动轮询）
CREATE TABLE IF NOT EXISTS mod_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rid TEXT NOT NULL,
  source_type TEXT NOT NULL,         -- 'steam' | 'github' | 'zoho' | 'manual'
  source_id TEXT,                    -- workshop item id / repo full name / zoho file id
  source_url TEXT NOT NULL,
  last_seen_updated_at INTEGER,      -- Unix timestamp
  last_checked_at TEXT,
  FOREIGN KEY (rid) REFERENCES mods_staging(rid) ON DELETE CASCADE
);

-- 待审核更新
CREATE TABLE IF NOT EXISTS pending_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rid TEXT NOT NULL,
  source_type TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  old_version TEXT,
  new_version TEXT,
  payload_json TEXT NOT NULL,        -- 检测到的新字段
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'approved' | 'rejected'
  reviewed_at TEXT,
  reviewed_by TEXT
);

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
  rid TEXT,                          -- 可空（新模组）
  submitter_name TEXT,
  submitter_contact TEXT,
  new_version TEXT,
  download_url TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL
);
```

#### A5. `modsync-worker/src/steam.js`（Steam 创意工坊轮询）
- `pollAll(env)`：查询所有 `source_type='steam'` 的 mod_sources，批量 POST 到 Steam 端点
- 解析 `time_updated`，与 `last_seen_updated_at` 对比
- 若变化 → 插入 `pending_updates`（payload 含新 title/description/时间戳）
- 更新 `last_seen_updated_at` / `last_checked_at`

#### A6. `modsync-worker/src/admin.js`（管理 API）
- `GET /api/admin/pending` — 待审核列表（自动检测 + 人工提交合并）
- `POST /api/admin/pending/:id/approve` — 通过：将 payload 合并到 `mods_staging`
- `POST /api/admin/pending/:id/reject` — 拒绝
- `GET /api/admin/mods` — 测试环境模组列表（分页/搜索）
- `PUT /api/admin/mods/:rid` — 编辑单个模组（写入 `mods_staging`）
- `POST /api/admin/mods` — 新增模组
- `GET /api/admin/diff` — staging vs prod 差异
- `POST /api/admin/promote` — **迁移到生产**（调用 GitHub MCP）
- `GET /api/admin/promotions` — 迁移历史

#### A7. `modsync-worker/src/promote.js`（迁移到生产）
- 读取 `mods_staging` 全量 → 拼装为 JSON 数组 → 通过 GitHub MCP `create_or_update_file` 提交到 `resources/json/post/sts2_mods/sts2_mods_1.json`
- 记录 `promotions_log`
- **关键安全**：函数内不直接执行，先返回 diff 预览 + dry-run，等前端二次确认带 `confirm=true` 才真正提交

#### A8. `modsync-worker/src/submission.js`（人工提交表单 API）
- `POST /api/submit` — 公开接口，模组作者提交新版本（无需登录，加 IP 限频）
- `GET /api/admin/submissions` — 管理员查看
- `POST /api/admin/submissions/:id/merge` — 合并到 `mods_staging`

#### A9. `modsync-worker/src/publicApi.js`（公开只读 API）
- `GET /api/mods?env=staging` — 返回 staging JSON（test.axxxx.cyou 用）
- `GET /api/mods?env=prod` — 返回 prod 镜像 JSON（备份用）
- KV 缓存 60 秒

#### A10. `modsync-worker/admin-ui/`（管理面板静态资源）
- 单页 HTML（参考 `resources/github_parsing/index.html` 的 Tailwind 风格）
- 路径：`modsync-worker/admin-ui/index.html`，由 Worker 在 `https://sync.axxxx.cyou/admin` 提供
- 功能：待审核列表 / 模组编辑器 / diff 预览 / 迁移按钮 / 提交表单入口

### B. 改动生产静态站（最小化）

#### B1. 修改 [resources/js/main.js#L315-L318](file:///workspace/resources/js/main.js#L315-L318)
```javascript
var isTestEnv = location.hostname === 'test.axxxx.cyou';
var dataSources = {
    all: isTestEnv
        ? 'https://sync.axxxx.cyou/api/mods?env=staging'
        : 'resources/json/post/sts2_mods/sts2_mods_1.json',
    skin: isTestEnv
        ? 'https://sync.axxxx.cyou/api/mods?env=staging&category=skin'
        : 'resources/json/post/O.o_interface/O.o_interface_1.json'
};
```
- 影响：仅测试站切数据源；生产站代码无运行时差异（`isTestEnv=false` 时路径完全不变）
- 同时需调整 [loadManifest](file:///workspace/resources/js/main.js#L964-L982) 与 [loadJsonByManifest](file:///workspace/resources/js/main.js#L984-L1004)：测试环境跳过 manifest 直接走 API；生产保持原逻辑

#### B2. 修改 [index.html#L162](file:///workspace/index.html#L162)（可选）
- 加 `<script>window.MODSYNC_API = "https://sync.axxxx.cyou";</script>` 方便统一管理

### C. Cloudflare Pages 配置

#### C1. 生产站（已有，不改动）
- 域名：`axxxx.cyou` / `www.axxxx.cyou`
- 源：现有 GitHub repo（`main` branch）
- 部署：push 触发自动重建

#### C2. 测试站（新建）
- 域名：`test.axxxx.cyou`
- 源：**同一 GitHub repo**（避免代码分叉），但通过 Cloudflare Pages 自定义域名绑定到同一项目
- 关键：测试站只是「同代码不同域名 + 不同数据源」，靠 main.js 的 hostname 判断实现

> 如果用户希望测试站完全独立（避免 main branch 的未确认改动影响测试），可改用独立 branch（如 `staging`）；本方案默认同 repo 同 branch，靠前端 hostname 切换数据源，零代码分叉。

### D. 首次数据迁移（一次性脚本）

#### D1. `modsync-worker/scripts/import-initial.mjs`
- 读取 `/workspace/resources/json/post/sts2_mods/sts2_mods_1.json`
- 解析每个 mod，写入 `mods_prod` 和 `mods_staging`（初始两表同步）
- 扫描每个 mod 的 `downloadLinks`，识别 Steam 创意工坊 URL（`steamcommunity.com/sharedfiles/filedetails/?id=XXXX`），写入 `mod_sources`
- 输出报告：导入模组数 / 识别到的 Steam 源数量 / 无法自动追踪的模组数

---

## 实施分阶段（并行推进，符合用户「两个都要」要求）

### 阶段 1：基础环境（先搭台子）
1. 创建 `modsync-worker/` 目录结构与所有源文件
2. 创建 D1 数据库 `sts2_modsync` + KV `MOD_CACHE`
3. 部署 Worker 到 `sync.axxxx.cyou` + `test.axxxx.cyou`
4. 运行 `import-initial.mjs` 导入初始数据
5. Cloudflare Pages 添加 `test.axxxx.cyou` 自定义域名
6. 修改 [main.js](file:///workspace/resources/js/main.js#L315-L318) 增加 hostname 切换
7. **验证**：访问 `test.axxxx.cyou` 能看到与生产一致的 200+ 模组列表；访问 `axxxx.cyou` 数据源完全不变

### 阶段 2：审核与迁移工作流（staging 可编辑 + 可迁移）
1. 实装 `admin.js` 的编辑/diff/promote 接口
2. 实装 `admin-ui/index.html` 管理面板
3. 接入 GitHub MCP（用户授权 `trae-remote-official:github` 插件）实现 `promote.js`
4. **验证**：在管理面板编辑某个模组的 badge → test.axxxx.cyou 立即看到变化 → 点「迁移到生产」→ GitHub 收到 commit → axxxx.cyou 自动重建后看到变化

### 阶段 3：自动检测（Steam 创意工坊 + 人工提交）
1. 实装 `steam.js` 轮询逻辑 + Cron Trigger
2. 实装 `submission.js` 公开提交表单
3. 管理面板增加「待审核」页签（合并自动 + 人工提交）
4. **验证**：手动修改某个 Steam 源的 `last_seen_updated_at` → 触发轮询 → 管理面板出现待审核条目 → 通过后进入 staging

---

## 假设与约束

1. **GitHub 仓库**：用户需补充静态站所在的 GitHub repo（`owner/repo`），用于 `promote.js` 通过 MCP 提交 JSON 文件。如果生产站不在 GitHub 上（例如直接上传到 Cloudflare Pages），则需改用 Cloudflare Pages Deploy Hook + 直接上传 JSON 到 Pages。
2. **管理员身份**：复用 `cmt.axxxx.cyou` 的 admin JWT（同站 Cookie，`axxxx.cyou` zone 在同账号下），或独立配置一个 admin token 写入 Worker secret。默认走前者，减少额外登录。
3. **Steam 创意工坊 ID 提取**：依赖 `downloadLinks[].url` 中包含 `steamcommunity.com/sharedfiles/filedetails/?id=数字` 模式。若部分模组的创意工坊链接在 `description` 字段里，需人工补录到 `mod_sources` 表。
4. **不迁移不影响的承诺**：阶段 1-2 完成后，所有改动都在 `test.axxxx.cyou` + `sync.axxxx.cyou` 上；生产站 `axxxx.cyou` 唯一的代码改动是 main.js 的 hostname 切换（生产路径不变），用户可随时回滚。
5. **预算**：Cloudflare Workers 免费额度（10 万请求/天）+ D1（5GB/5M 读每天）+ KV（10 万读/天）+ Steam API（免费）= **0 元/月**。即便升级 Workers Paid（$5/月 ≈ 35 元）也远低于 500 元预算。
6. **现有 cmt worker 不动**：所有新功能在新 Worker 内实现，避免触碰缺失的 `index.js` 等文件。

---

## 验证步骤

### 阶段 1 验证
- [ ] `curl https://sync.axxxx.cyou/api/mods?env=staging | jq length` 返回 ≈200
- [ ] `curl https://sync.axxxx.cyou/api/mods?env=prod | jq length` 返回 ≈200（与 staging 初始一致）
- [ ] 浏览器打开 `https://test.axxxx.cyou` → 模组列表加载正常，数量与 `axxxx.cyou` 一致
- [ ] 浏览器打开 `https://axxxx.cyou` → 数据源仍为静态 JSON（DevTools Network 检查请求路径未变）
- [ ] Cloudflare Dashboard → D1 → `sts2_modsync` → 表数据正常
- [ ] Cloudflare Dashboard → Workers → `sts2-modsync` → Logs 无错误

### 阶段 2 验证
- [ ] 访问 `https://sync.axxxx.cyou/admin` → 登录后看到模组列表
- [ ] 编辑某个模组 badge（如 `v0.3.7` → `v0.3.8-test`）→ 保存
- [ ] 刷新 `https://test.axxxx.cyou` → 该模组显示新 badge
- [ ] 刷新 `https://axxxx.cyou` → 该模组仍显示旧 badge（未迁移）
- [ ] 点「迁移到生产」→ 弹窗显示 diff + 要求输入确认词 → 确认
- [ ] GitHub repo 出现新 commit（修改 `sts2_mods_1.json`）
- [ ] Cloudflare Pages 自动重建完成后 → `https://axxxx.cyou` 显示新 badge
- [ ] `promotions_log` 表有记录

### 阶段 3 验证
- [ ] Cloudflare Dashboard → Cron Triggers → 手动触发 `steam.pollAll`
- [ ] Worker Logs 显示轮询了 N 个 Steam 源
- [ ] 管理面板「待审核」页签出现条目（若某模组工坊有更新）
- [ ] 访问 `https://sync.axxxx.cyou/api/submit` 表单 → 提交一条新版本通知 → 管理面板「待审核」出现该条
- [ ] 通过审核 → 进入 staging → 可迁移到生产

---

## 文件清单总览

**新建**：
- `modsync-worker/wrangler.toml`
- `modsync-worker/src/index.js`
- `modsync-worker/src/db.js`
- `modsync-worker/src/utils.js`
- `modsync-worker/src/schema.sql`
- `modsync-worker/src/steam.js`
- `modsync-worker/src/admin.js`
- `modsync-worker/src/promote.js`
- `modsync-worker/src/submission.js`
- `modsync-worker/src/publicApi.js`
- `modsync-worker/admin-ui/index.html`
- `modsync-worker/scripts/import-initial.mjs`

**修改**（生产站，最小化）：
- [resources/js/main.js](file:///workspace/resources/js/main.js#L315-L318)（dataSources + loadManifest/loadJsonByManifest 增加 hostname 切换）
- [index.html](file:///workspace/index.html#L162)（可选：加 `window.MODSYNC_API` 常量）

**不动**：
- `worker/`（现有 cmt.axxxx.cyou 评论 Worker，全部保持原样）
- `resources/json/post/sts2_mods/sts2_mods_1.json`（生产数据文件，仅 promote 时由 GitHub MCP 覆盖）
- 其他所有 `resources/` 静态资源
