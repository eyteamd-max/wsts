(function() {
  'use strict';

  // ========== 工具函数（保持原样） ==========

  function raceImage(urls, timeout) {
    if (!urls || !urls.length) return Promise.reject(new Error('No URLs'));
    timeout = timeout || 3500;
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; reject(new Error('raceImage timeout')); } }, timeout + 3000);
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
      const timer = setTimeout(() => { if (!settled) { settled = true; reject(new Error('raceVideo timeout')); } }, 8000);
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
    if (!Array.isArray(dataArray)) return [];
    return dataArray.slice().sort((a, b) => {
      const idA = a.id || '';
      const idB = b.id || '';
      const dateA = idA.length >= 8 ? idA.substring(0, 8) : '';
      const dateB = idB.length >= 8 ? idB.substring(0, 8) : '';
      if (dateA !== dateB) return dateB.localeCompare(dateA);
      return idB.localeCompare(idA);
    });
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise((resolve, reject) => {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      try {
        document.execCommand('copy');
        resolve();
      } catch (err) {
        reject(err);
      } finally {
        document.body.removeChild(textarea);
      }
    });
  }

  // ========== DOM 引用（保持原样） ==========

  const loadingOverlay = document.getElementById('loadingOverlay');
  const loadingGif = document.getElementById('loadingGif');
  const potionWrapper = document.getElementById('potionWrapper');
  const loadingText = document.getElementById('loadingText');
  const mainContent = document.getElementById('mainContent');
  const logoArea = document.getElementById('logoArea');
  const logoImg = document.getElementById('logoImg');
  const logoTower = document.getElementById('logoTower');
  const searchInput = document.getElementById('searchInput');
  const searchContainer = document.getElementById('searchContainer');
  const searchDropdown = document.getElementById('searchDropdown');
  const modGrid = document.getElementById('modGrid');
  const modalOverlay = document.getElementById('modalOverlay');
  const modalClose = document.getElementById('modalClose');
  const modalTitle = document.getElementById('modalTitle');
  const modalRid = document.getElementById('modalRid');
  const modalTags = document.getElementById('modalTags');
  const modalDescText = document.getElementById('modalDescText');
  const descToggle = document.getElementById('descToggle');
  const modalAuthor = document.getElementById('modalAuthor');
  const modalLinks = document.getElementById('modalLinks');
  const downloadButtons = document.getElementById('downloadButtons');
  const previewImagesBtn = document.getElementById('previewImagesBtn');
  const previewVideosBtn = document.getElementById('previewVideosBtn');
  const previewContentArea = document.getElementById('previewContentArea');
  const carouselContainer = document.getElementById('carouselContainer');
  const carouselTrack = document.getElementById('carouselTrack');
  const carouselPrev = document.getElementById('carouselPrev');
  const carouselNext = document.getElementById('carouselNext');
  const carouselDots = document.getElementById('carouselDots');
  const lightboxImg = document.getElementById('lightboxImg');
  const lightboxOverlay = document.getElementById('lightboxOverlay');
  const lightboxClose = document.getElementById('lightboxClose');
  const charaOverlay = document.getElementById('charaOverlay');
  const charaClose = document.getElementById('charaClose');
  const charaImg = document.getElementById('charaImg');
  const toastEl = document.getElementById('toast');

  // 【新增6】RID弹窗DOM
  const ridPopupOverlay = document.getElementById('ridPopupOverlay');
  const ridPopup = document.getElementById('ridPopup');
  const ridCopyRid = document.getElementById('ridCopyRid');
  const ridCopyLink = document.getElementById('ridCopyLink');
  const ridPopupCancel = document.getElementById('ridPopupCancel');

  // 【新增8】分页器DOM
  const paginationEl = document.getElementById('pagination');

  // 【新增9】manifest错误提示DOM
  const manifestErrorEl = document.getElementById('manifestError');

  // ========== 状态变量（保持原样 + 新增） ==========

  let modData = [];
  let currentMod = null;
  let activeCategory = 'all';
  let activePreviewTab = null;
  let currentCarouselIndex = 0;
  let carouselImages = [];

  const FALLBACK_LOADED2 = 'https://cdn.jsdmirror.com/gh/eyteamd-max/HTML-full-linked-html-/loaded_2.gif';

  // 【新增9】分页与manifest状态
  const ITEMS_PER_PAGE = 8;
  let currentPage = 1;
  let manifestConfig = null; // { sts2_mods: "1~1", O.o_interface: "1~1" }
  let pageCache = {};        // key: "category:page" => array
  let pageErrorSet = new Set(); // 记录加载失败的页

  // 【新增9】分区名 → 目录名映射
  const CATEGORY_DIR_MAP = {
    'all': 'sts2_mods',
    'skin': 'O.o_interface'
  };

  // 【新增9】分区名 → 对应的category字段值
  const CATEGORY_FIELD_MAP = {
    'all': null,       // 不按category字段过滤
    'skin': 'skin'
  };

  // ========== 原有数据源（保留，但不再用于加载，仅作fallback参考） ==========
  const dataSources = {
    'all': 'resources/json/post/sts2_mods/sts2_mods_1.json',
    'skin': 'resources/json/post/O.o_interface/O.o_interface_1.json'
  };

  // ========== Carousel（保持原样） ==========

  function updateCarousel(images) {
    carouselImages = images;
    currentCarouselIndex = 0;
    carouselTrack.innerHTML = '';
    carouselDots.innerHTML = '';
    if (images.length === 0) {
      carouselContainer.style.display = 'none';
      return;
    }
    carouselContainer.style.display = '';
    images.forEach((url, idx) => {
      const slide = document.createElement('div');
      slide.className = 'carousel-slide';
      const img = document.createElement('img');
      img.src = url;
      img.alt = '预览图 ' + (idx + 1);
      img.addEventListener('click', () => {
        lightboxImg.src = url;
        lightboxOverlay.classList.add('active');
      });
      slide.appendChild(img);
      carouselTrack.appendChild(slide);

      const dot = document.createElement('span');
      dot.className = 'carousel-dot' + (idx === 0 ? ' active' : '');
      dot.addEventListener('click', () => goToSlide(idx));
      carouselDots.appendChild(dot);
    });
    carouselTrack.style.transform = 'translateX(0)';
    updateCarouselBtnVisibility();
  }

  function goToSlide(index) {
    if (index < 0 || index >= carouselImages.length) return;
    currentCarouselIndex = index;
    carouselTrack.style.transform = `translateX(-${index * 100}%)`;
    document.querySelectorAll('.carousel-dot').forEach((d, i) => {
      d.classList.toggle('active', i === index);
    });
  }

  carouselPrev.addEventListener('click', () => goToSlide(currentCarouselIndex - 1));
  carouselNext.addEventListener('click', () => goToSlide(currentCarouselIndex + 1));

  function updateCarouselBtnVisibility() {
    if (carouselImages.length <= 1) {
      carouselPrev.style.display = 'none';
      carouselNext.style.display = 'none';
    } else {
      carouselPrev.style.display = '';
      carouselNext.style.display = '';
    }
  }

  // ========== Preview（保持原样 + 【功能5】三次重试） ==========

  function updatePreviewButtons() {
    if (!currentMod) return;
    const hasImages = (currentMod.previewImages && currentMod.previewImages.length) ||
                      (currentMod.images && currentMod.images.length);
    const hasVideos = currentMod.previewVideos && currentMod.previewVideos.length;
    previewImagesBtn.style.display = hasImages ? '' : 'none';
    previewVideosBtn.style.display = hasVideos ? '' : 'none';
    if (!activePreviewTab) {
      if (hasImages) activePreviewTab = 'images';
      else if (hasVideos) activePreviewTab = 'videos';
    }
    previewImagesBtn.classList.toggle('active', activePreviewTab === 'images');
    previewVideosBtn.classList.toggle('active', activePreviewTab === 'videos');
  }

  function switchPreviewTab(tab) {
    activePreviewTab = tab;
    updatePreviewButtons();
    renderPreviewContent();
  }

  function renderPreviewContent() {
    if (!currentMod) return;
    previewContentArea.innerHTML = '';
    if (!activePreviewTab) return;
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
  function loadImageWithRetry(urls, maxRetries) {
    maxRetries = maxRetries || 3;
    return new Promise((resolve, reject) => {
      let attempt = 0;
      function tryLoad() {
        attempt++;
        raceImage(urls, 5000).then(url => {
          resolve(url);
        }).catch(err => {
          if (attempt < maxRetries) {
            setTimeout(tryLoad, 500);
          } else {
            reject(err);
          }
        });
      }
      tryLoad();
    });
  }

  async function renderPreviewImages(items) {
    if (items.length === 0) {
      previewContentArea.innerHTML = '<div class="preview-empty-card">该MOD猫猫还没有配置图片资源哦</div>';
      return;
    }
    const grid = document.createElement('div');
    grid.className = 'preview-image-grid';
    previewContentArea.innerHTML = '';
    previewContentArea.appendChild(grid);
    const placeholders = items.map(item => {
      const ph = document.createElement('div');
      ph.className = 'preview-image-item';
      ph.style.background = '#f0f0f0';
      ph.style.display = 'flex';
      ph.style.alignItems = 'center';
      ph.style.justifyContent = 'center';
      ph.style.color = '#9a92a5';
      ph.style.fontSize = '0.85rem';
      ph.textContent = '图片加载中...';
      grid.appendChild(ph);
      return ph;
    });
    await Promise.allSettled(
      items.map((item, idx) => {
        const urls = toCandidates(item);
        // 【功能5】使用三次重试
        return loadImageWithRetry(urls, 3).then(url => {
          const img = document.createElement('img');
          img.src = url;
          img.className = 'preview-image-item';
          img.style.cursor = 'zoom-in';
          img.addEventListener('click', () => { lightboxImg.src = url; lightboxOverlay.classList.add('active'); });
          grid.replaceChild(img, placeholders[idx]);
        }).catch(() => { placeholders[idx].textContent = '加载失败'; });
      })
    );
  }

  // renderPreviewVideos 保持原样
  async function renderPreviewVideos(items) {
    if (items.length === 0) {
      previewContentArea.innerHTML = '<div class="preview-empty-card">该MOD猫猫还没有配置视频资源哦</div>';
      return;
    }
    const list = document.createElement('div');
    list.className = 'preview-video-list';
    previewContentArea.innerHTML = '';
    previewContentArea.appendChild(list);
    items.forEach((item) => {
      const ph = document.createElement('div');
      ph.className = 'preview-video-item';
      ph.style.background = '#f0f0f0';
      ph.style.height = '200px';
      ph.style.display = 'flex';
      ph.style.alignItems = 'center';
      ph.style.justifyContent = 'center';
      ph.textContent = '视频加载中...';
      list.appendChild(ph);
      let urls = [];
      if (item.urls && Array.isArray(item.urls) && item.urls.length > 0) urls = item.urls;
      else if (item.url) urls = [item.url];
      if (urls.length === 0) { ph.textContent = '视频链接缺失'; return; }
      raceVideo(urls).then(video => {
        video.className = 'preview-video-item';
        video.controls = true;
        if (item.poster) video.poster = item.poster;
        list.replaceChild(video, ph);
      }).catch(() => { ph.textContent = '视频加载失败'; });
    });
  }

  previewImagesBtn.addEventListener('click', () => switchPreviewTab('images'));
  previewVideosBtn.addEventListener('click', () => switchPreviewTab('videos'));

  // ========== 【功能7】详情页介绍文本中的链接高亮 ==========

  function processDescription(text) {
    // 先提取URL并替换为占位符
    const urlRegex = /https?:\/\/[^\s<>\u4e00-\u9fff\uff00-\uffef\u3000-\u303f)]+/g;
    const urls = [];
    let processed = text.replace(urlRegex, (match) => {
      urls.push(match);
      return '%%URL_' + (urls.length - 1) + '%%';
    });
    // HTML转义
    processed = processed.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // 换行
    processed = processed.replace(/\n/g, '<br>');
    // 还原URL为粉色高亮链接
    processed = processed.replace(/%%URL_(\d+)%%/g, (_, idx) => {
      const url = urls[parseInt(idx)];
      return '<a class="desc-link" href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + '</a>';
    });
    return processed;
  }

  // ========== openModal（保持原样 + 【功能6】RID弹窗 + 【功能7】链接高亮） ==========

  async function openModal(mod) {
    currentMod = mod;
    const loadingOverlayEl = document.createElement('div');
    loadingOverlayEl.className = 'modal-loading-overlay';
    loadingOverlayEl.innerHTML = `
      <div class="modal-loading-spinner"></div>
      <div class="modal-loading-text">网页有点重，猫猫正在努力叼过来...</div>
    `;
    document.body.appendChild(loadingOverlayEl);
    const closeBtn = document.createElement('button');
    closeBtn.className = 'modal-loading-close';
    closeBtn.innerHTML = '&times;';
    document.body.appendChild(closeBtn);
    let cancelled = false;
    const cleanupLoading = () => {
      if (loadingOverlayEl.parentNode) loadingOverlayEl.remove();
      if (closeBtn.parentNode) closeBtn.remove();
    };
    closeBtn.addEventListener('click', () => { cancelled = true; cleanupLoading(); currentMod = null; });

    let imageCandidates = [];
    if (mod.images && mod.images.length > 0) imageCandidates = mod.images;
    else if (mod.coverImage) imageCandidates = [mod.coverImage];

    let finalImages = [];
    try {
      const results = await Promise.all(
        imageCandidates.map(item => raceImage(toCandidates(item)).catch(() => null))
      );
      if (cancelled) return;
      finalImages = results.filter(url => url !== null);
    } catch (e) { if (cancelled) return; }

    cleanupLoading();
    if (cancelled) { currentMod = null; return; }

    modalTitle.textContent = mod.title;
    modalRid.textContent = 'RID: ' + (mod.id || '无');

    // 【功能6】RID点击改为弹窗选择
    modalRid.onclick = () => {
      showRidPopup(mod);
    };

    modalTags.innerHTML = '';
    if (mod.tags && Array.isArray(mod.tags)) {
      mod.tags.forEach(tag => {
        const span = document.createElement('span');
        span.className = 'modal-tag ' + tag.toLowerCase();
        span.textContent = tag.toUpperCase();
        modalTags.appendChild(span);
      });
    }

    // 【功能7】使用 processDescription 处理介绍文本，链接粉色高亮
    const desc = processDescription(mod.description || '暂无介绍');
    modalDescText.innerHTML = desc;
    modalDescText.classList.remove('expanded');
    descToggle.style.display = 'none';
    descToggle.textContent = '展开全文';

    modalAuthor.textContent = '作者：' + (mod.author || '佚名');

    modalLinks.innerHTML = '';
    if (mod.authorLinks) {
      if (Array.isArray(mod.authorLinks)) {
        mod.authorLinks.forEach(link => {
          if (link.text && link.url) {
            const a = document.createElement('a');
            a.className = 'modal-link';
            a.href = link.url;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.textContent = link.text;
            modalLinks.appendChild(a);
          }
        });
      } else {
        const links = [
          { name: 'Twitter', url: mod.authorLinks.twitter },
          { name: 'Pixiv', url: mod.authorLinks.pixiv },
          { name: 'Bilibili', url: mod.authorLinks.bilibili }
        ];
        links.forEach(link => {
          if (link.url) {
            const a = document.createElement('a');
            a.className = 'modal-link';
            a.href = link.url;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.textContent = link.name;
            modalLinks.appendChild(a);
          }
        });
      }
    }

    downloadButtons.innerHTML = '';
    const downloadLinks = mod.downloadLinks && mod.downloadLinks.length
      ? mod.downloadLinks
      : (mod.downloadUrl ? [{ text: '下载', url: mod.downloadUrl }] : []);
    downloadLinks.forEach(dl => {
      const btn = document.createElement('a');
      btn.className = 'download-btn-item';
      btn.href = dl.url;
      btn.target = '_blank';
      btn.rel = 'noopener noreferrer';
      btn.textContent = dl.text;
      downloadButtons.appendChild(btn);
    });

    activePreviewTab = null;
    updatePreviewButtons();
    renderPreviewContent();
    updateCarousel(finalImages);
    carouselPrev.style.display = '';
    carouselNext.style.display = '';
    modalOverlay.classList.add('active');
    document.body.style.overflow = 'hidden';
    setTimeout(() => {
      if (modalDescText.scrollHeight > modalDescText.clientHeight + 2) {
        descToggle.style.display = 'inline-block';
      }
    }, 50);
  }

  function closeModal() {
    modalOverlay.classList.remove('active');
    document.body.style.overflow = '';
    currentMod = null;
    activePreviewTab = null;
  }

  modalClose.addEventListener('click', closeModal);
  modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });
  descToggle.addEventListener('click', () => {
    const expanded = modalDescText.classList.toggle('expanded');
    descToggle.textContent = expanded ? '收起' : '展开全文';
  });
  lightboxClose.addEventListener('click', () => lightboxOverlay.classList.remove('active'));
  lightboxOverlay.addEventListener('click', (e) => { if (e.target === lightboxOverlay) lightboxOverlay.classList.remove('active'); });

  // ========== 【BUG1修复】标签点击不再切换分区 ==========

  function handleTagClick(tagText) {
    searchInput.value = tagText;
    // 【修复】不再切换分区标签高亮，不再修改 activeCategory
    // 仅触发搜索
    filterMods();
    searchInput.focus();
  }

  // ========== 【BUG2修复】卡片封面加载圈正确消失 ==========

  function attachCardSpinner(cardElement) {
    const coverInner = cardElement.querySelector('.mod-cover-inner');
    const coverImg = coverInner ? coverInner.querySelector('.mod-cover-img') : null;
    if (!coverInner || !coverImg) return;
    const spinner = document.createElement('span');
    spinner.className = 'card-spinner';
    const hideSpinner = () => { if (spinner.parentNode) spinner.style.display = 'none'; };
    // 【修复】增加 naturalWidth 检查，处理图片已缓存的情况
    if (coverImg.complete && coverImg.naturalWidth > 0) {
      // 图片已加载完成，不显示spinner
    } else {
      coverImg.addEventListener('load', hideSpinner, { once: true });
      coverImg.addEventListener('error', hideSpinner, { once: true });
      coverInner.appendChild(spinner);
      // 安全超时：10秒后无论如何隐藏
      setTimeout(hideSpinner, 10000);
      return;
    }
    // 不需要spinner，不添加
  }

  // ========== renderModCards（保持原样） ==========

  function renderModCards(dataArray) {
    modGrid.innerHTML = '';
    if (dataArray.length === 0) {
      modGrid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:50px;color:var(--text-muted);">没有找到相关MOD</div>`;
      return;
    }
    const loaded2Src = window.loaded2GifSrc || FALLBACK_LOADED2;
    dataArray.forEach(mod => {
      let coverImgSrc = '';
      if (mod.coverImage) {
        if (Array.isArray(mod.coverImage)) { coverImgSrc = mod.coverImage[0] || ''; }
        else { coverImgSrc = mod.coverImage; }
      }
      const hasCoverImg = coverImgSrc.trim() !== '';
      const imgSrc = hasCoverImg ? coverImgSrc : loaded2Src;
      const imgStyle = hasCoverImg ? 'object-fit: cover;' : 'object-fit: contain;';
      let tagsHtml = '';
      if (mod.tags && mod.tags.length) {
        tagsHtml = '<div class="mod-tag-list">' + mod.tags.map(t =>
          `<span class="mod-tag-item ${t.toLowerCase()}">${t.toUpperCase()}</span>`
        ).join('') + '</div>';
      }
      const card = document.createElement('div');
      card.className = 'mod-card';
      card.innerHTML = `
        <div class="mod-cover">
          <div class="mod-cover-inner">
            <div class="mod-cover-gradient" style="background:${mod.coverGradient};"></div>
            <img src="${imgSrc}" alt="${mod.title}" class="mod-cover-img"
              style="position:absolute; width:100%; height:100%; ${imgStyle} z-index:2; border-radius:inherit;"
              onerror="this.onerror=null; this.src='data:image/svg+xml;charset=UTF-8,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48' fill='none' stroke='%239a92a5' stroke-width='3'><circle cx='24' cy='24' r='20'/><path d='M24 16v12'/><circle cx='24' cy='32' r='2' fill='%239a92a5'/></svg>`)}'; this.style.opacity=0.4;">
          </div>
          <span class="mod-badge ${mod.badgeClass}">${mod.badge}</span>
        </div>
        <div class="mod-info">
          <div class="mod-title">${mod.title}</div>
          ${tagsHtml}
          <div class="mod-meta">
            <span class="mod-meta-tag">大小 ${mod.size}</span>
            <span class="mod-meta-tag">日期 ${mod.date}</span>
          </div>
          <button class="mod-download-btn view-detail-btn">查看详情</button>
        </div>`;
      card.querySelector('.view-detail-btn').addEventListener('click', (e) => { e.stopPropagation(); openModal(mod); });
      card.querySelectorAll('.mod-tag-item').forEach(tagEl => {
        tagEl.addEventListener('click', (e) => { e.stopPropagation(); handleTagClick(tagEl.textContent); });
      });
      modGrid.appendChild(card);
      attachCardSpinner(card);
    });
  }

  // ========== 【功能3】RID搜索改为全站搜索 + 【功能8/9】分页逻辑 ==========

  // 【新增9】加载manifest.json
  async function loadManifest() {
    if (manifestConfig) return manifestConfig;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);
      const resp = await fetch('resources/json/post/manifest.json', { signal: controller.signal });
      clearTimeout(timeoutId);
      if (!resp.ok) throw new Error('manifest fetch failed');
      manifestConfig = await resp.json();
      return manifestConfig;
    } catch (e) {
      manifestConfig = null;
      return null;
    }
  }

  // 【新增9】根据manifest获取某分区的JSON文件数量范围
  function getCategoryRange(categoryKey) {
    if (!manifestConfig) return null;
    const dirName = CATEGORY_DIR_MAP[categoryKey];
    if (!dirName || !manifestConfig[dirName]) return null;
    const rangeStr = manifestConfig[dirName];
    const parts = rangeStr.split('~');
    if (parts.length !== 2) return null;
    return { start: parseInt(parts[0]), end: parseInt(parts[1]) };
  }

  // 【新增9】加载某分区某页的JSON数据
  async function loadPageData(categoryKey, page) {
    const cacheKey = categoryKey + ':' + page;
    if (pageCache[cacheKey]) return pageCache[cacheKey];

    const dirName = CATEGORY_DIR_MAP[categoryKey];
    if (!dirName) return [];

    const url = 'resources/json/post/' + dirName + '/' + dirName + '_' + page + '.json';
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);
      const resp = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);
      if (!resp.ok) throw new Error('fetch failed');
      let rawData = await resp.json();
      rawData = sortModsByTimeId(rawData);
      pageCache[cacheKey] = rawData;
      pageErrorSet.delete(cacheKey);
      return rawData;
    } catch (e) {
      pageErrorSet.add(cacheKey);
      return null; // null表示加载失败
    }
  }

  // 【新增9】加载某分区全部数据（用于RID全站搜索等）
  async function loadAllDataForCategory(categoryKey) {
    const range = getCategoryRange(categoryKey);
    if (!range) return [];
    const allData = [];
    for (let i = range.start; i <= range.end; i++) {
      const data = await loadPageData(categoryKey, i);
      if (data) allData.push(...data);
    }
    return allData;
  }

  // 【新增9】加载全部分区数据（用于RID全站搜索）
  async function loadAllCategoriesData() {
    const allData = [];
    const categories = Object.keys(CATEGORY_DIR_MAP);
    for (const cat of categories) {
      const data = await loadAllDataForCategory(cat);
      allData.push(...data);
    }
    return allData;
  }

  // 【新增8】渲染分页器
  function renderPagination(totalPages) {
    paginationEl.innerHTML = '';
    if (totalPages <= 1) return;

    // 上一页按钮
    const prevBtn = document.createElement('button');
    prevBtn.className = 'page-btn';
    prevBtn.innerHTML = '&#8249;';
    prevBtn.disabled = (currentPage <= 1);
    prevBtn.addEventListener('click', () => { if (currentPage > 1) goToPage(currentPage - 1); });
    paginationEl.appendChild(prevBtn);

    // 页码按钮
    for (let i = 1; i <= totalPages; i++) {
      const btn = document.createElement('button');
      btn.className = 'page-btn' + (i === currentPage ? ' active' : '');
      btn.textContent = i;
      btn.addEventListener('click', () => goToPage(i));
      paginationEl.appendChild(btn);
    }

    // 下一页按钮
    const nextBtn = document.createElement('button');
    nextBtn.className = 'page-btn';
    nextBtn.innerHTML = '&#8250;';
    nextBtn.disabled = (currentPage >= totalPages);
    nextBtn.addEventListener('click', () => { if (currentPage < totalPages) goToPage(currentPage + 1); });
    paginationEl.appendChild(nextBtn);
  }

  // 【新增8/9】跳转到指定页
  async function goToPage(page) {
    currentPage = page;
    const categoryKey = activeCategory;
    const range = getCategoryRange(categoryKey);

    if (!range) {
      // manifest未加载或无范围，使用旧逻辑
      await loadModDataLegacy(categoryKey);
      return;
    }

    const totalPages = range.end - range.start + 1;
    const jsonPage = page; // 第N页对应第N个JSON文件

    // 显示加载状态
    const loaded2Src = window.loaded2GifSrc || FALLBACK_LOADED2;
    modGrid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:40px;"><img src="${loaded2Src}" alt="加载中" style="max-width:200px;"></div>`;

    const data = await loadPageData(categoryKey, jsonPage);

    if (data === null) {
      // 加载失败
      modGrid.innerHTML = `<div class="page-data-error">该页数据走丢了，点击重试<button class="retry-btn" onclick="window.__retryPage()">重试</button></div>`;
      window.__retryPage = () => {
        const cacheKey = categoryKey + ':' + jsonPage;
        pageCache[cacheKey] = undefined;
        delete pageCache[cacheKey];
        goToPage(page);
      };
    } else {
      modData = data;
      renderModCards(modData);
    }

    renderPagination(totalPages);
    manifestErrorEl.style.display = 'none';

    // 切换页面后滚动到卡片列表顶部
    modGrid.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // 旧版加载逻辑（manifest不可用时fallback）
  async function loadModDataLegacy(categoryKey) {
    const url = dataSources[categoryKey];
    if (!url) return;
    const loaded2Src = window.loaded2GifSrc || FALLBACK_LOADED2;
    modGrid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:40px;"><img src="${loaded2Src}" alt="加载中" style="max-width:200px;"></div>`;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);
      if (!response.ok) throw new Error('加载失败');
      let rawData = await response.json();
      rawData = sortModsByTimeId(rawData);
      modData = rawData;
      searchInput.value = '';
      searchDropdown.classList.remove('active');
      renderModCards(modData);
    } catch (error) {
      modGrid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:40px;">MOD数据加载失败，请稍后再试</div>`;
    }
    paginationEl.innerHTML = '';
  }

  // ========== filterMods（【功能3】RID搜索改为全站搜索） ==========

  let ridSearchInProgress = false;

  async function filterMods() {
    const query = searchInput.value.trim();

    // 【功能3】检测RID搜索，全站搜索
    if (query) {
      const lowerQuery = query.toLowerCase();
      const isRidSearch = lowerQuery.startsWith('rid:') || /^\d{10,}$/.test(query);

      if (isRidSearch) {
        const ridPart = lowerQuery.startsWith('rid:') ? lowerQuery.slice(4).trim() : query;
        // 全站搜索
        if (!ridSearchInProgress) {
          ridSearchInProgress = true;
          try {
            const allData = await loadAllCategoriesData();
            const filtered = allData.filter(m => m.id === ridPart);
            renderModCards(filtered);
            paginationEl.innerHTML = ''; // RID搜索结果不分页
          } catch (e) {
            renderModCards([]);
          } finally {
            ridSearchInProgress = false;
          }
        }
        updateSearchDropdown(query);
        return;
      }
    }

    // 普通搜索：在当前页数据中搜索
    let filtered = [...modData];
    if (query) {
      const lowerQuery = query.toLowerCase();
      filtered = filtered.filter(m => {
        if (m.title.toLowerCase().includes(lowerQuery)) return true;
        if (m.tags && m.tags.some(tag => tag.toLowerCase().includes(lowerQuery))) return true;
        return false;
      });
    }
    renderModCards(filtered);
    updateSearchDropdown(query);
  }

  // updateSearchDropdown 保持原样
  function updateSearchDropdown(query) {
    searchDropdown.innerHTML = '';
    if (!query || query.length < 1) { searchDropdown.classList.remove('active'); return; }
    const lowerQuery = query.toLowerCase();
    if (lowerQuery.startsWith('rid:') || /^\d+$/.test(query)) { searchDropdown.classList.remove('active'); return; }
    const matches = modData.filter(m => {
      if (m.title.toLowerCase().includes(lowerQuery)) return true;
      if (m.tags && m.tags.some(tag => tag.toLowerCase().includes(lowerQuery))) return true;
      return false;
    });
    if (matches.length === 0) {
      searchDropdown.innerHTML = '<li style="padding:16px;text-align:center;color:var(--text-muted);">没有找到相关MOD</li>';
    } else {
      const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`(${escapedQuery})`, 'gi');
      matches.slice(0, 8).forEach(m => {
        const li = document.createElement('li');
        li.className = 'search-dropdown-item';
        li.innerHTML = m.title.replace(regex, '<mark>$1</mark>');
        li.addEventListener('click', () => { searchInput.value = m.title; searchDropdown.classList.remove('active'); filterMods(); });
        searchDropdown.appendChild(li);
      });
    }
    searchDropdown.classList.add('active');
  }

  // ========== 【功能6】RID复制功能拆分 + 分享链接跳转 ==========

  let currentRidMod = null;

  function showRidPopup(mod) {
    currentRidMod = mod;
    ridPopup.style.display = '';
    ridPopupOverlay.style.display = '';
  }

  function hideRidPopup() {
    ridPopup.style.display = 'none';
    ridPopupOverlay.style.display = 'none';
    currentRidMod = null;
  }

  ridPopupOverlay.addEventListener('click', hideRidPopup);
  ridPopupCancel.addEventListener('click', hideRidPopup);

  ridCopyRid.addEventListener('click', () => {
    if (!currentRidMod) return;
    const ridText = 'RID:' + (currentRidMod.id || '');
    copyText(ridText).then(() => { showToast('RID 已复制，快分享给小伙伴吧~'); }).catch(() => { showToast('复制失败，请手动复制'); });
    hideRidPopup();
  });

  ridCopyLink.addEventListener('click', () => {
    if (!currentRidMod) return;
    const rid = currentRidMod.id || '';
    const link = 'https://axxxx.cyou/?rid=' + rid;
    copyText(link).then(() => { showToast('帖子链接已复制~'); }).catch(() => { showToast('复制失败，请手动复制'); });
    hideRidPopup();
  });

  // 【功能6】URL参数 ?rid=xxx 自动打开详情页
  async function checkUrlRidParam() {
    const params = new URLSearchParams(window.location.search);
    const rid = params.get('rid');
    if (!rid) return false;

    // 全站搜索该RID
    try {
      const allData = await loadAllCategoriesData();
      const mod = allData.find(m => m.id === rid);
      if (mod) {
        openModal(mod);
        // 清理URL参数
        const cleanUrl = window.location.pathname;
        history.replaceState(null, '', cleanUrl);
        return true;
      }
    } catch (e) {}
    return false;
  }

  // ========== 分区切换（保持原样，但改用goToPage） ==========

  document.getElementById('categoryTags').addEventListener('click', (e) => {
    const tag = e.target.closest('.category-tag');
    if (!tag) return;
    document.querySelectorAll('.category-tag').forEach(t => t.classList.remove('active'));
    tag.classList.add('active');
    activeCategory = tag.getAttribute('data-category') || 'all';
    searchInput.value = '';
    searchDropdown.classList.remove('active');
    currentPage = 1;
    goToPage(1);
  });

  searchInput.addEventListener('input', filterMods);
  searchInput.addEventListener('focus', () => {
    if (searchInput.value.trim().length >= 1) updateSearchDropdown(searchInput.value.trim());
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { searchDropdown.classList.remove('active'); searchInput.blur(); }
    if (e.key === 'Enter') { searchDropdown.classList.remove('active'); filterMods(); }
  });
  document.addEventListener('click', (e) => {
    if (!searchContainer.contains(e.target)) searchDropdown.classList.remove('active');
  });

  charaClose.addEventListener('click', () => charaOverlay.classList.remove('active'));
  charaOverlay.addEventListener('click', (e) => { if (e.target === charaOverlay) charaOverlay.classList.remove('active'); });

  function openCharaDetail() {
    if (logoImg.src && logoImg.style.display !== 'none') { charaImg.src = logoImg.src; }
    else { charaImg.src = ''; }
    charaOverlay.classList.add('active');
  }

  // ========== Toast（保持原样） ==========

  let toastTimer;
  function showToast(message) {
    clearTimeout(toastTimer);
    toastEl.textContent = message;
    toastEl.classList.add('show');
    toastTimer = setTimeout(() => { toastEl.classList.remove('show'); }, 2200);
  }

  // ========== initPage（保持原样 + 【功能6】URL参数检测 + 【功能9】manifest加载） ==========

  async function initPage() {
    let loadingGifUrls = [
      'https://cdn.jsdmirror.com/gh/eyteamd-max/HTML-full-linked-html-/loaded.gif'
    ];
    let logoUrls = [
      'https://cdn.jsdmirror.com/gh/eyteamd-max/HTML-full-linked-html-/Lihui.gif'
    ];
    let loaded2GifUrls = [
      'http://shp.qpic.cn/collector/1976464052/35195f23-993a-4bae-a95b-b01054c9aa2c/0',
      'https://cdn.jsdmirror.com/gh/eyteamd-max/HTML-full-linked-html-/loaded_2.gif',
      'https://cdn.jsdelivr.net/gh/eyteamd-max/HTML-full-linked-html-/loaded_2.gif'
    ];

    // 尝试加载config，但不阻塞后续流程
    try {
      const fetchWithTimeout = Promise.race([
        fetch('resources/json/config.json'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))
      ]);
      const resp = await fetchWithTimeout;
      if (resp.ok) {
        const config = await resp.json();
        if (config.loadingGifUrls && config.loadingGifUrls.length) loadingGifUrls = config.loadingGifUrls;
        if (config.logoUrls && config.logoUrls.length) logoUrls = config.logoUrls;
        if (config.loaded2GifUrls && config.loaded2GifUrls.length) loaded2GifUrls = config.loaded2GifUrls;
      }
    } catch (e) {}

    // 【功能9】加载manifest
    const manifestOk = await loadManifest();
    if (!manifestOk) {
      manifestErrorEl.style.display = '';
    }

    // 启动后台图片加载（不阻塞显示）
    const gifPromise = raceImage(loadingGifUrls).catch(() => null);
    const logoPromise = raceImage(logoUrls).catch(() => null);
    const loaded2Promise = raceImage(loaded2GifUrls).catch(() => null);

    // 关键：无论图片是否就绪，先显示主界面
    setTimeout(async () => {
      loadingOverlay.classList.add('hidden');
      mainContent.style.opacity = '1';

      // 【功能6】检查URL是否有RID参数
      const ridFound = await checkUrlRidParam();
      if (!ridFound) {
        // 正常加载第一页
        if (manifestOk) {
          goToPage(1);
        } else {
          loadModDataLegacy('all');
        }
      }
    }, 100);

    // 后台更新图片
    gifPromise.then(src => {
      if (src) {
        loadingGif.src = src;
        loadingGif.style.display = 'block';
        if (potionWrapper) potionWrapper.style.display = 'none';
      }
    });
    logoPromise.then(src => {
      if (src) {
        logoImg.src = src;
        logoImg.style.display = 'block';
        logoTower.style.display = 'none';
      }
    });
    loaded2Promise.then(src => {
      if (src) window.loaded2GifSrc = src;
    });

    logoArea.addEventListener('click', (e) => {
      if (e.target === logoArea || e.target === logoImg || e.target.closest('.logo-img') || e.target.closest('.logo-tower')) {
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
