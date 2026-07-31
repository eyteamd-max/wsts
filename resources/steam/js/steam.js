// steam.js — STS2 创意工坊解析站前端逻辑

const API_BASE = window.STEAM_API_BASE || '';

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const searchInput = $('searchInput');
const parseBtn = $('parseBtn');
const resultsGrid = $('resultsGrid');
const emptyState = $('emptyState');
const loadingMore = $('loadingMore');
const loadingOverlay = $('loadingOverlay');
const mainContent = $('mainContent');
const modalOverlay = $('modalOverlay');
const modalClose = $('modalClose');
const modalBody = $('modalBody');
const lightbox = $('lightbox');
const lightboxImg = $('lightboxImg');
const lightboxClose = $('lightboxClose');
const toast = $('toast');
const themeToggle = $('themeToggle');

// ---------- 初始化 ----------
function init() {
  // 隐藏 loading
  setTimeout(() => {
    loadingOverlay.classList.add('hidden');
    mainContent.style.opacity = '1';
  }, 400);

  // 主题
  const savedTheme = localStorage.getItem('steam-theme');
  if (savedTheme === 'dark') document.documentElement.classList.add('dark');

  // 事件绑定
  parseBtn.addEventListener('click', handleParse);
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleParse();
  });
  modalClose.addEventListener('click', closeModal);
  modalOverlay.addEventListener('click', (e) => {
    if (e.target === modalOverlay) closeModal();
  });
  lightboxClose.addEventListener('click', () => lightbox.classList.remove('active'));
  lightbox.addEventListener('click', (e) => {
    if (e.target === lightbox) lightbox.classList.remove('active');
  });
  themeToggle.addEventListener('click', toggleTheme);

  // 示例按钮
  document.querySelectorAll('.example-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      searchInput.value = btn.dataset.example;
      handleParse();
    });
  });

  // ESC 关闭
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeModal();
      lightbox.classList.remove('active');
    }
  });
}

// ---------- 主题切换 ----------
function toggleTheme() {
  const isDark = document.documentElement.classList.toggle('dark');
  localStorage.setItem('steam-theme', isDark ? 'dark' : 'light');
  $('themeIconSun').style.display = isDark ? 'none' : 'block';
  $('themeIconMoon').style.display = isDark ? 'block' : 'none';
}

// ---------- 解析逻辑 ----------
async function handleParse() {
  const input = searchInput.value.trim();
  if (!input) {
    showToast('请输入模组 ID 或链接', 'error');
    return;
  }

  // 从输入中提取所有模组 ID
  const ids = extractIds(input);
  if (!ids.length) {
    showToast('未识别到有效的模组 ID', 'error');
    return;
  }

  if (ids.length > 50) {
    showToast('单次最多解析 50 个模组', 'error');
    return;
  }

  // 显示加载
  emptyState.style.display = 'none';
  loadingMore.style.display = 'flex';
  parseBtn.disabled = true;
  resultsGrid.innerHTML = '';

  try {
    const url = `${API_BASE}/api/parse?ids=${ids.join(',')}`;
    const resp = await fetch(url);
    const data = await resp.json();

    if (!resp.ok) {
      throw new Error(data.error || '解析失败');
    }

    if (!data.items || data.items.length === 0) {
      throw new Error('未找到任何模组');
    }

    renderResults(data.items);
    showToast(`成功解析 ${data.items.length} 个模组`, 'success');
  } catch (err) {
    showToast(err.message || '解析失败', 'error');
    emptyState.style.display = 'block';
  } finally {
    loadingMore.style.display = 'none';
    parseBtn.disabled = false;
  }
}

/**
 * 从输入中提取模组 ID
 * 支持：纯数字 ID、Steam 工坊链接、逗号分隔
 */
function extractIds(input) {
  const ids = new Set();
  // 匹配 7-12 位数字（Steam Workshop ID 通常是 9-10 位）
  const matches = input.match(/\d{7,12}/g) || [];
  matches.forEach(id => ids.add(id));
  return Array.from(ids);
}

// ---------- 渲染结果 ----------
function renderResults(items) {
  resultsGrid.innerHTML = items.map(item => renderCard(item)).join('');

  // 绑定事件
  resultsGrid.querySelectorAll('.mod-card').forEach((card, i) => {
    const item = items[i];
    card.addEventListener('click', (e) => {
      if (e.target.closest('.btn-download')) return;
      openModal(item);
    });
    const dlBtn = card.querySelector('.btn-download');
    if (dlBtn) {
      dlBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        handleDownload(item);
      });
    }
  });
}

function renderCard(item) {
  const cover = item.coverImage
    ? `<img src="${escapeHtml(item.coverImage)}" alt="${escapeHtml(item.title)}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';">
       <div class="mod-cover-placeholder" style="display:none;">${escapeHtml(item.title.charAt(0) || '?')}</div>`
    : `<div class="mod-cover-placeholder">${escapeHtml(item.title.charAt(0) || '?')}</div>`;

  const sizeText = item.fileSizeFormatted || '未知';
  const updatedText = item.timeUpdatedFormatted || '未知';

  return `
    <div class="mod-card" data-id="${escapeHtml(item.publishedfileid)}">
      <div class="mod-cover">
        ${cover}
        <span class="mod-badge">Steam</span>
      </div>
      <div class="mod-info">
        <div class="mod-title">${escapeHtml(item.title || '未命名模组')}</div>
        <div class="mod-desc">${escapeHtml(stripHtml(item.description || item.shortDescription || '暂无简介'))}</div>
        <div class="mod-meta">
          <span class="mod-meta-item">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            ${sizeText}
          </span>
          <span class="mod-meta-item">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
            ${updatedText}
          </span>
        </div>
        <div class="mod-stats">
          <span class="mod-stat">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            ${formatNumber(item.views)}
          </span>
          <span class="mod-stat">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
            ${formatNumber(item.lifetimeSubscriptions)}
          </span>
        </div>
        <div class="mod-actions">
          <button class="btn-download">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            下载
          </button>
          <button class="btn-detail">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
            详情
          </button>
        </div>
      </div>
    </div>
  `;
}

// ---------- 详情弹窗 ----------
function openModal(item) {
  const cover = item.coverImage
    ? `<img class="modal-cover" src="${escapeHtml(item.coverImage)}" alt="${escapeHtml(item.title)}" onerror="this.style.display='none'">`
    : '';

  const tags = (item.tags || []).map(t =>
    `<span class="modal-tag">${escapeHtml(t.tag)}</span>`
  ).join('');

  const previews = (item.previews || []).slice(0, 9).map(p =>
    `<img class="modal-preview" src="${escapeHtml(p.url)}" alt="预览图" loading="lazy" onerror="this.style.display='none'">`
  ).join('');

  const versions = (item.supportedVersions || []).map(v =>
    `<span class="modal-version">v${escapeHtml(v)}</span>`
  ).join('');

  const desc = stripHtml(item.description || item.shortDescription || '暂无描述');

  modalBody.innerHTML = `
    ${cover}
    <div class="modal-body">
      <h2 class="modal-title">${escapeHtml(item.title || '未命名模组')}</h2>
      <div class="modal-meta">
        <span class="modal-meta-item">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          ${escapeHtml(item.fileSizeFormatted || '未知')}
        </span>
        <span class="modal-meta-item">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
          更新: ${escapeHtml(item.timeUpdatedFormatted || '未知')}
        </span>
        <span class="modal-meta-item">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
          发布: ${escapeHtml(item.timeCreatedFormatted || '未知')}
        </span>
        <span class="modal-meta-item">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          ${formatNumber(item.views)} 浏览
        </span>
        <span class="modal-meta-item">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
          ${formatNumber(item.lifetimeSubscriptions)} 订阅
        </span>
      </div>

      ${versions ? `
      <div class="modal-section">
        <div class="modal-section-title">支持版本</div>
        <div class="modal-versions">${versions}</div>
      </div>` : ''}

      ${tags ? `
      <div class="modal-section">
        <div class="modal-section-title">标签</div>
        <div class="modal-tags">${tags}</div>
      </div>` : ''}

      <div class="modal-section">
        <div class="modal-section-title">简介</div>
        <div class="modal-desc">${escapeHtml(desc)}</div>
      </div>

      ${previews ? `
      <div class="modal-section">
        <div class="modal-section-title">预览图</div>
        <div class="modal-previews">${previews}</div>
      </div>` : ''}

      <div class="modal-download-bar">
        <button class="btn-modal-download" onclick="window._downloadMod('${escapeHtml(item.publishedfileid)}')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          下载模组 (${escapeHtml(item.fileSizeFormatted || '未知大小')})
        </button>
        <a class="btn-steam-link" href="${escapeHtml(item.workshopUrl)}" target="_blank" rel="noopener noreferrer">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
          工坊页面
        </a>
      </div>
    </div>
  `;

  // 绑定预览图点击
  modalBody.querySelectorAll('.modal-preview').forEach(img => {
    img.addEventListener('click', () => {
      lightboxImg.src = img.src;
      lightbox.classList.add('active');
    });
  });

  modalOverlay.classList.add('active');
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  modalOverlay.classList.remove('active');
  document.body.style.overflow = '';
}

// ---------- 下载 ----------
window._downloadMod = function(id) {
  const url = `${API_BASE}/api/download/${id}`;
  // 直接触发下载（浏览器会处理重定向和文件）
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  showToast('开始下载...', 'success');
};

async function handleDownload(item) {
  window._downloadMod(item.publishedfileid);
}

// ---------- 工具函数 ----------
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function stripHtml(str) {
  if (!str) return '';
  return String(str).replace(/\[url=.*?\]|\[\/url\]|\[b\]|\[\/b\]|\[i\]|\[\/i\]|\[h1\]|\[\/h1\]|\[h2\]|\[\/h2\]|\[img\]|\[\/img\]|\[list\]|\[\/list\]|\[\*\]|\[code\]|\[\/code\]|\[quote\]|\[\/quote\]/g, '')
    .replace(/<[^>]*>/g, '')
    .trim();
}

function formatNumber(n) {
  if (!n || n === 0) return '0';
  if (n < 1000) return String(n);
  if (n < 1000000) return (n / 1000).toFixed(1) + 'K';
  return (n / 1000000).toFixed(1) + 'M';
}

function showToast(message, type = '') {
  toast.textContent = message;
  toast.className = 'toast show' + (type ? ' ' + type : '');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toast.classList.remove('show');
  }, 3000);
}

// ---------- 启动 ----------
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
