(function() {
  // ========== 工具函数 ==========
  function raceImage(urls, timeout = 3500) {
    if (!urls || urls.length === 0) return Promise.reject('no urls');
    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('image load timeout')), timeout));
    const loadPromises = urls.map(url => new Promise((resolve, reject) => {
      const img = new Image();
      const stallTimer = setTimeout(() => reject(new Error('image load stalled')), timeout + 2000);
      img.onload = img.onerror = (e) => {
        clearTimeout(stallTimer);
        if (e.type === 'load') resolve(url);
        else reject(new Error('image load failed'));
      };
      img.src = url;
    }));
    return Promise.race([
      Promise.any([timeoutPromise, ...loadPromises]),
      new Promise((_, reject) => setTimeout(() => reject(new Error('total timeout')), timeout + 3000))
    ]);
  }

  function raceVideo(urls) {
    if (!urls || urls.length === 0) return Promise.reject('no urls');
    const videos = [];
    const promises = urls.map(url => new Promise((resolve, reject) => {
      const video = document.createElement('video');
      video.preload = 'auto';
      video.muted = true;
      video.playsInline = true;
      const timer = setTimeout(() => reject(new Error('video load stalled')), 8000);
      video.onloadeddata = () => { clearTimeout(timer); resolve({ url, video }); };
      video.onerror = () => { clearTimeout(timer); reject(new Error('video load failed')); };
      video.src = url;
      videos.push(video);
    }));
    return Promise.any(promises).then(result => {
      videos.forEach(v => {
        if (v !== result.video) { v.onloadeddata = v.onerror = null; v.src = ''; v.load(); }
      });
      const cleanVideo = result.video.cloneNode(true);
      cleanVideo.muted = true;
      cleanVideo.playsInline = true;
      cleanVideo.preload = 'metadata';
      return cleanVideo;
    }).catch(e => {
      videos.forEach(v => { v.onloadeddata = v.onerror = null; v.src = ''; });
      throw e;
    });
  }

  function toCandidates(item) {
    if (Array.isArray(item)) return item.length ? item : [item];
    return [item];
  }

  function sortModsByTimeId(dataArray) {
    return dataArray.slice().sort((a, b) => (b.id || '').localeCompare(a.id || ''));
  }

  // ========== 全局状态 ==========
  const loadingOverlay = document.getElementById('loadingOverlay');
  const loadingGif = document.getElementById('loadingGif');
  const loadingText = document.getElementById('loadingText');
  const potionWrapper = document.getElementById('potionWrapper');
  const mainContent = document.getElementById('mainContent');
  mainContent.style.opacity = '0';
  mainContent.style.transition = 'opacity 0.5s ease';

  const logoImg = document.getElementById('logoImg');
  const logoTower = document.getElementById('logoTower');
  const logoArea = document.getElementById('logoArea');

  let modData = [];
  // ===== 修复：新增 allModData 保存当前分区完整数据，用于搜索后恢复 =====
  let allModData = [];
  let activeCategory = 'all';
  let currentPage = 1;
  const ITEMS_PER_PAGE = 8;

  // 全站数据缓存（用于全站搜索）
  let allSiteData = {};
  let manifestCache = {};

  const modGrid = document.getElementById('modGrid');
  const paginationEl = document.getElementById('pagination');
  const searchInput = document.getElementById('searchInput');
  const searchDropdown = document.getElementById('searchDropdown');
  const searchContainer = document.getElementById('searchContainer');
  const modalOverlay = document.getElementById('modalOverlay');
  const modalClose = document.getElementById('modalClose');
  const modalTitle = document.getElementById('modalTitle');
  const modalRid = document.getElementById('modalRid');
  const modalRidWrap = document.getElementById('modalRidWrap');
  const ridDropdown = document.getElementById('ridDropdown');
  const modalTags = document.getElementById('modalTags');
  const modalDescText = document.getElementById('modalDescText');
  const descToggle = document.getElementById('descToggle');
  const modalAuthor = document.getElementById('modalAuthor');
  const modalLinks = document.getElementById('modalLinks');
  const downloadButtons = document.getElementById('downloadButtons');
  const lightboxOverlay = document.getElementById('lightboxOverlay');
  const lightboxClose = document.getElementById('lightboxClose');
  const lightboxImg = document.getElementById('lightboxImg');
  const previewImagesBtn = document.getElementById('previewImagesBtn');
  const previewVideosBtn = document.getElementById('previewVideosBtn');
  const previewContentArea = document.getElementById('previewContentArea');
  const charaOverlay = document.getElementById('charaOverlay');
  const charaClose = document.getElementById('charaClose');
  const charaImg = document.getElementById('charaImg');
  const toast = document.getElementById('toast');

  const dataSources = {
    all: 'resources/json/post/sts2_mods/sts2_mods_1.json',
    skin: 'resources/json/post/O.o_interface/O.o_interface_1.json'
  };
  const dataCache = {};
  // ========== 分享链接预加载状态 ==========
  let sharedRidTarget = null;   // 预加载找到的帖子对象
  let sharedRidPromise = null;  // 预加载 Promise，首页加载完后 await 它
  let sharedRidParam = null;    // 当前 URL 中的 rid 参数


  let currentImages = [];
  let currentIndex = 0;
  let currentMod = null;
  let activePreviewTab = null;

  const FALLBACK_LOADED2 = 'https://cdn.jsdmirror.com/gh/eyteamd-max/HTML-full-linked-html-/loaded_2.gif';
  window.loaded2GifSrc = null;

  // 站点域名（用于分享链接）
  const SITE_DOMAIN = 'axxxx.cyou';

  let toastTimer;
  function showToast(message) {
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.add('show');
    toastTimer = setTimeout(() => { toast.classList.remove('show'); }, 2200);
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    } else {
      return new Promise((resolve, reject) => {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        textarea.style.pointerEvents = 'none';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        try { document.execCommand('copy'); document.body.removeChild(textarea); resolve(); }
        catch (err) { document.body.removeChild(textarea); reject(err); }
      });
    }
  }

  // ========== 解析 manifest.json 范围 ==========
  function parseManifestRange(rangeStr) {
    if (!rangeStr || typeof rangeStr !== 'string') return [];
    const parts = rangeStr.split('~');
    if (parts.length !== 2) return [];
    const start = parseInt(parts[0], 10);
    const end = parseInt(parts[1], 10);
    if (isNaN(start) || isNaN(end)) return [];
    const result = [];
    for (let i = start; i <= end; i++) result.push(i);
    return result;
  }

  // ========== 加载 manifest ==========
  async function loadManifest(categoryKey) {
    if (manifestCache[categoryKey]) return manifestCache[categoryKey];
    const dirMap = {
      all: 'sts2_mods',
      skin: 'O.o_interface'
    };
    const dir = dirMap[categoryKey];
    if (!dir) return null;
    const manifestUrl = 'resources/json/post/' + dir + '/manifest.json';
    try {
      const resp = await fetch(manifestUrl);
      if (!resp.ok) return null;
      const data = await resp.json();
      manifestCache[categoryKey] = data;
      return data;
    } catch (e) {
      return null;
    }
  }

  // ========== 根据 manifest 加载指定序号的 JSON ==========
  async function loadJsonByManifest(categoryKey, fileIndex) {
    const dirMap = {
      all: 'sts2_mods',
      skin: 'O.o_interface'
    };
    const dir = dirMap[categoryKey];
    if (!dir) return [];
    const url = 'resources/json/post/' + dir + '/' + dir + '_' + fileIndex + '.json';
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);
      if (!response.ok) return [];
      let rawData = await response.json();
      rawData = sortModsByTimeId(rawData);
      return rawData;
    } catch (error) {
      return [];
    }
  }

  // ========== 加载某一分区的所有数据（用于分页计算和全站搜索） ==========
    async function loadAllDataForCategory(categoryKey) {
    if (allSiteData[categoryKey]) return allSiteData[categoryKey];

    const manifest = await loadManifest(categoryKey);
    const dirMap = { all: 'sts2_mods', skin: 'O.o_interface' };
    const dir = dirMap[categoryKey];

    if (manifest && manifest[dir]) {
      const rangeStr = manifest[dir];
      const indices = parseManifestRange(rangeStr);
      // 并行加载所有分片，避免串行等待
      const dataArrays = await Promise.all(indices.map(function(idx) { return loadJsonByManifest(categoryKey, idx); }));
      const allData = dataArrays.flat();
      allSiteData[categoryKey] = allData;
      return allData;
    }

    // 回退到旧模式（单个文件）
    const url = dataSources[categoryKey];
    if (!url) return [];
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(function() { controller.abort(); }, 8000);
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);
      if (!response.ok) return [];
      let rawData = await response.json();
      rawData = sortModsByTimeId(rawData);
      allSiteData[categoryKey] = rawData;
      return rawData;
    } catch (error) {
      return [];
    }
  }

  // ========== 分页渲染 ==========
  function renderPagination(totalItems, currentPageNum) {
    paginationEl.innerHTML = '';
    const totalPages = Math.ceil(totalItems / ITEMS_PER_PAGE);
    if (totalPages <= 1) return;

    const prevBtn = document.createElement('button');
    prevBtn.className = 'pagination-btn';
    prevBtn.innerHTML = '&#8249;'; // ‹
    prevBtn.disabled = currentPageNum <= 1;
    prevBtn.addEventListener('click', () => {
      if (currentPageNum > 1) {
        currentPage = currentPageNum - 1;
        renderPage(currentPage);
        modGrid.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
    paginationEl.appendChild(prevBtn);

    const maxVisible = 5;
    let startPage = Math.max(1, currentPageNum - Math.floor(maxVisible / 2));
    let endPage = Math.min(totalPages, startPage + maxVisible - 1);
    if (endPage - startPage < maxVisible - 1) {
      startPage = Math.max(1, endPage - maxVisible + 1);
    }

    if (startPage > 1) {
      const first = document.createElement('button');
      first.className = 'pagination-page';
      first.textContent = '1';
      first.addEventListener('click', () => { currentPage = 1; renderPage(1); modGrid.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
      paginationEl.appendChild(first);
      if (startPage > 2) {
        const dots = document.createElement('span');
        dots.className = 'pagination-dots';
        dots.textContent = '...';
        paginationEl.appendChild(dots);
      }
    }

    for (let i = startPage; i <= endPage; i++) {
      const btn = document.createElement('button');
      btn.className = 'pagination-page' + (i === currentPageNum ? ' active' : '');
      btn.textContent = i;
      btn.addEventListener('click', () => {
        currentPage = i;
        renderPage(i);
        modGrid.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      paginationEl.appendChild(btn);
    }

    if (endPage < totalPages) {
      if (endPage < totalPages - 1) {
        const dots = document.createElement('span');
        dots.className = 'pagination-dots';
        dots.textContent = '...';
        paginationEl.appendChild(dots);
      }
      const last = document.createElement('button');
      last.className = 'pagination-page';
      last.textContent = totalPages;
      last.addEventListener('click', () => { currentPage = totalPages; renderPage(totalPages); modGrid.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
      paginationEl.appendChild(last);
    }

    const nextBtn = document.createElement('button');
    nextBtn.className = 'pagination-btn';
    nextBtn.innerHTML = '&#8250;'; // ›
    nextBtn.disabled = currentPageNum >= totalPages;
    nextBtn.addEventListener('click', () => {
      if (currentPageNum < totalPages) {
        currentPage = currentPageNum + 1;
        renderPage(currentPageNum + 1);
        modGrid.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
    paginationEl.appendChild(nextBtn);
  }

  function renderPage(pageNum) {
    const start = (pageNum - 1) * ITEMS_PER_PAGE;
    const end = start + ITEMS_PER_PAGE;
    const pageData = modData.slice(start, end);
    renderModCards(pageData);
    renderPagination(modData.length, pageNum);
  }

  // ========== Lightbox ==========
  function openLightbox(src) {
    lightboxImg.src = src;
    lightboxOverlay.classList.add('active');
  }

  // ========== 预览图片三次重试 ==========
  async function raceImageWithRetry(urls, maxRetries) {
    maxRetries = maxRetries || 2;
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await raceImage(urls);
      } catch (err) {
        lastError = err;
        if (attempt < maxRetries) {
          await new Promise(function(r) { setTimeout(r, 500); });
        }
      }
    }
    throw lastError;
  }

  function switchPreviewTab(tab) {
    activePreviewTab = (activePreviewTab === tab) ? null : tab;
    updatePreviewButtons();
    renderPreviewContent();
  }

  function updatePreviewButtons() {
    const imgActive = activePreviewTab === 'images';
    const vidActive = activePreviewTab === 'videos';
    previewImagesBtn.textContent = imgActive ? '预览图片 ▴' : '预览图片 ▾';
    previewVideosBtn.textContent = vidActive ? '预览视频 ▴' : '预览视频 ▾';
    previewImagesBtn.classList.toggle('active', imgActive);
    previewVideosBtn.classList.toggle('active', vidActive);
  }

  function renderPreviewContent() {
    if (!currentMod) { previewContentArea.innerHTML = ''; return; }
    const mod = currentMod;
    previewContentArea.innerHTML = '<div class="preview-empty-card">正在加载预览资源...</div>';
    if (activePreviewTab === 'images') {
      renderPreviewImages(Array.isArray(mod.previewImages) ? mod.previewImages : []);
    } else if (activePreviewTab === 'videos') {
      renderPreviewVideos(Array.isArray(mod.previewVideos) ? mod.previewVideos : []);
    } else {
      previewContentArea.innerHTML = '';
    }
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
    const placeholders = items.map(function() {
      const ph = document.createElement('div');
      ph.className = 'preview-image-item';
      ph.style.background = '#f0f0f0';
      ph.style.aspectRatio = '16/9';
      ph.textContent = '加载中...';
      grid.appendChild(ph);
      return ph;
    });
    await Promise.allSettled(
      items.map(function(item, idx) {
        const urls = toCandidates(item);
        return raceImageWithRetry(urls, 2).then(function(url) {
          const img = document.createElement('img');
          img.src = url;
          img.className = 'preview-image-item';
          img.style.cursor = 'zoom-in';
          img.addEventListener('click', function() { openLightbox(url); });
          grid.replaceChild(img, placeholders[idx]);
        }).catch(function() { placeholders[idx].textContent = '加载失败'; });
      })
    );
  }

  async function renderPreviewVideos(items) {
    if (items.length === 0) {
      previewContentArea.innerHTML = '<div class="preview-empty-card">该MOD猫猫还没有配置视频资源哦</div>';
      return;
    }
    const list = document.createElement('div');
    list.className = 'preview-video-list';
    previewContentArea.innerHTML = '';
    previewContentArea.appendChild(list);
    items.forEach(function(item) {
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
      raceVideo(urls).then(function(video) {
        video.className = 'preview-video-item';
        video.controls = true;
        if (item.poster) video.poster = item.poster;
        list.replaceChild(video, ph);
      }).catch(function() { ph.textContent = '视频加载失败'; });
    });
  }

  previewImagesBtn.addEventListener('click', function() { switchPreviewTab('images'); });
  previewVideosBtn.addEventListener('click', function() { switchPreviewTab('videos'); });

  // ========== 详情页打开（去掉轮播框） ==========
    async function openModal(mod) {
    currentMod = mod;

    modalTitle.textContent = mod.title;
    modalRid.textContent = 'RID: ' + (mod.id || '无');

    // 同步封面图片到详情页
    const modalCoverWrap = document.getElementById('modalCoverWrap');
    const modalCoverImg = document.getElementById('modalCoverImg');
    let coverSrc = '';
    if (mod.coverImage) {
        if (Array.isArray(mod.coverImage) && mod.coverImage.length > 0) {
            coverSrc = mod.coverImage[0];
        } else if (typeof mod.coverImage === 'string' && mod.coverImage.trim() !== '') {
            coverSrc = mod.coverImage;
        }
    }
    if (coverSrc) {
        modalCoverImg.src = coverSrc;
        modalCoverImg.style.display = 'block';
        modalCoverWrap.style.display = 'block';
    } else {
        modalCoverWrap.style.display = 'none';
        modalCoverImg.src = '';
    }


    modalRid.onclick = function(e) {
      e.stopPropagation();
      const isVisible = ridDropdown.style.display === 'block';
      ridDropdown.style.display = isVisible ? 'none' : 'block';
    };

    ridDropdown.querySelectorAll('.rid-option').forEach(function(btn) {
      btn.onclick = function(e) {
        e.stopPropagation();
        const action = btn.dataset.action;
        if (action === 'copy-rid') {
          const ridText = 'RID:' + (mod.id || '');
          copyText(ridText).then(function() { showToast('RID 已复制，快分享给小伙伴吧~'); }).catch(function() { showToast('复制失败，请手动复制'); });
        } else if (action === 'copy-link') {
          const linkText = 'https://' + SITE_DOMAIN + '/?rid=' + (mod.id || '');
          copyText(linkText).then(function() { showToast('帖子链接已复制~'); }).catch(function() { showToast('复制失败，请手动复制'); });
        }
        ridDropdown.style.display = 'none';
      };
    });

    modalTags.innerHTML = '';
    if (mod.tags && Array.isArray(mod.tags)) {
      mod.tags.forEach(function(tag) {
        const span = document.createElement('span');
        span.className = 'modal-tag ' + tag.toLowerCase();
        span.textContent = tag.toUpperCase();
        modalTags.appendChild(span);
      });
    }

    // 介绍文本 - 检测链接并高亮（粉色）
    let desc = (mod.description || '暂无介绍')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>');

    // 将 URL 文本转换为可点击的链接（粉色下划线）
    const urlRegex = /(https?:\/\/[^\s<"]+)/g;
    desc = desc.replace(urlRegex, '<a href="$1" target="_blank" rel="noopener noreferrer" class="desc-link">$1</a>');

    modalDescText.innerHTML = desc;
    modalDescText.classList.remove('expanded');
    descToggle.style.display = 'none';
    descToggle.textContent = '展开全文';

    modalAuthor.textContent = '作者：' + (mod.author || '佚名');

    modalLinks.innerHTML = '';
    if (mod.authorLinks) {
      if (Array.isArray(mod.authorLinks)) {
        mod.authorLinks.forEach(function(link) {
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
        links.forEach(function(link) {
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
    downloadLinks.forEach(function(dl) {
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

    modalOverlay.classList.add('active');
    document.body.style.overflow = 'hidden';
    setTimeout(function() {
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
    ridDropdown.style.display = 'none';
  }

  modalClose.addEventListener('click', closeModal);
  modalOverlay.addEventListener('click', function(e) { if (e.target === modalOverlay) closeModal(); });
  descToggle.addEventListener('click', function() {
    const expanded = modalDescText.classList.toggle('expanded');
    descToggle.textContent = expanded ? '收起' : '展开全文';
  });
  lightboxClose.addEventListener('click', function() { lightboxOverlay.classList.remove('active'); });
  lightboxOverlay.addEventListener('click', function(e) { if (e.target === lightboxOverlay) lightboxOverlay.classList.remove('active'); });

  // 点击页面其他地方关闭 RID 下拉
  document.addEventListener('click', function(e) {
    if (!modalRidWrap.contains(e.target)) {
      ridDropdown.style.display = 'none';
    }
  });

  // ========== 标签点击 - 不切换分区（BUG修复） ==========
  function handleTagClick(tagText) {
    searchInput.value = tagText;
    // 不切换 activeCategory，不修改分区标签状态
    filterMods();
    searchInput.focus();
  }

  // ========== 卡片加载圈修复（BUG修复） ==========
  function attachCardSpinner(cardElement) {
    const coverInner = cardElement.querySelector('.mod-cover-inner');
    const coverImg = coverInner ? coverInner.querySelector('.mod-cover-img') : null;
    if (!coverInner || !coverImg) return;

    // 如果图片已缓存完成，直接不创建spinner
    if (coverImg.complete && coverImg.naturalWidth > 0) {
      return;
    }

    const spinner = document.createElement('span');
    spinner.className = 'card-spinner';
    const hideSpinner = function() { 
      if (spinner.parentNode) {
        spinner.style.display = 'none';
        spinner.remove();
      }
    };

    coverImg.addEventListener('load', hideSpinner, { once: true });
    coverImg.addEventListener('error', hideSpinner, { once: true });

    // 保险：500ms后强制检查
    setTimeout(function() {
      if (coverImg.complete) hideSpinner();
    }, 500);

    coverInner.appendChild(spinner);
  }

  function renderModCards(dataArray) {
    modGrid.innerHTML = '';
    if (dataArray.length === 0) {
      modGrid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:50px;color:var(--text-muted);">没有找到相关MOD</div>';
      return;
    }
    const loaded2Src = window.loaded2GifSrc || FALLBACK_LOADED2;
    dataArray.forEach(function(mod) {
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
        tagsHtml = '<div class="mod-tag-list">' + mod.tags.map(function(t) {
          return '<span class="mod-tag-item ' + t.toLowerCase() + '">' + t.toUpperCase() + '</span>';
        }).join('') + '</div>';
      }
      const card = document.createElement('div');
      card.className = 'mod-card';
      card.innerHTML =
        '<div class="mod-cover">' +
          '<div class="mod-cover-inner">' +
            '<div class="mod-cover-gradient" style="background:' + mod.coverGradient + ';"></div>' +
            '<img src="' + imgSrc + '" alt="' + mod.title + '" class="mod-cover-img"' +
              ' style="position:absolute; width:100%; height:100%; ' + imgStyle + ' z-index:2; border-radius:inherit;"' +
              ' onerror="this.onerror=null; this.src=\'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent('<svg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 48 48\' fill=\'none\' stroke=\'%239a92a5\' stroke-width=\'3\'><circle cx=\'24\' cy=\'24\' r=\'20\'/><path d=\'M24 16v12\'/><circle cx=\'24\' cy=\'32\' r=\'2\' fill=\'%239a92a5\'/></svg>') + '\'; this.style.opacity=0.4;">' +
          '</div>' +
          '<span class="mod-badge ' + mod.badgeClass + '">' + mod.badge + '</span>' +
        '</div>' +
        '<div class="mod-info">' +
          '<div class="mod-title">' + mod.title + '</div>' +
          tagsHtml +
          '<div class="mod-meta">' +
            '<span class="mod-meta-tag">大小 ' + mod.size + '</span>' +
            '<span class="mod-meta-tag">日期 ' + mod.date + '</span>' +
          '</div>' +
          '<button class="mod-download-btn view-detail-btn">查看详情</button>' +
        '</div>';

      // 封面图点击打开Lightbox
      const coverImgEl = card.querySelector('.mod-cover-img');
      if (coverImgEl && hasCoverImg) {
        coverImgEl.addEventListener('click', function(e) {
          e.stopPropagation();
          if (coverImgEl.src && coverImgEl.src.indexOf('data:image/svg') === -1) {
            openLightbox(coverImgEl.src);
          }
        });
      }

      card.querySelector('.view-detail-btn').addEventListener('click', function(e) { e.stopPropagation(); openModal(mod); });
      card.querySelectorAll('.mod-tag-item').forEach(function(tagEl) {
        tagEl.addEventListener('click', function(e) { e.stopPropagation(); handleTagClick(tagEl.textContent); });
      });
      modGrid.appendChild(card);
      attachCardSpinner(card);
    });
  }

  // ========== 全站搜索（RID搜索跨分区） ==========

  // ========== 分享链接预加载（loading 阶段执行） ==========
  async function performGlobalRidSearchEarly(rid) {
    sharedRidParam = rid;
    const categories = ['all', 'skin'];
    // 并行加载所有分区数据（不阻塞，后台跑）
    const loadPromises = categories.map(function(cat) {
      return loadAllDataForCategory(cat).then(function(data) {
        if (data) {
          const found = data.find(function(m) { return m.id === rid; });
          if (found) return found;
        }
        return null;
      }).catch(function() { return null; });
    });
    const results = await Promise.all(loadPromises);
    for (let i = 0; i < results.length; i++) {
      if (results[i]) {
        sharedRidTarget = results[i];
        return results[i];
      }
    }
    return null;
  }

  async function performGlobalRidSearch(rid) {
    const categories = ['all', 'skin'];
    // 先搜索已缓存的数据，避免不必要的网络请求
    for (const cat of categories) {
      if (allSiteData[cat]) {
        const found = allSiteData[cat].find(function(m) { return m.id === rid; });
        if (found) return found;
      }
    }
    // 缓存未命中，再按需加载
    for (const cat of categories) {
      if (!allSiteData[cat]) {
        await loadAllDataForCategory(cat);
      }
      if (allSiteData[cat]) {
        const found = allSiteData[cat].find(function(m) { return m.id === rid; });
        if (found) return found;
      }
    }
    return null;
  }

  // ===== 修复：filterMods 从 allModData 过滤，不再污染原始数据 =====
  function filterMods() {
    const query = searchInput.value.trim();

    // 如果搜索框为空，从 allModData 恢复完整列表
    if (!query) {
      modData = allModData.slice();
      currentPage = 1;
      renderPage(1);
      searchDropdown.classList.remove('active');
      return;
    }

    let filtered = allModData.slice();
    if (activeCategory !== 'all') { 
      filtered = filtered.filter(function(m) { return m.category === activeCategory; }); 
    }

    const lowerQuery = query.toLowerCase();
    if (lowerQuery.startsWith('rid:')) {
      const ridPart = lowerQuery.slice(4).trim();
      performGlobalRidSearch(ridPart).then(function(found) {
        if (found) {
          openModal(found);
          searchInput.value = '';
          searchDropdown.classList.remove('active');
          // 清空后恢复列表
          modData = allModData.slice();
          currentPage = 1;
          renderPage(1);
        } else {
          modData = [];
          renderPage(1);
        }
      });
      return;
    } else if (/^\d+$/.test(query)) {
      performGlobalRidSearch(query).then(function(found) {
        if (found) {
          openModal(found);
          searchInput.value = '';
          searchDropdown.classList.remove('active');
          // 清空后恢复列表
          modData = allModData.slice();
          currentPage = 1;
          renderPage(1);
        } else {
          modData = [];
          renderPage(1);
        }
      });
      return;
    } else {
      filtered = filtered.filter(function(m) {
        if (m.title.toLowerCase().includes(lowerQuery)) return true;
        if (m.tags && m.tags.some(function(tag) { return tag.toLowerCase().includes(lowerQuery); })) return true;
        return false;
      });
    }

    modData = filtered;
    currentPage = 1;
    renderPage(1);
    updateSearchDropdown(query);
  }

  function updateSearchDropdown(query) {
    searchDropdown.innerHTML = '';
    if (!query || query.length < 1) { searchDropdown.classList.remove('active'); return; }
    const lowerQuery = query.toLowerCase();
    if (lowerQuery.startsWith('rid:') || /^\d+$/.test(query)) { searchDropdown.classList.remove('active'); return; }
    const matches = modData.filter(function(m) {
      if (m.title.toLowerCase().includes(lowerQuery)) return true;
      if (m.tags && m.tags.some(function(tag) { return tag.toLowerCase().includes(lowerQuery); })) return true;
      return false;
    });
    if (matches.length === 0) {
      searchDropdown.innerHTML = '<li style="padding:16px;text-align:center;color:var(--text-muted);">没有找到相关MOD</li>';
    } else {
      const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp('(' + escapedQuery + ')', 'gi');
      matches.slice(0, 8).forEach(function(m) {
        const li = document.createElement('li');
        li.className = 'search-dropdown-item';
        li.innerHTML = m.title.replace(regex, '<mark>$1</mark>');
        li.addEventListener('click', function() { searchInput.value = m.title; searchDropdown.classList.remove('active'); filterMods(); });
        searchDropdown.appendChild(li);
      });
    }
    searchDropdown.classList.add('active');
  }

  async function loadModData(categoryKey) {
    categoryKey = categoryKey || 'all';
    currentPage = 1;
    const loaded2Src = window.loaded2GifSrc || FALLBACK_LOADED2;
    modGrid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px;"><img src="' + loaded2Src + '" alt="加载中" style="max-width:200px;"></div>';
    paginationEl.innerHTML = '';

    // 先尝试 manifest 模式
    const manifest = await loadManifest(categoryKey);
    const dirMap = { all: 'sts2_mods', skin: 'O.o_interface' };
    const dir = dirMap[categoryKey];

    if (manifest && manifest[dir]) {
      const data = await loadAllDataForCategory(categoryKey);
      // ===== 修复：同时更新 allModData 和 modData =====
      allModData = data;
      modData = data.slice();
      searchInput.value = '';
      searchDropdown.classList.remove('active');
      renderPage(1);
      return;
    }

    // 回退到旧模式
    const url = dataSources[categoryKey];
    if (!url) return;
    try {
      if (dataCache[url]) {
        allModData = dataCache[url];
        modData = allModData.slice();
      } else {
        const controller = new AbortController();
        const timeoutId = setTimeout(function() { controller.abort(); }, 8000);
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (!response.ok) throw new Error('加载失败');
        let rawData = await response.json();
        rawData = sortModsByTimeId(rawData);
        allModData = rawData;
        modData = allModData.slice();
        dataCache[url] = allModData;
      }
      searchInput.value = '';
      searchDropdown.classList.remove('active');
      renderPage(1);
    } catch (error) {
      modGrid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px;">MOD数据加载失败，请稍后再试</div>';
    }
  }

  document.getElementById('categoryTags').addEventListener('click', function(e) {
    const tag = e.target.closest('.category-tag');
    if (!tag) return;
    document.querySelectorAll('.category-tag').forEach(function(t) { t.classList.remove('active'); });
    tag.classList.add('active');
    activeCategory = tag.getAttribute('data-category') || 'all';
    loadModData(activeCategory);
  });

  searchInput.addEventListener('input', filterMods);
  searchInput.addEventListener('focus', function() {
    if (searchInput.value.trim().length >= 1) updateSearchDropdown(searchInput.value.trim());
  });
  searchInput.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') { searchDropdown.classList.remove('active'); searchInput.blur(); }
    if (e.key === 'Enter') { searchDropdown.classList.remove('active'); filterMods(); }
  });
  document.addEventListener('click', function(e) {
    if (!searchContainer.contains(e.target)) searchDropdown.classList.remove('active');
  });

  charaClose.addEventListener('click', function() { charaOverlay.classList.remove('active'); });
  charaOverlay.addEventListener('click', function(e) { if (e.target === charaOverlay) charaOverlay.classList.remove('active'); });

  function openCharaDetail() {
    if (logoImg.src && logoImg.style.display !== 'none') { charaImg.src = logoImg.src; }
    else { charaImg.src = ''; }
    charaOverlay.classList.add('active');
  }

  // ========== URL 参数解析：?rid=xxx 自动打开详情 ==========
    async function handleUrlParams() {
    // 该函数现由 initPage 内的预加载逻辑统一处理，保留定义供其他场景调用
    const params = new URLSearchParams(window.location.search);
    const rid = params.get('rid');
    if (rid) {
      const found = await performGlobalRidSearch(rid);
      if (found) {
        openModal(found);
      } else {
        showToast('未找到该帖子');
      }
      history.replaceState({}, document.title, window.location.pathname);
    }
  }

  async function initPage() {
    // ===== 分享链接预加载：在 loading 动画期间就开始查数据 =====
    const urlParams = new URLSearchParams(window.location.search);
    const ridParam = urlParams.get('rid');
    if (ridParam) {
      // 立刻抹除 URL 参数，避免刷新重复
      history.replaceState({}, document.title, window.location.pathname + window.location.hash);
      // 后台启动预加载，不阻塞后续流程
      sharedRidPromise = performGlobalRidSearchEarly(ridParam);
    }

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

    try {
      const fetchWithTimeout = Promise.race([
        fetch('resources/json/config.json'),
        new Promise(function(_, reject) { setTimeout(function() { reject(new Error('timeout')); }, 3000); })
      ]);
      const resp = await fetchWithTimeout;
      if (resp.ok) {
        const config = await resp.json();
        if (config.loadingGifUrls && config.loadingGifUrls.length) loadingGifUrls = config.loadingGifUrls;
        if (config.logoUrls && config.logoUrls.length) logoUrls = config.logoUrls;
        if (config.loaded2GifUrls && config.loaded2GifUrls.length) loaded2GifUrls = config.loaded2GifUrls;
      }
    } catch (e) {}

    const gifPromise = raceImage(loadingGifUrls).catch(function() { return null; });
    const logoPromise = raceImage(logoUrls).catch(function() { return null; });
    const loaded2Promise = raceImage(loaded2GifUrls).catch(function() { return null; });

    setTimeout(function() {
      loadingOverlay.classList.add('hidden');
      mainContent.style.opacity = '1';
      loadModData('all');
    }, 100);

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

    logoArea.addEventListener('click', function(e) {
      if (e.target === logoArea || e.target === logoImg || e.target.closest('.logo-img') || e.target.closest('.logo-tower')) {
        openCharaDetail();
      }
    });

    // ===== 分享链接秒开：若预加载已找到帖子，首页渲染完后直接弹窗 =====
    if (sharedRidPromise) {
      try {
        await sharedRidPromise;
        if (sharedRidTarget) {
          openModal(sharedRidTarget);
        } else {
          showToast('未找到该帖子');
        }
      } catch (e) {
        showToast('加载分享帖子失败');
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPage);
  } else {
    initPage();
  }
})();