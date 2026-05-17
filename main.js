/**
 * STS2 MOD 站 - Supabase 版前端 main.js
 * 
 * 修改说明：
 * 1. 数据源从本地 JSON 切换到 Supabase REST API
 * 2. 修复需求一：搜索框输入后按回车，页面刷新问题 → e.preventDefault()
 * 3. 修复需求二：分区切换时搜索框残留 → 切换时清空搜索框
 * 4. 修复需求三：RID 全站搜索 → 跨分区搜索支持
 * 5. 修复需求四：大 JSON 性能风险 → Supabase 服务端查询
 */

// ==================== 配置区（部署时修改） ====================
const SUPABASE_URL = 'https://bijoqrdxjtvcdmwboorq.supabase.co';  // ← 替换为你的 Supabase URL
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJpam9xcmR4anR2Y2Rtd2Jvb3JxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg5OTAxNjYsImV4cCI6MjA5NDU2NjE2Nn0.M_d19L5FsDXpfuyLfg05ruZOb86v_66qL2pF2ZYxwTw';                // ← 替换为你的 anon key

// ==================== Supabase 数据层 ====================
const API = `${SUPABASE_URL}/rest/v1/mods`;
const HEADERS = {
  'apikey': SUPABASE_ANON_KEY,
  'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
  'Content-Type': 'application/json'
};

// 缓存：避免重复请求
const cache = { all: null, skin: null };

/**
 * 从 Supabase 获取指定分区的 MOD 数据
 * @param {string} source - 'all' | 'skin'
 * @param {boolean} forceRefresh - 是否强制刷新缓存
 * @returns {Promise<Array>}
 */
async function fetchModData(source, forceRefresh = false) {
  if (!forceRefresh && cache[source]) return cache[source];

  try {
    const res = await fetch(`${API}?source=eq.${source}&select=*&order=id.desc`, {
      headers: HEADERS
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    cache[source] = data;
    return data;
  } catch (e) {
    console.error(`获取 ${source} 分区数据失败:`, e);
    return [];
  }
}

/**
 * 搜索 MOD（支持标题、标签模糊搜索 + RID 精确搜索）
 * @param {string} query - 搜索关键词
 * @param {string} source - 当前分区
 * @returns {Promise<Array>}
 */
async function searchMods(query, source) {
  const lowerQuery = query.toLowerCase().trim();
  if (!lowerQuery) return fetchModData(source);

  // RID 精确搜索：跨分区
  if (lowerQuery.startsWith('rid:')) {
    const ridPart = lowerQuery.slice(4).trim();
    const [allData, skinData] = await Promise.all([
      fetchModData('all'),
      fetchModData('skin')
    ]);
    const combined = [...allData, ...skinData];
    // 去重
    const seen = new Set();
    const unique = combined.filter(m => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });
    return unique.filter(m => m.id === ridPart);
  }

  // 普通搜索：仅在当前分区
  const data = await fetchModData(source);
  return data.filter(m => {
    if (m.title && m.title.toLowerCase().includes(lowerQuery)) return true;
    if (m.tags && Array.isArray(m.tags) && m.tags.some(tag =>
      typeof tag === 'string' && tag.toLowerCase().includes(lowerQuery)
    )) return true;
    return false;
  });
}

// ==================== 全局状态 ====================
let modData = [];           // 当前显示的 MOD 列表
let activeCategory = 'all'; // 当前分区：'all' | 'skin'
let currentSearch = '';     // 当前搜索词

// ==================== 需求修复一：搜索框回车不刷新 ====================
function fixSearchForm() {
  const searchForm = document.querySelector('.search-form') || document.querySelector('form');
  const searchInput = document.querySelector('#searchInput') || document.querySelector('.search-input');

  if (searchForm) {
    searchForm.addEventListener('submit', (e) => {
      e.preventDefault();  // ← 关键：阻止默认提交行为
      performSearch();
    });
  }

  if (searchInput) {
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();  // ← 双重保险
        performSearch();
      }
    });
  }
}

// ==================== 需求修复二：分区切换时清空搜索框 ====================
function fixCategorySwitch() {
  const categoryBtns = document.querySelectorAll('.category-btn, .tab-btn, [data-category]');
  const searchInput = document.querySelector('#searchInput') || document.querySelector('.search-input');

  categoryBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      // 切换分区时清空搜索框
      if (searchInput) {
        searchInput.value = '';
        currentSearch = '';
      }
    });
  });
}

// ==================== 需求修复三：RID 全站搜索 ====================
// 已在 searchMods() 函数中实现
// 当搜索词以 "rid:" 开头时，自动跨分区搜索

// ==================== 核心渲染函数 ====================

/**
 * 执行搜索
 */
async function performSearch() {
  const searchInput = document.querySelector('#searchInput') || document.querySelector('.search-input');
  const query = searchInput ? searchInput.value.trim() : '';
  currentSearch = query;

  const results = await searchMods(query, activeCategory);
  modData = results;
  renderModCards(modData);
}

/**
 * 加载指定分区的 MOD 数据
 * @param {string} category - 'all' | 'skin'
 */
async function loadModData(category) {
  activeCategory = category;
  modData = await fetchModData(category);
  renderModCards(modData);
}

/**
 * 渲染 MOD 卡片列表
 * @param {Array} mods - MOD 数据数组
 */
function renderModCards(mods) {
  const container = document.querySelector('.mod-grid') || document.querySelector('#modGrid') || document.querySelector('.cards-container');
  if (!container) return;

  if (mods.length === 0) {
    container.innerHTML = `
      <div style="grid-column: 1/-1; text-align: center; padding: 3rem; color: #888;">
        <div style="font-size: 3rem; margin-bottom: 1rem;">🔍</div>
        <p>没有找到匹配的 MOD</p>
      </div>`;
    return;
  }

  container.innerHTML = mods.map(mod => renderSingleCard(mod)).join('');
}

/**
 * 渲染单个 MOD 卡片
 * @param {Object} mod - 单条 MOD 数据
 * @returns {string} HTML 字符串
 */
function renderSingleCard(mod) {
  const coverImg = Array.isArray(mod.coverImage) && mod.coverImage.length > 0
    ? mod.coverImage[0]
    : null;

  const coverStyle = coverImg
    ? `background-image: url('${coverImg}'); background-size: cover; background-position: center;`
    : `background: ${mod.coverGradient || 'linear-gradient(135deg, #fce4e4 0%, #f8d0d0 100%)'};`;

  const badgeHtml = mod.badge
    ? `<span class="card-badge ${mod.badgeClass || ''}">${mod.badge}</span>`
    : '';

  const tagsHtml = Array.isArray(mod.tags) && mod.tags.length > 0
    ? `<div class="card-tags">${mod.tags.map(t => `<span class="tag">${t}</span>`).join('')}</div>`
    : '';

  return `
    <div class="mod-card" data-id="${mod.id}" onclick="openModDetail('${mod.id}')">
      <div class="card-cover" style="${coverStyle}">
        ${!coverImg && mod.coverChar ? `<span class="cover-char">${mod.coverChar}</span>` : ''}
        ${badgeHtml}
      </div>
      <div class="card-body">
        <h3 class="card-title">${mod.title || '未命名'}</h3>
        <div class="card-meta">
          ${mod.author ? `<span class="card-author">${mod.author}</span>` : ''}
          ${mod.size && mod.size !== 'None' ? `<span class="card-size">${mod.size}</span>` : ''}
        </div>
        ${tagsHtml}
      </div>
    </div>`;
}

/**
 * 打开 MOD 详情
 * @param {string} id - MOD 的 RID
 */
async function openModDetail(id) {
  // 先从缓存查找
  const allMods = [...(cache.all || []), ...(cache.skin || [])];
  let mod = allMods.find(m => m.id === id);

  // 缓存没有则从 Supabase 单条查询
  if (!mod) {
    try {
      const res = await fetch(`${API}?id=eq.${id}`, { headers: HEADERS });
      if (res.ok) {
        const data = await res.json();
        mod = data[0];
      }
    } catch (e) {
      console.error('获取 MOD 详情失败:', e);
    }
  }

  if (!mod) return;

  // 填充详情弹窗
  const detailModal = document.querySelector('#detailModal') || document.querySelector('.detail-modal');
  if (!detailModal) return;

  const images = Array.isArray(mod.images) ? mod.images : [];
  const previewImages = Array.isArray(mod.previewImages) ? mod.previewImages : [];
  const previewVideos = Array.isArray(mod.previewVideos) ? mod.previewVideos : [];
  const downloadLinks = Array.isArray(mod.downloadLinks) ? mod.downloadLinks : [];
  const authorLinks = Array.isArray(mod.authorLinks) ? mod.authorLinks : [];
  const tags = Array.isArray(mod.tags) ? mod.tags : [];

  // 构建详情 HTML（根据你现有的详情弹窗结构调整）
  detailModal.innerHTML = buildDetailHTML(mod, images, previewImages, previewVideos, downloadLinks, authorLinks, tags);
  detailModal.classList.add('active');
}

/**
 * 构建详情页 HTML
 */
function buildDetailHTML(mod, images, previewImages, previewVideos, downloadLinks, authorLinks, tags) {
  const coverImg = Array.isArray(mod.coverImage) && mod.coverImage.length > 0
    ? mod.coverImage[0]
    : null;

  const coverStyle = coverImg
    ? `background-image: url('${coverImg}'); background-size: cover; background-position: center;`
    : `background: ${mod.coverGradient || 'linear-gradient(135deg, #fce4e4 0%, #f8d0d0 100%)'};`;

  const imagesHtml = images.length > 0
    ? `<div class="detail-images">${images.map(src => `<img src="${src}" alt="预览图" loading="lazy">`).join('')}</div>`
    : '';

  const previewImagesHtml = previewImages.length > 0
    ? `<div class="detail-preview-images">${previewImages.map(src => `<img src="${src}" alt="预览" loading="lazy">`).join('')}</div>`
    : '';

  const previewVideosHtml = previewVideos.length > 0
    ? `<div class="detail-preview-videos">${previewVideos.map(v => {
        const urls = v.urls || [v];
        return urls.map(url => {
          if (url.includes('bilibili') || url.includes('youtube')) {
            return `<iframe src="${url}" frameborder="0" allowfullscreen></iframe>`;
          }
          return `<video controls src="${url}"></video>`;
        }).join('');
      }).join('')}</div>`
    : '';

  const downloadHtml = downloadLinks.length > 0
    ? `<div class="detail-downloads">
        <h3>下载链接</h3>
        ${downloadLinks.map(dl => `<a href="${dl.url || dl}" target="_blank" class="download-btn">${dl.name || '下载'}</a>`).join('')}
      </div>`
    : '';

  const authorHtml = mod.author
    ? `<div class="detail-author">
        <span>作者：${mod.author}</span>
        ${authorLinks.map(al => `<a href="${al.url || al}" target="_blank">${al.name || '主页'}</a>`).join('')}
      </div>`
    : '';

  const tagsHtml = tags.length > 0
    ? `<div class="detail-tags">${tags.map(t => `<span class="tag">${t}</span>`).join('')}</div>`
    : '';

  return `
    <div class="detail-content">
      <button class="detail-close" onclick="closeDetail()">&times;</button>
      <div class="detail-cover" style="${coverStyle}">
        ${!coverImg && mod.coverChar ? `<span class="cover-char">${mod.coverChar}</span>` : ''}
      </div>
      <div class="detail-info">
        <h2>${mod.title || '未命名'}</h2>
        <div class="detail-meta">
          <span class="detail-rid">RID: ${mod.id}</span>
          ${mod.size && mod.size !== 'None' ? `<span class="detail-size">${mod.size}</span>` : ''}
          ${mod.date ? `<span class="detail-date">${mod.date}</span>` : ''}
        </div>
        ${authorHtml}
        ${tagsHtml}
        ${mod.description ? `<div class="detail-desc">${mod.description}</div>` : ''}
        ${imagesHtml}
        ${previewImagesHtml}
        ${previewVideosHtml}
        ${downloadHtml}
      </div>
    </div>`;
}

function closeDetail() {
  const detailModal = document.querySelector('#detailModal') || document.querySelector('.detail-modal');
  if (detailModal) detailModal.classList.remove('active');
}

// ==================== 搜索下拉提示 ====================
function updateSearchDropdown(query) {
  const dropdown = document.querySelector('.search-dropdown') || document.querySelector('#searchDropdown');
  if (!dropdown) return;

  if (!query.trim()) {
    dropdown.classList.remove('active');
    return;
  }

  const lowerQuery = query.toLowerCase();
  const suggestions = modData
    .filter(m => m.title && m.title.toLowerCase().includes(lowerQuery))
    .slice(0, 8);

  if (suggestions.length === 0) {
    dropdown.classList.remove('active');
    return;
  }

  dropdown.innerHTML = suggestions.map(m =>
    `<div class="dropdown-item" onclick="selectSuggestion('${m.id}', '${m.title.replace(/'/g, "\\'")}')">
      <span class="dropdown-title">${m.title}</span>
      <span class="dropdown-rid">${m.id}</span>
    </div>`
  ).join('');
  dropdown.classList.add('active');
}

function selectSuggestion(id, title) {
  const searchInput = document.querySelector('#searchInput') || document.querySelector('.search-input');
  if (searchInput) searchInput.value = title;
  const dropdown = document.querySelector('.search-dropdown') || document.querySelector('#searchDropdown');
  if (dropdown) dropdown.classList.remove('active');
  openModDetail(id);
}

// ==================== 页面初始化 ====================
async function initPage() {
  // 修复一：搜索框回车不刷新
  fixSearchForm();

  // 修复二：分区切换清空搜索框
  fixCategorySwitch();

  // 后台静默预热两个分区数据到缓存，避免 RID 全站搜索时冷启动等待
  await Promise.all([
    fetchModData('all'),
    fetchModData('skin')
  ]);

  // 加载默认分区
  loadModData('all');
}

// 搜索输入实时提示
document.addEventListener('DOMContentLoaded', () => {
  const searchInput = document.querySelector('#searchInput') || document.querySelector('.search-input');
  if (searchInput) {
    let debounceTimer;
    searchInput.addEventListener('input', (e) => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        updateSearchDropdown(e.target.value);
      }, 300);
    });
  }
});

// 启动
initPage();
