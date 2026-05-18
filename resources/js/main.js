(function() {
  'use strict';

  // ========== 工具函数 ==========

  function raceImage(urls, timeout) {
    if (!urls || !urls.length) return Promise.reject(new Error('No URLs'));
    timeout = timeout || 3500;
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) { settled = true; reject(new Error('raceImage timeout')); }
      }, timeout + 3000);
      urls.forEach(url => {
        if (!url) return;
        const img = new Image();
        img.onload = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(url); } };
        img.onerror = () => {};
        img.src = url;
      });
    });
  }

  function raceVideo(urls) {
    if (!urls || !urls.length) return Promise.reject(new Error('No video URLs'));
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) { settled = true; reject(new Error('raceVideo timeout')); }
      }, 8000);
      urls.forEach(url => {
        if (!url) return;
        const video = document.createElement('video');
        video.onloadeddata = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(url); } };
        video.onerror = () => {};
        video.src = url;
      });
    });
  }

  function toCandidates(item) {
    if (Array.isArray(item)) return item.filter(Boolean);
    if (typeof item === 'string' && item) return [item];
    return [];
  }

  function sortModsByTimeId(dataArray) {
    return dataArray.slice().sort((a, b) => {
      const idA = String(a.id || '');
      const idB = String(b.id || '');
      return idB.localeCompare(idA);
    });
  }

  function showToast(message) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    clearTimeout(showToast._timer);
    toast.textContent = message;
    toast.classList.add('show');
    showToast._timer = setTimeout(() => { toast.classList.remove('show'); }, 2200);
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        showToast('已复制: ' + text);
      }).catch(() => { fallbackCopy(text); });
    } else {
      fallbackCopy(text);
    }
  }

  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none;';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    try { document.execCommand('copy'); showToast('已复制: ' + text); }
    catch(e) { showToast('复制失败，请手动复制'); }
    document.body.removeChild(ta);
  }

  function debounce(fn, delay) {
    let timer = null;
    return function(...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), delay);
    };
  }

  // ========== 常量 ==========

  const CATEGORY_DIR_MAP = {
    all: 'sts2_mods',
    skin: 'O.o_interface'
  };

  const SITE_DOMAIN = 'axxxx.cyou';
  const ITEMS_PER_PAGE = 8;
  const JSON_TIMEOUT = 8000;
  const FALLBACK_LOADED2 = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

  // ========== DOM 引用 ==========

  const loadingOverlay = document.getElementById('loadingOverlay');
  const loadingGif = document.getElementById('loadingGif');
  const potionWrapper = document.getElementById('potionWrapper');
  const mainContent = document.getElementById('mainContent');
  const logoArea = document.getElementById('logoArea');
  const logoImg = document.getElementById('logoImg');
  const logoTower = document.getElementById('logoTower');
  const searchInput = document.getElementById('searchInput');
  const searchClear = document.getElementById('searchClear');
  const searchDropdown = document.getElementById('searchDropdown');
  const categoryBar = document.getElementById('categoryBar');
  const modGrid = document.getElementById('modGrid');
  const paginationWrap = document.getElementById('paginationWrap');
  const manifestError = document.getElementById('manifestError');
  const manifestRetryBtn = document.getElementById('manifestRetryBtn');
  const modalOverlay = document.getElementById('modalOverlay');
  const modalContent = document.getElementById('modalContent');
  const modalClose = document.getElementById('modalClose');
  const modalTitle = document.getElementById('modalTitle');
  const modalBadge = document.getElementById('modalBadge');
  const modalAuthor = document.getElementById('modalAuthor');
  const modalDate = document.getElementById('modalDate');
  const modalSize = document.getElementById('modalSize');
  const modalRid = document.getElementById('modalRid');
  const ridValue = document.getElementById('ridValue');
  const ridPopup = document.getElementById('ridPopup');
  const modalTags = document.getElementById('modalTags');
  const carouselContainer = document.getElementById('carouselContainer');
  const carouselTrack = document.getElementById('carouselTrack');
  const carouselPrev = document.getElementById('carouselPrev');
  const carouselNext = document.getElementById('carouselNext');
  const carouselDots = document.getElementById('carouselDots');
  const modalDescription = document.getElementById('modalDescription');
  const modalDownloads = document.getElementById('modalDownloads');
  const previewSection = document.getElementById('previewSection');
  const previewImagesBtn = document.getElementById('previewImagesBtn');
  const previewVideosBtn = document.getElementById('previewVideosBtn');
  const previewContentArea = document.getElementById('previewContentArea');
  const lightboxOverlay = document.getElementById('lightboxOverlay');
  const lightboxImg = document.getElementById('lightboxImg');
  const lightboxClose = document.getElementById('lightboxClose');
  const charaOverlay = document.getElementById('charaOverlay');
  const charaClose = document.getElementById('charaClose');
  const charaImg = document.getElementById('charaImg');

  // ========== 状态 ==========

  let manifestLoaded = false;
  let categoryRanges = {};       // { dirName: {start, end} }
  let currentPage = 1;
  let totalPages = 1;
  let isSearchMode = false;
  let modData = [];              // 当前显示数据
  let pageDataCache = {};        // { url: [...] } 单页缓存
  let allCategoryDataCache = {}; // { categoryKey: [...] } 全分类缓存（搜索用）
  let allCategoriesDataCache = null; // 全站缓存（RID搜索用）
  let activeCategory = 'all';
  let currentMod = null;
  let activePreviewTab = null;
  let currentImages = [];
  let currentIndex = 0;
  let ridPopupMod = null;

  // ========== Manifest 加载 ==========

  async function loadManifest() {
    try {
      const resp = await fetchWithTimeout('resources/json/post/manifest.json');
      const data = await resp.json();
      categoryRanges = {};
      for (const key in data) {
        const rangeStr = String(data[key]);
        const parts = rangeStr.split('~');
        if (parts.length === 2) {
          categoryRanges[key] = { start: parseInt(parts[0]), end: parseInt(parts[1]) };
        }
      }
      manifestLoaded = true;
      return true;
    } catch (e) {
      console.error('manifest.json 加载失败:', e);
      manifestLoaded = false;
      return false;
    }
  }

  function getJsonUrl(dirName, pageNum) {
    return 'resources/json/post/' + dirName + '/' + dirName + '_' + pageNum + '.json';
  }

  function getTotalPagesForCategory(categoryKey) {
    const dir = CATEGORY_DIR_MAP[categoryKey];
    if (!dir || !categoryRanges[dir]) return 0;
    return categoryRanges[dir].end - categoryRanges[dir].start + 1;
  }

  // ========== 数据加载 ==========

  async function fetchWithTimeout(url, timeout) {
    timeout = timeout || JSON_TIMEOUT;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const resp = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      return resp;
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  }

  async function loadPageData(categoryKey, page) {
    const dir = CATEGORY_DIR_MAP[categoryKey];
    if (!dir) return [];
    const url = getJsonUrl(dir, page);
    if (pageDataCache[url]) return pageDataCache[url];
    try {
      const resp = await fetchWithTimeout(url);
      const data = await resp.json();
      const arr = Array.isArray(data) ? data : (data.mods || data.data || []);
      pageDataCache[url] = arr;
      return arr;
    } catch (e) {
      console.error('加载 ' + url + ' 失败:', e);
      pageDataCache[url] = null; // 标记失败
      return null;
    }
  }

  async function loadAllDataForCategory(categoryKey) {
    if (allCategoryDataCache[categoryKey]) return allCategoryDataCache[categoryKey];
    const dir = CATEGORY_DIR_MAP[categoryKey];
    if (!dir || !categoryRanges[dir]) return [];
    const range = categoryRanges[dir];
    const allData = [];
    const promises = [];
    for (let i = range.start; i <= range.end; i++) {
      promises.push(loadPageData(categoryKey, i));
    }
    const results = await Promise.allSettled(promises);
    results.forEach(r => {
      if (r.status === 'fulfilled' && Array.isArray(r.value)) {
        allData.push(...r.value);
      }
    });
    allCategoryDataCache[categoryKey] = allData;
    return allData;
  }

  async function loadAllCategoriesData() {
    if (allCategoriesDataCache) return allCategoriesDataCache;
    const allData = [];
    const promises = [];
    for (const catKey in CATEGORY_DIR_MAP) {
      promises.push(loadAllDataForCategory(catKey));
    }
    const results = await Promise.allSettled(promises);
    results.forEach(r => {
      if (r.status === 'fulfilled' && Array.isArray(r.value)) {
        allData.push(...r.value);
      }
    });
    allCategoriesDataCache = allData;
    return allData;
  }

  // ========== Carousel ==========

  function updateCarousel(images) {
    currentImages = images || [];
    currentIndex = 0;

    if (!currentImages.length) {
      carouselContainer.classList.add('no-images');
      carouselPrev.style.display = 'none';
      carouselNext.style.display = 'none';
      carouselDots.innerHTML = '';
      return;
    }

    carouselContainer.classList.remove('no-images');
    carouselPrev.style.display = '';
    carouselNext.style.display = '';

    carouselTrack.innerHTML = currentImages.map(src =>
      '<div class="carousel-slide"><img src="' + escapeAttr(src) + '" alt="轮播图" onerror="this.style.opacity=0.3;"></div>'
    ).join('');

    carouselDots.innerHTML = currentImages.map((_, i) =>
      '<span class="carousel-dot' + (i === 0 ? ' active' : '') + '" data-index="' + i + '"></span>'
    ).join('');

    setCurrentIndex(0);
  }

  function setCurrentIndex(idx) {
    if (idx < 0) idx = 0;
    if (idx >= currentImages.length) idx = currentImages.length - 1;
    currentIndex = idx;
    carouselTrack.style.transform = 'translateX(-' + (idx * 100) + '%)';
    carouselDots.querySelectorAll('.carousel-dot').forEach((dot, i) => {
      dot.classList.toggle('active', i === idx);
    });
  }

  // ========== Preview ==========

  function switchPreviewTab(tab) {
    if (activePreviewTab === tab) {
      activePreviewTab = null;
      previewImagesBtn.classList.remove('active');
      previewVideosBtn.classList.remove('active');
      previewContentArea.innerHTML = '';
      return;
    }
    activePreviewTab = tab;
    previewImagesBtn.classList.toggle('active', tab === 'images');
    previewVideosBtn.classList.toggle('active', tab === 'videos');
    renderPreviewContent();
  }

  function updatePreviewButtons() {
    if (!currentMod) return;
    const hasImages = (currentMod.previewImages && currentMod.previewImages.length) ||
                      (currentMod.images && currentMod.images.length);
    const hasVideos = currentMod.previewVideos && currentMod.previewVideos.length;
    previewImagesBtn.style.display = hasImages ? '' : 'none';
    previewVideosBtn.style.display = hasVideos ? '' : 'none';
    if (!hasImages && !hasVideos) {
      previewSection.style.display = 'none';
    } else {
      previewSection.style.display = '';
    }
  }

  function renderPreviewContent() {
    if (!currentMod) return;
    previewContentArea.innerHTML = '';
    if (activePreviewTab === 'images') {
      const items = currentMod.previewImages && currentMod.previewImages.length
        ? currentMod.previewImages
        : (currentMod.images || []);
      renderPreviewImages(items);
    } else if (activePreviewTab === 'videos') {
      renderPreviewVideos(currentMod.previewVideos || []);
    }
  }

  // 【功能5】预览图片加载增加三次重试
  async function loadImageWithRetry(urls, maxRetries) {
    maxRetries = maxRetries || 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const url = await raceImage(urls, 3500);
        return url;
      } catch (e) {
        if (attempt >= maxRetries) throw e;
        await new Promise(r => setTimeout(r, 400));
      }
    }
    throw new Error('All retries failed');
  }

  async function renderPreviewImages(items) {
    if (!items || !items.length) {
      previewContentArea.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:20px;">暂无预览图片</div>';
      return;
    }
    const grid = document.createElement('div');
    grid.className = 'preview-grid';
    previewContentArea.appendChild(grid);

    for (const item of items) {
      const candidates = toCandidates(item);
      if (!candidates.length) continue;

      const previewItem = document.createElement('div');
      previewItem.className = 'preview-item';
      // 加载 spinner
      const spinner = document.createElement('div');
      spinner.className = 'preview-spinner';
      previewItem.appendChild(spinner);
      grid.appendChild(previewItem);

      loadImageWithRetry(candidates, 3).then(url => {
        spinner.remove();
        const img = document.createElement('img');
        img.src = url;
        img.alt = '预览';
        img.loading = 'lazy';
        img.onerror = function() { this.style.opacity = '0.3'; };
        previewItem.appendChild(img);
        previewItem.addEventListener('click', () => openLightbox(url));
      }).catch(() => {
        spinner.remove();
        const errDiv = document.createElement('div');
        errDiv.className = 'preview-error';
        errDiv.innerHTML = '<span class="preview-error-icon">💔</span><span>加载失败</span>';
        previewItem.appendChild(errDiv);
      });
    }
  }

  async function renderPreviewVideos(items) {
    if (!items || !items.length) {
      previewContentArea.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:20px;">暂无预览视频</div>';
      return;
    }
    const grid = document.createElement('div');
    grid.className = 'preview-grid';
    previewContentArea.appendChild(grid);

    for (const item of items) {
      const candidates = toCandidates(item);
      if (!candidates.length) continue;

      const previewItem = document.createElement('div');
      previewItem.className = 'preview-item';
      const spinner = document.createElement('div');
      spinner.className = 'preview-spinner';
      previewItem.appendChild(spinner);
      grid.appendChild(previewItem);

      raceVideo(candidates).then(url => {
        spinner.remove();
        const video = document.createElement('video');
        video.src = url;
        video.controls = true;
        video.muted = true;
        video.preload = 'metadata';
        previewItem.appendChild(video);
      }).catch(() => {
        spinner.remove();
        const errDiv = document.createElement('div');
        errDiv.className = 'preview-error';
        errDiv.innerHTML = '<span class="preview-error-icon">💔</span><span>加载失败</span>';
        previewItem.appendChild(errDiv);
      });
    }
  }

  // ========== Modal ==========

  async function openModal(mod) {
    currentMod = mod;
    activePreviewTab = null;
    previewImagesBtn.classList.remove('active');
    previewVideosBtn.classList.remove('active');
    previewContentArea.innerHTML = '';

    modalTitle.textContent = mod.title || '未知MOD';
    modalBadge.textContent = mod.badge || '';
    modalBadge.style.display = mod.badge ? '' : 'none';
    modalAuthor.textContent = mod.author ? '作者: ' + mod.author : '';
    modalDate.textContent = mod.date || '';
    modalSize.textContent = mod.size ? '大小: ' + mod.size : '';

    // RID
    ridValue.textContent = mod.id || '';

    // Tags
    modalTags.innerHTML = '';
    if (mod.tags && mod.tags.length) {
      mod.tags.forEach(tag => {
        const span = document.createElement('span');
        span.className = 'modal-tag';
        span.textContent = tag;
        modalTags.appendChild(span);
      });
    }

    // Carousel
    const carouselImages = (mod.images && mod.images.length)
      ? mod.images
      : [];
    updateCarousel(carouselImages);

    // Description - 【功能7】链接高亮
    modalDescription.innerHTML = processDescription(mod.description);

    // Downloads
    modalDownloads.innerHTML = '';
    const downloadLinks = mod.downloadLinks || mod.downloads || [];
    if (downloadLinks.length) {
      downloadLinks.forEach(dl => {
        const a = document.createElement('a');
        a.className = 'download-btn';
        a.href = dl.url || dl.link || '#';
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = dl.text || dl.name || dl.label || '下载';
        modalDownloads.appendChild(a);
      });
    }

    // Preview
    updatePreviewButtons();

    // Show modal
    modalOverlay.classList.add('active');
    document.body.style.overflow = 'hidden';

    // 隐藏 RID 弹窗
    ridPopup.classList.remove('active');
  }

  function closeModal() {
    modalOverlay.classList.remove('active');
    document.body.style.overflow = '';
    currentMod = null;
    activePreviewTab = null;
    ridPopup.classList.remove('active');

    // 如果是从 RID URL 进入的，清理 URL 参数
    const params = new URLSearchParams(window.location.search);
    if (params.has('rid')) {
      const url = new URL(window.location);
      url.searchParams.delete('rid');
      history.replaceState({}, '', url);
    }
  }

  // 【功能7】详情页介绍文本中的链接高亮（粉色）
  function processDescription(text) {
    if (!text) return '暂无介绍';

    // 先提取 URL，避免 HTML 转义破坏 URL
    const urlRegex = /(https?:\/\/[^\s<>"']+)/g;
    const urls = [];
    let processed = text.replace(urlRegex, function(match) {
      const idx = urls.length;
      urls.push(match);
      return '%%URL_' + idx + '%%';
    });

    // HTML 转义
    processed = processed
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>');

    // 替换 URL 占位符为粉色高亮链接
    processed = processed.replace(/%%URL_(\d+)%%/g, function(match, idx) {
      const url = urls[parseInt(idx)];
      const escapedUrl = url.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
      return '<a href="' + escapedUrl + '" target="_blank" rel="noopener noreferrer" class="desc-link">' + escapedUrl + '</a>';
    });

    return processed;
  }

  function openLightbox(src) {
    lightboxImg.src = src;
    lightboxOverlay.classList.add('active');
    document.body.style.overflow = 'hidden';
  }

  function closeLightbox() {
    lightboxOverlay.classList.remove('active');
    lightboxImg.src = '';
    if (!modalOverlay.classList.contains('active')) {
      document.body.style.overflow = '';
    }
  }

  function openCharaDetail() {
    charaOverlay.classList.add('active');
    document.body.style.overflow = 'hidden';
  }

  // ========== Cards ==========

  // 【BUG修复2】卡片封面加载圈不消失 - 确保 spinner 在图片加载后移除
  function attachCardSpinner(cardElement) {
    const coverInner = cardElement.querySelector('.mod-cover-inner');
    const coverImg = coverInner ? coverInner.querySelector('.mod-cover-img') : null;
    if (!coverInner || !coverImg) return;

    const spinner = document.createElement('span');
    spinner.className = 'card-spinner';

    const hideSpinner = function() {
      spinner.style.display = 'none';
      if (spinner.parentNode) spinner.parentNode.removeChild(spinner);
    };

    coverInner.appendChild(spinner);

    // 检查图片是否已加载完成（缓存情况）
    if (coverImg.complete && coverImg.naturalWidth > 0) {
      hideSpinner();
    } else {
      coverImg.addEventListener('load', hideSpinner, { once: true });
      coverImg.addEventListener('error', hideSpinner, { once: true });
      // 安全超时：10秒后强制隐藏
      setTimeout(hideSpinner, 10000);
    }
  }

  function renderModCards(dataArray) {
    modGrid.innerHTML = '';

    if (!dataArray || !dataArray.length) {
      modGrid.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:40px 0;grid-column:1/-1;">未找到匹配的 MOD</div>';
      return;
    }

    dataArray.forEach(mod => {
      const card = document.createElement('div');
      card.className = 'mod-card';

      // 封面
      const coverCandidates = mod.coverImage ? toCandidates(mod.coverImage) : [];
      const coverSrc = coverCandidates.length ? coverCandidates[0] : (mod.images && mod.images[0]) || '';
      const coverInner = document.createElement('div');
      coverInner.className = 'mod-cover-inner';

      const coverImg = document.createElement('img');
      coverImg.className = 'mod-cover-img';
      coverImg.alt = mod.title || '';
      coverImg.loading = 'lazy';
      coverImg.src = coverSrc;
      coverImg.onerror = function() {
        this.onerror = null;
        this.src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="266" fill="%23f0ebe4"><rect width="200" height="266"/><text x="100" y="133" text-anchor="middle" fill="%239a92a5" font-size="14">暂无封面</text></svg>');
        this.style.opacity = '0.4';
      };

      coverInner.appendChild(coverImg);
      card.appendChild(coverInner);

      // 信息
      const info = document.createElement('div');
      info.className = 'mod-info';

      const title = document.createElement('div');
      title.className = 'mod-title';
      title.textContent = mod.title || '未知MOD';
      info.appendChild(title);

      if (mod.tags && mod.tags.length) {
        const tagsDiv = document.createElement('div');
        tagsDiv.className = 'mod-tags';
        mod.tags.forEach(tag => {
          const span = document.createElement('span');
          span.className = 'mod-tag';
          span.textContent = tag;
          // 【BUG修复1】标签点击不切换分区
          span.addEventListener('click', function(e) {
            e.stopPropagation();
            handleTagClick(tag);
          });
          tagsDiv.appendChild(span);
        });
        info.appendChild(tagsDiv);
      }

      card.appendChild(info);

      // 点击卡片打开详情
      card.addEventListener('click', function() {
        openModal(mod);
      });

      modGrid.appendChild(card);
      attachCardSpinner(card);
    });
  }

  // ========== 分页器 ==========

  function renderPagination() {
    paginationWrap.innerHTML = '';

    if (isSearchMode || totalPages <= 0) {
      paginationWrap.classList.add('hidden');
      return;
    }

    paginationWrap.classList.remove('hidden');

    if (totalPages <= 1) {
      paginationWrap.classList.add('hidden');
      return;
    }

    // 上一页按钮
    const prevBtn = document.createElement('button');
    prevBtn.className = 'page-btn nav-btn';
    prevBtn.innerHTML = '&#8249;';
    prevBtn.disabled = (currentPage <= 1);
    prevBtn.addEventListener('click', function() {
      if (currentPage > 1) goToPage(currentPage - 1);
    });
    paginationWrap.appendChild(prevBtn);

    // 页码按钮
    for (let i = 1; i <= totalPages; i++) {
      const btn = document.createElement('button');
      btn.className = 'page-btn' + (i === currentPage ? ' active' : '');
      btn.textContent = i;
      btn.addEventListener('click', (function(page) {
        return function() { goToPage(page); };
      })(i));
      paginationWrap.appendChild(btn);
    }

    // 下一页按钮
    const nextBtn = document.createElement('button');
    nextBtn.className = 'page-btn nav-btn';
    nextBtn.innerHTML = '&#8250;';
    nextBtn.disabled = (currentPage >= totalPages);
    nextBtn.addEventListener('click', function() {
      if (currentPage < totalPages) goToPage(currentPage + 1);
    });
    paginationWrap.appendChild(nextBtn);
  }

  async function goToPage(page) {
    const dir = CATEGORY_DIR_MAP[activeCategory];
    if (!dir || !categoryRanges[dir]) return;

    const range = categoryRanges[dir];
    const pageNum = range.start + page - 1;
    if (pageNum < range.start || pageNum > range.end) return;

    currentPage = page;
    isSearchMode = false;

    const data = await loadPageData(activeCategory, pageNum);

    if (data === null) {
      // 【功能9(5)】单文件加载失败
      modGrid.innerHTML = '';
      const errDiv = document.createElement('div');
      errDiv.className = 'page-data-error';
      errDiv.innerHTML = '<div class="page-data-error-icon">📦</div>' +
        '<div class="page-data-error-text">该页数据走丢了，点击重试</div>' +
        '<button class="retry-btn">重试</button>';
      errDiv.querySelector('.retry-btn').addEventListener('click', function() {
        // 清除缓存后重试
        const url = getJsonUrl(dir, pageNum);
        delete pageDataCache[url];
        goToPage(page);
      });
      modGrid.appendChild(errDiv);
      renderPagination();
      return;
    }

    modData = sortModsByTimeId(data);
    renderModCards(modData);
    renderPagination();

    // 切换页面后回到顶部
    modGrid.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ========== 搜索与过滤 ==========

  // 【BUG修复1】标签点击仅填充搜索框，不切换分区
  function handleTagClick(tagText) {
    searchInput.value = tagText;
    searchClear.style.display = '';
    // 不切换 activeCategory，不修改分区高亮
    filterMods();
    searchInput.focus();
  }

  // 【功能3】RID 搜索改为全站搜索
  async function filterMods() {
    const query = searchInput.value.trim().toLowerCase();
    searchClear.style.display = query ? '' : 'none';

    if (!query) {
      // 清空搜索，回到分页浏览模式
      isSearchMode = false;
      await goToPage(currentPage);
      searchDropdown.classList.remove('active');
      return;
    }

    // 判断是否为 RID 搜索
    const isRidSearch = query.startsWith('rid:') || /^\d{10,}$/.test(query);

    let allData;
    if (isRidSearch) {
      // RID 搜索：全站搜索
      allData = await loadAllCategoriesData();
    } else {
      // 普通搜索：当前分类
      allData = await loadAllDataForCategory(activeCategory);
    }

    // 过滤
    const filtered = allData.filter(mod => {
      const title = (mod.title || '').toLowerCase();
      const tags = (mod.tags || []).map(t => t.toLowerCase());
      const id = (mod.id || '').toLowerCase();
      const author = (mod.author || '').toLowerCase();

      if (isRidSearch) {
        const ridQuery = query.startsWith('rid:') ? query.slice(4).trim() : query;
        return id.includes(ridQuery);
      }
      return title.includes(query) || tags.some(t => t.includes(query)) || author.includes(query) || id.includes(query);
    });

    isSearchMode = true;
    modData = sortModsByTimeId(filtered);
    renderModCards(modData);
    renderPagination(); // 搜索模式下隐藏分页

    // 搜索下拉
    updateSearchDropdown(query, filtered);
  }

  function updateSearchDropdown(query, data) {
    searchDropdown.innerHTML = '';
    if (!query) {
      searchDropdown.classList.remove('active');
      return;
    }

    const matches = data.slice(0, 6);
    if (!matches.length) {
      searchDropdown.classList.remove('active');
      return;
    }

    matches.forEach(mod => {
      const item = document.createElement('div');
      item.className = 'search-dropdown-item';
      const title = mod.title || '未知MOD';
      const highlighted = title.replace(new RegExp('(' + escapeRegex(query) + ')', 'gi'), '<span class="highlight">$1</span>');
      item.innerHTML = highlighted;
      item.addEventListener('click', function() {
        openModal(mod);
        searchDropdown.classList.remove('active');
      });
      searchDropdown.appendChild(item);
    });

    searchDropdown.classList.add('active');
  }

  function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // ========== RID 复制功能拆分 + 分享链接 ==========

  // 【功能6】RID 复制功能拆分
  function showRidPopup(mod, anchorEl) {
    ridPopupMod = mod;
    ridPopup.classList.add('active');
  }

  function hideRidPopup() {
    ridPopup.classList.remove('active');
    ridPopupMod = null;
  }

  // 【功能6】URL 参数 ?rid=xxxxx 自动打开详情页
  async function checkUrlRidParam() {
    const params = new URLSearchParams(window.location.search);
    const rid = params.get('rid');
    if (!rid) return false;

    try {
      const allData = await loadAllCategoriesData();
      const mod = allData.find(function(m) { return m.id === rid; });
      if (mod) {
        openModal(mod);
        return true;
      }
    } catch (e) {
      console.error('RID 查找失败:', e);
    }
    return false;
  }

  // ========== 分类切换 ==========

  async function switchCategory(categoryKey) {
    if (activeCategory === categoryKey) return;
    activeCategory = categoryKey;

    // 更新分类标签高亮
    categoryBar.querySelectorAll('.category-tag').forEach(function(tag) {
      tag.classList.toggle('active', tag.dataset.category === categoryKey);
    });

    // 清空搜索
    searchInput.value = '';
    searchClear.style.display = 'none';
    searchDropdown.classList.remove('active');
    isSearchMode = false;

    // 重置分页
    totalPages = getTotalPagesForCategory(categoryKey);
    currentPage = 1;

    // 加载第一页
    await goToPage(1);
  }

  // ========== 工具 ==========

  function escapeAttr(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ========== 事件绑定 ==========

  // 搜索
  searchInput.addEventListener('input', debounce(filterMods, 300));
  searchInput.addEventListener('focus', function() {
    if (searchInput.value.trim()) filterMods();
  });
  searchClear.addEventListener('click', function() {
    searchInput.value = '';
    searchClear.style.display = 'none';
    searchDropdown.classList.remove('active');
    isSearchMode = false;
    goToPage(currentPage);
  });

  // 点击外部关闭搜索下拉
  document.addEventListener('click', function(e) {
    if (!e.target.closest('.search-section')) {
      searchDropdown.classList.remove('active');
    }
  });

  // 分类切换
  categoryBar.addEventListener('click', function(e) {
    const tag = e.target.closest('.category-tag');
    if (!tag) return;
    switchCategory(tag.dataset.category);
  });

  // Modal 关闭
  modalClose.addEventListener('click', closeModal);
  modalOverlay.addEventListener('click', function(e) {
    if (e.target === modalOverlay) closeModal();
  });
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
      if (lightboxOverlay.classList.contains('active')) { closeLightbox(); return; }
      if (charaOverlay.classList.contains('active')) { charaOverlay.classList.remove('active'); document.body.style.overflow = ''; return; }
      if (modalOverlay.classList.contains('active')) { closeModal(); return; }
    }
  });

  // Carousel
  carouselPrev.addEventListener('click', function() { setCurrentIndex(currentIndex - 1); });
  carouselNext.addEventListener('click', function() { setCurrentIndex(currentIndex + 1); });
  carouselDots.addEventListener('click', function(e) {
    const dot = e.target.closest('.carousel-dot');
    if (dot) setCurrentIndex(parseInt(dot.dataset.index));
  });

  // Preview
  previewImagesBtn.addEventListener('click', function() { switchPreviewTab('images'); });
  previewVideosBtn.addEventListener('click', function() { switchPreviewTab('videos'); });

  // Lightbox
  lightboxClose.addEventListener('click', closeLightbox);
  lightboxOverlay.addEventListener('click', function(e) {
    if (e.target === lightboxOverlay) closeLightbox();
  });

  // Chara
  charaClose.addEventListener('click', function() {
    charaOverlay.classList.remove('active');
    document.body.style.overflow = '';
  });

  // 【功能6】RID 点击弹出复制选项
  modalRid.addEventListener('click', function(e) {
    e.stopPropagation();
    if (ridPopup.classList.contains('active')) {
      hideRidPopup();
    } else {
      showRidPopup(currentMod, modalRid);
    }
  });

  ridPopup.addEventListener('click', function(e) {
    e.stopPropagation();
    const item = e.target.closest('.rid-popup-item');
    if (!item || !ridPopupMod) return;

    const action = item.dataset.action;
    const rid = ridPopupMod.id || '';

    if (action === 'copy-rid') {
      copyText('RID:' + rid);
    } else if (action === 'copy-link') {
      copyText('https://' + SITE_DOMAIN + '/?rid=' + rid);
    }

    hideRidPopup();
  });

  // 点击外部关闭 RID 弹窗
  document.addEventListener('click', function(e) {
    if (!e.target.closest('.modal-rid') && !e.target.closest('.rid-popup')) {
      hideRidPopup();
    }
  });

  // Manifest 重试
  manifestRetryBtn.addEventListener('click', function() {
    window.location.reload();
  });

  // ========== 初始化 ==========

  async function initPage() {
    // 加载 manifest
    const manifestOk = await loadManifest();
    if (!manifestOk) {
      loadingOverlay.classList.add('hidden');
      mainContent.style.opacity = '1';
      manifestError.style.display = '';
      modGrid.style.display = 'none';
      paginationWrap.style.display = 'none';
      return;
    }

    manifestError.style.display = 'none';
    modGrid.style.display = '';
    paginationWrap.style.display = '';

    // 计算总页数
    totalPages = getTotalPagesForCategory(activeCategory);

    // 加载 config（非阻塞）
    let loadingGifUrls = [];
    let logoUrls = [];
    let loaded2GifUrls = [];
    try {
      const configResp = await fetch('resources/json/config.json');
      const config = await configResp.json();
      if (config.loadingGifUrls && config.loadingGifUrls.length) loadingGifUrls = config.loadingGifUrls;
      if (config.logoUrls && config.logoUrls.length) logoUrls = config.logoUrls;
      if (config.loaded2GifUrls && config.loaded2GifUrls.length) loaded2GifUrls = config.loaded2GifUrls;
    } catch (e) {}

    // 后台加载图片
    const gifPromise = raceImage(loadingGifUrls).catch(function() { return null; });
    const logoPromise = raceImage(logoUrls).catch(function() { return null; });
    const loaded2Promise = raceImage(loaded2GifUrls).catch(function() { return null; });

    // 关键：先显示主界面
    setTimeout(async function() {
      loadingOverlay.classList.add('hidden');
      mainContent.style.opacity = '1';

      // 检查 URL 是否有 RID 参数
      const ridFound = await checkUrlRidParam();
      if (!ridFound) {
        // 正常加载第一页
        await goToPage(1);
      }
    }, 100);

    // 后台更新图片
    gifPromise.then(function(src) {
      if (src) {
        loadingGif.src = src;
        loadingGif.style.display = 'block';
        if (potionWrapper) potionWrapper.style.display = 'none';
      }
    });
    logoPromise.then(function(src) {
      if (src) {
        logoImg.src = src;
        logoImg.style.display = 'block';
        logoTower.style.display = 'none';
      }
    });
    loaded2Promise.then(function(src) {
      if (src) window.loaded2GifSrc = src;
    });

    // Logo 点击
    logoArea.addEventListener('click', function(e) {
      if (e.target === logoArea || e.target.closest('.logo-img') || e.target.closest('.logo-tower')) {
        openCharaDetail();
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPage);
  } else {
    initPage();
  }
})();
