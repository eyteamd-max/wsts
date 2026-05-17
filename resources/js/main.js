(function() {
  /* ===== 工具函数 ===== */
  function raceImage(urls, timeout) {
    timeout = timeout || 3500;
    if (!urls || urls.length === 0) return Promise.reject('no urls');
    var timeoutPromise = new Promise(function(_, reject) { setTimeout(function() { reject(new Error('timeout')); }, timeout); });
    var loadPromises = urls.map(function(url) {
      return new Promise(function(resolve, reject) {
        var img = new Image();
        var stallTimer = setTimeout(function() { reject(new Error('stalled')); }, timeout + 2000);
        img.onload = img.onerror = function(e) { clearTimeout(stallTimer); if (e.type === 'load') resolve(url); else reject(new Error('failed')); };
        img.src = url;
      });
    });
    return Promise.race([Promise.any([timeoutPromise].concat(loadPromises)), new Promise(function(_, reject) { setTimeout(function() { reject(new Error('total timeout')); }, timeout + 3000); })]);
  }

  function raceVideo(urls) {
    if (!urls || urls.length === 0) return Promise.reject('no urls');
    var videos = [];
    var promises = urls.map(function(url) {
      return new Promise(function(resolve, reject) {
        var video = document.createElement('video'); video.preload = 'auto'; video.muted = true; video.playsInline = true;
        var timer = setTimeout(function() { reject(new Error('stalled')); }, 8000);
        video.onloadeddata = function() { clearTimeout(timer); resolve({ url: url, video: video }); };
        video.onerror = function() { clearTimeout(timer); reject(new Error('failed')); };
        video.src = url; videos.push(video);
      });
    });
    return Promise.any(promises).then(function(result) {
      videos.forEach(function(v) { if (v !== result.video) { v.onloadeddata = v.onerror = null; v.src = ''; v.load(); } });
      var cv = result.video.cloneNode(true); cv.muted = true; cv.playsInline = true; cv.preload = 'metadata'; return cv;
    }).catch(function(e) { videos.forEach(function(v) { v.onloadeddata = v.onerror = null; v.src = ''; }); throw e; });
  }

  function toCandidates(item) { if (Array.isArray(item)) return item.length ? item : [item]; return [item]; }
  function sortModsByTimeId(dataArray) { return dataArray.slice().sort(function(a, b) { return (b.id || '').localeCompare(a.id || ''); }); }

  /* RID生成：17位时间戳 YYYYMMDDHHmmssMMM */
  function generateModId() {
    var now = new Date();
    var p = function(n, l) { return String(n).padStart(l, '0'); };
    return p(now.getFullYear(), 4) + p(now.getMonth() + 1, 2) + p(now.getDate(), 2) +
           p(now.getHours(), 2) + p(now.getMinutes(), 2) + p(now.getSeconds(), 2) + p(now.getMilliseconds(), 3);
  }

  /* 从17位RID提取日期 YYYY-MM-DD */
  function extractDateFromRid(rid) {
    if (!rid || rid.length < 8) return '';
    return rid.slice(0, 4) + '-' + rid.slice(4, 6) + '-' + rid.slice(6, 8);
  }

  /* ===== DOM 引用 ===== */
  var loadingOverlay = document.getElementById('loadingOverlay');
  var loadingGif = document.getElementById('loadingGif');
  var loadingText = document.getElementById('loadingText');
  var potionWrapper = document.getElementById('potionWrapper');
  var mainContent = document.getElementById('mainContent');
  mainContent.style.opacity = '0'; mainContent.style.transition = 'opacity 0.5s ease';
  var logoImg = document.getElementById('logoImg');
  var logoTower = document.getElementById('logoTower');
  var logoArea = document.getElementById('logoArea');
  var modData = [];
  var activeCategory = 'all';
  var modGrid = document.getElementById('modGrid');
  var searchInput = document.getElementById('searchInput');
  var searchDropdown = document.getElementById('searchDropdown');
  var searchContainer = document.getElementById('searchContainer');
  var modalOverlay = document.getElementById('modalOverlay');
  var modalClose = document.getElementById('modalClose');
  var modalTitle = document.getElementById('modalTitle');
  var modalRid = document.getElementById('modalRid');
  var modalTags = document.getElementById('modalTags');
  var modalDescText = document.getElementById('modalDescText');
  var descToggle = document.getElementById('descToggle');
  var modalAuthor = document.getElementById('modalAuthor');
  var modalLinks = document.getElementById('modalLinks');
  var downloadButtons = document.getElementById('downloadButtons');
  var carouselTrack = document.getElementById('carouselTrack');
  var carouselDots = document.getElementById('carouselDots');
  var carouselPrev = document.getElementById('carouselPrev');
  var carouselNext = document.getElementById('carouselNext');
  var carouselContainer = document.getElementById('carouselContainer');
  var lightboxOverlay = document.getElementById('lightboxOverlay');
  var lightboxClose = document.getElementById('lightboxClose');
  var lightboxImg = document.getElementById('lightboxImg');
  var previewImagesBtn = document.getElementById('previewImagesBtn');
  var previewVideosBtn = document.getElementById('previewVideosBtn');
  var previewContentArea = document.getElementById('previewContentArea');
  var charaOverlay = document.getElementById('charaOverlay');
  var charaClose = document.getElementById('charaClose');
  var charaImg = document.getElementById('charaImg');
  var toast = document.getElementById('toast');
  var dataSources = { all: 'resources/json/sts2_mods.json', skin: 'resources/json/O.o_interface.json' };
  var dataCache = {};
  var currentImages = []; var currentIndex = 0; var currentMod = null; var activePreviewTab = null;
  var FALLBACK_LOADED2 = 'https://cdn.jsdmirror.com/gh/eyteamd-max/HTML-full-linked-html-/loaded_2.gif';
  window.loaded2GifSrc = null;
  var toastTimer;

  /* ===== 编辑模式变量 ===== */
  var editMode = false;
  var editCollapsed = false;
  var selectedCardIds = new Set();
  var editPopupResolve = null;
  var EDIT_KEY_PREFIX = 'sts2edit_';
  var editFab = document.getElementById('editFab');
  var editToolbar = document.getElementById('editToolbar');
  var editToolbarMini = document.getElementById('editToolbarMini');
  var editAddMod = document.getElementById('editAddMod');
  var editSelectAll = document.getElementById('editSelectAll');
  var editDeselectAll = document.getElementById('editDeselectAll');
  var editExportSelected = document.getElementById('editExportSelected');
  var editExportAll = document.getElementById('editExportAll');
  var editClearData = document.getElementById('editClearData');
  var editCollapse = document.getElementById('editCollapse');
  var editExit = document.getElementById('editExit');
  var editPopupOverlay = document.getElementById('editPopupOverlay');
  var editPopupTitle = document.getElementById('editPopupTitle');
  var editPopupInput = document.getElementById('editPopupInput');
  var editPopupCancel = document.getElementById('editPopupCancel');
  var editPopupConfirm = document.getElementById('editPopupConfirm');

  /* ===== 通用函数 ===== */
  function showToast(msg) { clearTimeout(toastTimer); toast.textContent = msg; toast.classList.add('show'); toastTimer = setTimeout(function() { toast.classList.remove('show'); }, 2200); }
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    return new Promise(function(resolve, reject) {
      var ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
      document.body.appendChild(ta); ta.focus(); ta.select();
      try { document.execCommand('copy'); document.body.removeChild(ta); resolve(); } catch (e) { document.body.removeChild(ta); reject(e); }
    });
  }

  /* ===== 编辑核心函数 ===== */
  function getEditKey(cat) { return EDIT_KEY_PREFIX + (cat || activeCategory); }
  function saveEditData() { try { localStorage.setItem(getEditKey(), JSON.stringify(modData)); } catch(e) {} }
  function loadEditData(cat) { try { var s = localStorage.getItem(EDIT_KEY_PREFIX + (cat || 'all')); if (s) return JSON.parse(s); } catch(e) {} return null; }
  function clearEditData(cat) { try { localStorage.removeItem(EDIT_KEY_PREFIX + (cat || 'all')); } catch(e) {} }
  function toggleEditMode() {
    editMode = !editMode; editCollapsed = false;
    if (!editMode) selectedCardIds.clear();
    editFab.classList.toggle('active', editMode);
    editToolbar.style.display = editMode ? 'flex' : 'none';
    editToolbarMini.style.display = 'none';
    document.body.classList.toggle('edit-mode-active', editMode);
    updateExportSelectedBtn(); filterMods();
    showToast(editMode ? '已进入编辑模式' : '已退出编辑模式');
  }
  function updateExportSelectedBtn() {
    editExportSelected.disabled = selectedCardIds.size === 0;
    editExportSelected.textContent = '导出选中' + (selectedCardIds.size > 0 ? '(' + selectedCardIds.size + ')' : '');
  }
  function showEditPopup(title, def) {
    return new Promise(function(resolve) {
      editPopupTitle.textContent = title; editPopupInput.value = def || '';
      editPopupOverlay.style.display = 'flex';
      setTimeout(function() { editPopupInput.focus(); editPopupInput.select(); }, 50);
      editPopupResolve = resolve;
    });
  }
  function exportJSON(data, filename) {
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob); var a = document.createElement('a');
    a.href = url; a.download = filename; a.click(); URL.revokeObjectURL(url);
  }
  function getExportFilename(prefix) {
    var n = new Date(); var p = function(v, l) { return String(v).padStart(l, '0'); };
    return prefix + '_' + n.getFullYear() + p(n.getMonth()+1,2) + p(n.getDate(),2) + '_' + p(n.getHours(),2) + p(n.getMinutes(),2) + p(n.getSeconds(),2) + '.json';
  }
  function addNewMod() {
    showEditPopup('输入MOD标题', '').then(function(title) {
      if (!title) return;
      var newId = generateModId();
      var newMod = { id: newId, title: title, category: activeCategory === 'all' ? 'skin' : activeCategory, size: '未知', date: extractDateFromRid(newId), badge: 'NEW', badgeClass: 'star', coverGradient: 'linear-gradient(135deg,#e8e0f0 0%,#d5c8e8 100%)', coverImage: [], images: [], description: '', author: '', authorLinks: [], tags: [], downloadLinks: [], previewImages: [], previewVideos: [] };
      modData.unshift(newMod); modData = sortModsByTimeId(modData);
      saveEditData(); filterMods(); showToast('新MOD已添加，RID: ' + newMod.id);
    });
  }

  /* ===== 轮播 ===== */
  function updateCarousel(images) {
    currentImages = images || []; currentIndex = 0;
    if (!currentImages.length) { carouselContainer.style.display = 'none'; return; }
    carouselContainer.style.display = 'block';
    carouselTrack.innerHTML = currentImages.map(function(s, i) { return '<div class="carousel-slide" data-index="'+i+'"><img src="'+s+'" alt="预览图 '+(i+1)+'"></div>'; }).join('');
    carouselDots.innerHTML = currentImages.map(function(_, i) { return '<span class="carousel-dot '+(i===0?'active':'')+'" data-index="'+i+'"></span>'; }).join('');
    carouselTrack.style.transform = 'translateX(0%)';
    carouselTrack.querySelectorAll('.carousel-slide').forEach(function(sl) { sl.addEventListener('click', function() { var i = parseInt(sl.dataset.index); if (currentImages[i]) { lightboxImg.src = currentImages[i]; lightboxOverlay.classList.add('active'); } }); });
    carouselDots.querySelectorAll('.carousel-dot').forEach(function(d) { d.addEventListener('click', function(e) { setCurrentIndex(parseInt(e.target.dataset.index)); }); });
    carouselPrev.onclick = function() { if (currentImages.length <= 1) return; setCurrentIndex((currentIndex - 1 + currentImages.length) % currentImages.length); };
    carouselNext.onclick = function() { if (currentImages.length <= 1) return; setCurrentIndex((currentIndex + 1) % currentImages.length); };
  }
  function setCurrentIndex(idx) { currentIndex = idx; carouselTrack.style.transform = 'translateX(-'+idx*100+'%)'; carouselDots.querySelectorAll('.carousel-dot').forEach(function(d, i) { d.classList.toggle('active', i === idx); }); }

  /* ===== 预览 ===== */
  function switchPreviewTab(tab) { activePreviewTab = (activePreviewTab === tab) ? null : tab; updatePreviewButtons(); renderPreviewContent(); }
  function updatePreviewButtons() { previewImagesBtn.textContent = activePreviewTab === 'images' ? '预览图片 ▴' : '预览图片 ▾'; previewVideosBtn.textContent = activePreviewTab === 'videos' ? '预览视频 ▴' : '预览视频 ▾'; previewImagesBtn.classList.toggle('active', activePreviewTab === 'images'); previewVideosBtn.classList.toggle('active', activePreviewTab === 'videos'); }
  function renderPreviewContent() { if (!currentMod) { previewContentArea.innerHTML = ''; return; } previewContentArea.innerHTML = '<div class="preview-empty-card">正在加载预览资源...</div>'; if (activePreviewTab === 'images') renderPreviewImages(Array.isArray(currentMod.previewImages) ? currentMod.previewImages : []); else if (activePreviewTab === 'videos') renderPreviewVideos(Array.isArray(currentMod.previewVideos) ? currentMod.previewVideos : []); else previewContentArea.innerHTML = ''; }
  async function renderPreviewImages(items) { if (!items.length) { previewContentArea.innerHTML = '<div class="preview-empty-card">该MOD猫猫还没有配置图片资源哦</div>'; return; } var g = document.createElement('div'); g.className = 'preview-image-grid'; previewContentArea.innerHTML = ''; previewContentArea.appendChild(g); var ph = items.map(function() { var d = document.createElement('div'); d.className = 'preview-image-item'; d.style.cssText = 'background:#f0f0f0;aspect-ratio:16/9'; d.textContent = '加载中...'; g.appendChild(d); return d; }); await Promise.allSettled(items.map(function(it, i) { return raceImage(toCandidates(it)).then(function(u) { var img = document.createElement('img'); img.src = u; img.className = 'preview-image-item'; img.style.cursor = 'zoom-in'; img.addEventListener('click', function() { lightboxImg.src = u; lightboxOverlay.classList.add('active'); }); g.replaceChild(img, ph[i]); }).catch(function() { ph[i].textContent = '加载失败'; }); })); }
  async function renderPreviewVideos(items) { if (!items.length) { previewContentArea.innerHTML = '<div class="preview-empty-card">该MOD猫猫还没有配置视频资源哦</div>'; return; } var l = document.createElement('div'); l.className = 'preview-video-list'; previewContentArea.innerHTML = ''; previewContentArea.appendChild(l); items.forEach(function(it) { var d = document.createElement('div'); d.className = 'preview-video-item'; d.style.cssText = 'background:#f0f0f0;height:200px;display:flex;align-items:center;justify-content:center'; d.textContent = '视频加载中...'; l.appendChild(d); var urls = []; if (it.urls && Array.isArray(it.urls) && it.urls.length) urls = it.urls; else if (it.url) urls = [it.url]; if (!urls.length) { d.textContent = '视频链接缺失'; return; } raceVideo(urls).then(function(v) { v.className = 'preview-video-item'; v.controls = true; if (it.poster) v.poster = it.poster; l.replaceChild(v, d); }).catch(function() { d.textContent = '视频加载失败'; }); }); }
  previewImagesBtn.addEventListener('click', function() { switchPreviewTab('images'); });
  previewVideosBtn.addEventListener('click', function() { switchPreviewTab('videos'); });

  /* ===== 模态框 ===== */
  async function openModal(mod) {
    currentMod = mod;
    var lo = document.createElement('div'); lo.className = 'modal-loading-overlay'; lo.innerHTML = '<div class="modal-loading-spinner"></div><div class="modal-loading-text">网页有点重，猫猫正在努力叼过来...</div>';
    document.body.appendChild(lo);
    var cb = document.createElement('button'); cb.className = 'modal-loading-close'; cb.innerHTML = '&times;'; document.body.appendChild(cb);
    var cancelled = false; var cleanup = function() { if (lo.parentNode) lo.remove(); if (cb.parentNode) cb.remove(); };
    cb.addEventListener('click', function() { cancelled = true; cleanup(); currentMod = null; });
    var cands = []; if (mod.images && mod.images.length) cands = mod.images; else if (mod.coverImage) cands = [mod.coverImage];
    var finalImgs = [];
    try { var r = await Promise.all(cands.map(function(it) { return raceImage(toCandidates(it)).catch(function() { return null; }); })); if (cancelled) return; finalImgs = r.filter(function(u) { return u; }); } catch(e) { if (cancelled) return; }
    cleanup(); if (cancelled) { currentMod = null; return; }

    // 标题
    if (editMode) { modalTitle.innerHTML = ''; var ts = document.createElement('span'); ts.className = 'editable-field'; ts.contentEditable = 'true'; ts.textContent = mod.title || ''; ts.dataset.field = 'title'; ts.dataset.modId = mod.id; ts.addEventListener('blur', function() { mod.title = ts.textContent.trim(); saveEditData(); }); ts.addEventListener('click', function(e) { e.stopPropagation(); }); modalTitle.appendChild(ts); var eb = document.createElement('span'); eb.className = 'modal-edit-badge'; eb.textContent = '可编辑'; modalTitle.appendChild(eb); }
    else { modalTitle.textContent = mod.title; }

    // RID + 重新生成按钮
    if (editMode) {
      modalRid.innerHTML = '';
      var rs = document.createElement('span'); rs.className = 'editable-field'; rs.contentEditable = 'true'; rs.textContent = mod.id || ''; rs.dataset.field = 'id'; rs.dataset.modId = mod.id;
      rs.addEventListener('blur', function() { mod.id = rs.textContent.trim(); mod.date = extractDateFromRid(mod.id); modData = sortModsByTimeId(modData); saveEditData(); });
      rs.addEventListener('click', function(e) { e.stopPropagation(); });
      modalRid.appendChild(rs);
      var regenBtn = document.createElement('button'); regenBtn.className = 'modal-rid-regen-btn'; regenBtn.textContent = '🔄 重新生成RID';
      regenBtn.addEventListener('click', function(e) { e.stopPropagation(); var newId = generateModId(); rs.textContent = newId; mod.id = newId; mod.date = extractDateFromRid(newId); modData = sortModsByTimeId(modData); saveEditData(); showToast('RID与日期已重新生成'); });
      modalRid.appendChild(regenBtn);
      modalRid.onclick = null;
    } else { modalRid.textContent = 'RID: ' + (mod.id || '无'); modalRid.onclick = function() { copyText('RID:' + (mod.id || '')).then(function() { showToast('RID 已复制'); }).catch(function() { showToast('复制失败'); }); }; }

    // 标签
    modalTags.innerHTML = '';
    if (mod.tags && Array.isArray(mod.tags)) { mod.tags.forEach(function(tag, idx) { var sp = document.createElement('span'); sp.className = 'modal-tag ' + tag.toLowerCase(); sp.textContent = tag.toUpperCase(); if (editMode) { var db = document.createElement('span'); db.textContent = ' \u00d7'; db.style.cssText = 'cursor:pointer;margin-left:4px;color:#b14b4b;font-weight:700'; db.addEventListener('click', function(e) { e.stopPropagation(); mod.tags.splice(idx, 1); saveEditData(); openModal(mod); }); sp.appendChild(db); } modalTags.appendChild(sp); }); }
    if (editMode) { var atb = document.createElement('button'); atb.className = 'modal-edit-add-btn'; atb.textContent = '+ 标签'; atb.addEventListener('click', async function() { var t = await showEditPopup('输入新标签', ''); if (t) { if (!mod.tags) mod.tags = []; mod.tags.push(t); saveEditData(); openModal(mod); } }); modalTags.appendChild(atb); }

    // 描述
    var desc = (mod.description || '暂无介绍').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
    if (editMode) { modalDescText.innerHTML = ''; var dd = document.createElement('div'); dd.className = 'editable-field'; dd.contentEditable = 'true'; dd.innerHTML = desc; dd.style.lineHeight = '1.7'; dd.addEventListener('blur', function() { mod.description = dd.innerText; saveEditData(); }); dd.addEventListener('click', function(e) { e.stopPropagation(); }); modalDescText.appendChild(dd); modalDescText.classList.add('expanded'); descToggle.style.display = 'none'; }
    else { modalDescText.innerHTML = desc; modalDescText.classList.remove('expanded'); descToggle.style.display = 'none'; descToggle.textContent = '展开全文'; }

    // 作者
    if (editMode) { modalAuthor.innerHTML = ''; modalAuthor.appendChild(document.createTextNode('作者：')); var as = document.createElement('span'); as.className = 'editable-field'; as.contentEditable = 'true'; as.textContent = mod.author || ''; as.addEventListener('blur', function() { mod.author = as.textContent.trim(); saveEditData(); }); as.addEventListener('click', function(e) { e.stopPropagation(); }); modalAuthor.appendChild(as); }
    else { modalAuthor.textContent = '作者：' + (mod.author || '佚名'); }

    // 作者链接
    modalLinks.innerHTML = '';
    if (editMode) {
      var la = []; if (mod.authorLinks) { if (Array.isArray(mod.authorLinks)) la = mod.authorLinks.slice(); else { [{ name:'Twitter',key:'twitter' },{ name:'Pixiv',key:'pixiv' },{ name:'Bilibili',key:'bilibili' }].forEach(function(m) { if (mod.authorLinks[m.key]) la.push({ text: m.name, url: mod.authorLinks[m.key] }); }); } }
      var lc = document.createElement('div'); lc.style.cssText = 'display:flex;flex-direction:column;gap:6px';
      la.forEach(function(link, idx) {
        var row = document.createElement('div'); row.className = 'modal-link-edit-row';
        var t1 = document.createElement('span'); t1.className = 'editable-field'; t1.contentEditable = 'true'; t1.textContent = link.text || ''; t1.style.cssText = 'min-width:50px;max-width:80px';
        t1.addEventListener('blur', function() { link.text = t1.textContent.trim(); if (!Array.isArray(mod.authorLinks)) mod.authorLinks = la; saveEditData(); });
        t1.addEventListener('click', function(e) { e.stopPropagation(); });
        var u1 = document.createElement('span'); u1.className = 'editable-field'; u1.contentEditable = 'true'; u1.textContent = link.url || ''; u1.style.minWidth = '100px';
        u1.addEventListener('blur', function() { link.url = u1.textContent.trim(); if (!Array.isArray(mod.authorLinks)) mod.authorLinks = la; saveEditData(); });
        u1.addEventListener('click', function(e) { e.stopPropagation(); });
        var db = document.createElement('button'); db.className = 'modal-link-edit-delete'; db.innerHTML = '&times;';
        db.addEventListener('click', function() { la.splice(idx, 1); mod.authorLinks = la; saveEditData(); openModal(mod); });
        row.appendChild(t1); row.appendChild(document.createTextNode(': ')); row.appendChild(u1); row.appendChild(db); lc.appendChild(row);
      });
      var alb = document.createElement('button'); alb.className = 'modal-edit-add-btn'; alb.textContent = '+ 作者链接';
      alb.addEventListener('click', async function() { var t = await showEditPopup('链接文字', ''); if (t === null) return; var u = await showEditPopup('链接URL', ''); if (u === null) return; la.push({ text: t || '链接', url: u || '' }); mod.authorLinks = la; saveEditData(); openModal(mod); });
      lc.appendChild(alb); modalLinks.appendChild(lc);
    } else {
      if (mod.authorLinks) {
        if (Array.isArray(mod.authorLinks)) mod.authorLinks.forEach(function(l) { if (l.text && l.url) { var a = document.createElement('a'); a.className = 'modal-link'; a.href = l.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = l.text; modalLinks.appendChild(a); } });
        else { [{ name:'Twitter',url:mod.authorLinks.twitter },{ name:'Pixiv',url:mod.authorLinks.pixiv },{ name:'Bilibili',url:mod.authorLinks.bilibili }].forEach(function(l) { if (l.url) { var a = document.createElement('a'); a.className = 'modal-link'; a.href = l.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = l.name; modalLinks.appendChild(a); } }); }
      }
    }

    // 下载
    downloadButtons.innerHTML = '';
    var dls = mod.downloadLinks && mod.downloadLinks.length ? mod.downloadLinks : (mod.downloadUrl ? [{ text:'下载', url:mod.downloadUrl }] : []);
    if (editMode) {
      var dlc = document.createElement('div'); dlc.style.cssText = 'display:flex;flex-direction:column;gap:6px';
      dls.forEach(function(dl, idx) {
        var row = document.createElement('div'); row.className = 'modal-link-edit-row';
        var t1 = document.createElement('span'); t1.className = 'editable-field'; t1.contentEditable = 'true'; t1.textContent = dl.text || ''; t1.style.cssText = 'min-width:50px;max-width:80px';
        t1.addEventListener('blur', function() { dl.text = t1.textContent.trim(); saveEditData(); }); t1.addEventListener('click', function(e) { e.stopPropagation(); });
        var u1 = document.createElement('span'); u1.className = 'editable-field'; u1.contentEditable = 'true'; u1.textContent = dl.url || ''; u1.style.minWidth = '100px';
        u1.addEventListener('blur', function() { dl.url = u1.textContent.trim(); saveEditData(); }); u1.addEventListener('click', function(e) { e.stopPropagation(); });
        var db = document.createElement('button'); db.className = 'modal-link-edit-delete'; db.innerHTML = '&times;';
        db.addEventListener('click', function() { dls.splice(idx, 1); mod.downloadLinks = dls; saveEditData(); openModal(mod); });
        row.appendChild(t1); row.appendChild(document.createTextNode(': ')); row.appendChild(u1); row.appendChild(db); dlc.appendChild(row);
      });
      if (!mod.downloadLinks) mod.downloadLinks = dls;
      var adb = document.createElement('button'); adb.className = 'modal-edit-add-btn'; adb.textContent = '+ 下载链接';
      adb.addEventListener('click', async function() { var t = await showEditPopup('按钮文字', ''); if (t === null) return; var u = await showEditPopup('下载URL', ''); if (u === null) return; dls.push({ text: t || '下载', url: u || '' }); mod.downloadLinks = dls; saveEditData(); openModal(mod); });
      dlc.appendChild(adb); downloadButtons.appendChild(dlc);
    } else { dls.forEach(function(dl) { var b = document.createElement('a'); b.className = 'download-btn-item'; b.href = dl.url; b.target = '_blank'; b.rel = 'noopener noreferrer'; b.textContent = dl.text; downloadButtons.appendChild(b); }); }

    // URL编辑区
    if (editMode) {
      var es = document.getElementById('editUrlSection'); if (es) es.remove();
      var us = document.createElement('div'); us.className = 'modal-edit-url-section'; us.id = 'editUrlSection';
      if (!Array.isArray(mod.previewImages)) mod.previewImages = [];
      if (!Array.isArray(mod.previewVideos)) mod.previewVideos = [];
      if (!Array.isArray(mod.images)) mod.images = [];
      function buildList(arr, label, onAdd) {
        var h = document.createElement('h4'); h.textContent = label; us.appendChild(h);
        var c = document.createElement('div');
        (function render() {
          c.innerHTML = '';
          arr.forEach(function(it, idx) {
            var url = (typeof it === 'string') ? it : ((it.urls && it.urls[0]) || it.url || '');
            var r = document.createElement('div'); r.className = 'modal-edit-url-row';
            var inp = document.createElement('input'); inp.type = 'text'; inp.value = url; inp.placeholder = 'URL';
            inp.addEventListener('blur', function() { var v = inp.value.trim(); if (typeof arr[idx] === 'object' && arr[idx].urls) arr[idx].urls = v ? [v] : []; else arr[idx] = v; saveEditData(); });
            var del = document.createElement('button'); del.className = 'modal-link-edit-delete'; del.innerHTML = '&times;';
            del.addEventListener('click', function() { arr.splice(idx, 1); saveEditData(); render(); });
            r.appendChild(inp); r.appendChild(del); c.appendChild(r);
          });
          var ab = document.createElement('button'); ab.className = 'modal-edit-add-btn'; ab.textContent = '+ ' + label;
          ab.addEventListener('click', onAdd); c.appendChild(ab);
        })();
        us.appendChild(c);
      }
      buildList(mod.previewImages, '预览图片URL', async function() { var u = await showEditPopup('输入图片URL', ''); if (u) { mod.previewImages.push(u); saveEditData(); openModal(mod); } });
      buildList(mod.previewVideos, '预览视频URL', async function() { var u = await showEditPopup('输入视频URL', ''); if (u) { mod.previewVideos.push(u); saveEditData(); openModal(mod); } });
      buildList(mod.images, '详情轮播图URL', async function() { var u = await showEditPopup('输入图片URL', ''); if (u) { mod.images.push(u); saveEditData(); openModal(mod); } });
      var h4s = us.querySelectorAll('h4'); if (h4s[1]) h4s[1].style.marginTop = '12px'; if (h4s[2]) h4s[2].style.marginTop = '12px';
      var ps = document.querySelector('.preview-section');
      if (ps && ps.nextSibling) ps.parentNode.insertBefore(us, ps.nextSibling); else if (ps) ps.parentNode.appendChild(us);
    } else { var es2 = document.getElementById('editUrlSection'); if (es2) es2.remove(); }

    activePreviewTab = null; updatePreviewButtons(); renderPreviewContent(); updateCarousel(finalImgs);
    carouselPrev.style.display = ''; carouselNext.style.display = '';
    modalOverlay.classList.add('active'); document.body.style.overflow = 'hidden';
    setTimeout(function() { if (!editMode && modalDescText.scrollHeight > modalDescText.clientHeight + 2) descToggle.style.display = 'inline-block'; }, 50);
  }

  function closeModal() {
    modalOverlay.classList.remove('active'); document.body.style.overflow = ''; currentMod = null; activePreviewTab = null;
    var es = document.getElementById('editUrlSection'); if (es) es.remove();
    if (editMode) filterMods();
  }

  modalClose.addEventListener('click', closeModal);
  modalOverlay.addEventListener('click', function(e) { if (e.target === modalOverlay) closeModal(); });
  descToggle.addEventListener('click', function() { var ex = modalDescText.classList.toggle('expanded'); descToggle.textContent = ex ? '收起' : '展开全文'; });
  lightboxClose.addEventListener('click', function() { lightboxOverlay.classList.remove('active'); });
  lightboxOverlay.addEventListener('click', function(e) { if (e.target === lightboxOverlay) lightboxOverlay.classList.remove('active'); });

  function handleTagClick(tagText) { searchInput.value = tagText; document.querySelectorAll('.category-tag').forEach(function(t) { t.classList.remove('active'); }); var at = document.querySelector('.category-tag[data-category="all"]'); if (at) at.classList.add('active'); activeCategory = 'all'; filterMods(); searchInput.focus(); }
  function attachCardSpinner(card) { var ci = card.querySelector('.mod-cover-inner'); var img = ci ? ci.querySelector('.mod-cover-img') : null; if (!ci || !img) return; var sp = document.createElement('span'); sp.className = 'card-spinner'; var hide = function() { if (sp.parentNode) sp.style.display = 'none'; }; if (img.complete) hide(); else { img.addEventListener('load', hide); img.addEventListener('error', hide); } ci.appendChild(sp); }

  /* ===== 渲染卡片 ===== */
  function renderModCards(dataArray) {
    modGrid.innerHTML = '';
    if (!dataArray.length) { modGrid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:50px;color:var(--text-muted)">没有找到相关MOD</div>'; return; }
    var l2 = window.loaded2GifSrc || FALLBACK_LOADED2;
    var fbSvg = "data:image/svg+xml;charset=UTF-8," + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48' fill='none' stroke='%239a92a5' stroke-width='3'><circle cx='24' cy='24' r='20'/><path d='M24 16v12'/><circle cx='24' cy='32' r='2' fill='%239a92a5'/></svg>");
    dataArray.forEach(function(mod) {
      var csrc = ''; if (mod.coverImage) { csrc = Array.isArray(mod.coverImage) ? (mod.coverImage[0] || '') : mod.coverImage; }
      var hasC = csrc.trim() !== ''; var isrc = hasC ? csrc : l2; var isty = hasC ? 'object-fit:cover;' : 'object-fit:contain;';
      var tagsH = '';
      if (mod.tags && mod.tags.length) { tagsH = '<div class="mod-tag-list">' + mod.tags.map(function(t, i) { return '<span class="mod-tag-item '+t.toLowerCase()+'" data-tag-index="'+i+'">'+t.toUpperCase()+(editMode?'<span class="tag-delete-btn" data-tag-index="'+i+'"> \u00d7</span>':'')+'</span>'; }).join('') + (editMode?'<button class="mod-tag-add-btn" data-mod-id="'+mod.id+'">+</button>':'') + '</div>'; }
      else { tagsH = '<div class="mod-tag-list">'+(editMode?'<button class="mod-tag-add-btn" data-mod-id="'+mod.id+'">+ 标签</button>':'')+'</div>'; }
      var card = document.createElement('div'); card.className = 'mod-card' + (editMode ? ' edit-mode' : ''); card.dataset.modId = mod.id;
      var ec = editMode ? '<input type="checkbox" class="mod-card-edit-check" '+(selectedCardIds.has(mod.id)?'checked':'')+' data-mod-id="'+mod.id+'"><button class="mod-card-edit-delete" data-mod-id="'+mod.id+'" title="删除">\u00d7</button><button class="mod-card-edit-cover-btn" data-mod-id="'+mod.id+'">换封面</button><button class="mod-card-edit-badge-btn" data-mod-id="'+mod.id+'">Badge</button>' : '';
      var th, mh;
      if (editMode) { th = '<div class="mod-title editable-field" contenteditable="true" data-field="title" data-mod-id="'+mod.id+'">'+(mod.title||'')+'</div>'; mh = '<div class="mod-meta"><span class="mod-meta-tag">大小 <span class="editable-field" contenteditable="true" data-field="size" data-mod-id="'+mod.id+'">'+(mod.size||'')+'</span></span><span class="mod-meta-tag">日期 <span class="editable-field" contenteditable="true" data-field="date" data-mod-id="'+mod.id+'">'+(mod.date||'')+'</span></span></div>'; }
      else { th = '<div class="mod-title">'+mod.title+'</div>'; mh = '<div class="mod-meta"><span class="mod-meta-tag">大小 '+mod.size+'</span><span class="mod-meta-tag">日期 '+mod.date+'</span></div>'; }
      card.innerHTML = '<div class="mod-cover"><div class="mod-cover-inner"><div class="mod-cover-gradient" style="background:'+mod.coverGradient+'"></div><img src="'+isrc+'" alt="'+mod.title+'" class="mod-cover-img" style="position:absolute;width:100%;height:100%;'+isty+'z-index:2;border-radius:inherit" onerror="this.onerror=null;this.src=\''+fbSvg+'\';this.style.opacity=0.4"></div><span class="mod-badge '+mod.badgeClass+'">'+mod.badge+'</span>'+ec+'</div><div class="mod-info">'+th+tagsH+mh+'<button class="mod-download-btn view-detail-btn">查看详情</button></div>';
      card.querySelector('.view-detail-btn').addEventListener('click', function(e) { e.stopPropagation(); openModal(mod); });
      if (!editMode) card.querySelectorAll('.mod-tag-item').forEach(function(el) { el.addEventListener('click', function() { handleTagClick(el.textContent); }); });
      if (editMode) {
        var chk = card.querySelector('.mod-card-edit-check'); chk.addEventListener('change', function(e) { e.stopPropagation(); if (e.target.checked) selectedCardIds.add(mod.id); else selectedCardIds.delete(mod.id); updateExportSelectedBtn(); }); chk.addEventListener('click', function(e) { e.stopPropagation(); });
        card.querySelector('.mod-card-edit-delete').addEventListener('click', function(e) { e.stopPropagation(); if (confirm('确定删除"'+mod.title+'"吗？')) { modData = modData.filter(function(m) { return m.id !== mod.id; }); selectedCardIds.delete(mod.id); saveEditData(); filterMods(); } });
        card.querySelector('.mod-card-edit-cover-btn').addEventListener('click', async function(e) { e.stopPropagation(); var cu = Array.isArray(mod.coverImage) ? (mod.coverImage[0]||'') : (mod.coverImage||''); var u = await showEditPopup('输入封面图URL', cu); if (u !== null) { mod.coverImage = u ? [u] : []; saveEditData(); filterMods(); } });
        card.querySelector('.mod-card-edit-badge-btn').addEventListener('click', async function(e) { e.stopPropagation(); var nb = await showEditPopup('输入Badge文字', mod.badge||''); if (nb !== null) { mod.badge = nb; saveEditData(); filterMods(); } });
        card.querySelectorAll('.tag-delete-btn').forEach(function(b) { b.addEventListener('click', function(e) { e.stopPropagation(); var i = parseInt(b.dataset.tagIndex); if (mod.tags) { mod.tags.splice(i, 1); saveEditData(); filterMods(); } }); });
        card.querySelectorAll('.mod-tag-add-btn').forEach(function(b) { b.addEventListener('click', async function(e) { e.stopPropagation(); var t = await showEditPopup('输入新标签', ''); if (t) { if (!mod.tags) mod.tags = []; mod.tags.push(t); saveEditData(); filterMods(); } }); });
        card.querySelectorAll('.editable-field').forEach(function(el) {
          el.addEventListener('blur', function() { var f = el.dataset.field, mid = el.dataset.modId, mi = modData.find(function(m) { return m.id === mid; }); if (!mi) return; var v = el.textContent.trim(); if (f==='title') mi.title=v; else if (f==='size') mi.size=v; else if (f==='date') mi.date=v; saveEditData(); });
          el.addEventListener('click', function(e) { e.stopPropagation(); }); el.addEventListener('mousedown', function(e) { e.stopPropagation(); });
        });
      }
      modGrid.appendChild(card); attachCardSpinner(card);
    });
    /* 注意：添加新MOD按钮已迁移到编辑工具栏，不再在网格中显示 */
  }

  /* ===== 筛选 ===== */
  function filterMods() {
    var f = modData.slice(); if (activeCategory !== 'all') f = f.filter(function(m) { return m.category === activeCategory; });
    var q = searchInput.value.trim();
    if (q) { var lq = q.toLowerCase(); if (lq.startsWith('rid:')) f = f.filter(function(m) { return m.id === lq.slice(4).trim(); }); else if (/^\d+$/.test(q)) f = f.filter(function(m) { return m.id === q; }); else f = f.filter(function(m) { return (m.title.toLowerCase().includes(lq)) || (m.tags && m.tags.some(function(t) { return t.toLowerCase().includes(lq); })); }); }
    renderModCards(f); updateSearchDropdown(q);
  }
  function updateSearchDropdown(q) {
    searchDropdown.innerHTML = ''; if (!q || q.length < 1) { searchDropdown.classList.remove('active'); return; }
    var lq = q.toLowerCase(); if (lq.startsWith('rid:') || /^\d+$/.test(q)) { searchDropdown.classList.remove('active'); return; }
    var ms = modData.filter(function(m) { return (m.title.toLowerCase().includes(lq)) || (m.tags && m.tags.some(function(t) { return t.toLowerCase().includes(lq); })); });
    if (!ms.length) searchDropdown.innerHTML = '<li style="padding:16px;text-align:center;color:var(--text-muted)">没有找到相关MOD</li>';
    else { var eq = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); var rx = new RegExp('('+eq+')', 'gi'); ms.slice(0, 8).forEach(function(m) { var li = document.createElement('li'); li.className = 'search-dropdown-item'; li.innerHTML = m.title.replace(rx, '<mark>$1</mark>'); li.addEventListener('click', function() { searchInput.value = m.title; searchDropdown.classList.remove('active'); filterMods(); }); searchDropdown.appendChild(li); }); }
    searchDropdown.classList.add('active');
  }

  /* ===== 加载数据 ===== */
  async function loadModData(cat) {
    cat = cat || 'all'; var url = dataSources[cat]; if (!url) return;
    var l2 = window.loaded2GifSrc || FALLBACK_LOADED2;
    modGrid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px"><img src="'+l2+'" alt="加载中" style="max-width:200px"></div>';
    try {
      if (dataCache[url]) modData = dataCache[url];
      else { var c = new AbortController(); var tid = setTimeout(function() { c.abort(); }, 8000); var r = await fetch(url, { signal: c.signal }); clearTimeout(tid); if (!r.ok) throw new Error('fail'); var rd = await r.json(); rd = sortModsByTimeId(rd); modData = rd; dataCache[url] = modData; }
      var ed = loadEditData(cat); if (ed) { modData = ed; dataCache[url] = modData; }
      searchInput.value = ''; searchDropdown.classList.remove('active'); renderModCards(modData);
    } catch (e) { modGrid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px">MOD数据加载失败，请稍后再试</div>'; }
  }

  /* ===== 事件绑定（仅一次） ===== */
  document.getElementById('categoryTags').addEventListener('click', function(e) { var t = e.target.closest('.category-tag'); if (!t) return; document.querySelectorAll('.category-tag').forEach(function(x) { x.classList.remove('active'); }); t.classList.add('active'); activeCategory = t.getAttribute('data-category') || 'all'; loadModData(activeCategory); });
  searchInput.addEventListener('input', filterMods);
  searchInput.addEventListener('focus', function() { if (searchInput.value.trim().length >= 1) updateSearchDropdown(searchInput.value.trim()); });
  searchInput.addEventListener('keydown', function(e) { if (e.key === 'Escape') { searchDropdown.classList.remove('active'); searchInput.blur(); } if (e.key === 'Enter') { searchDropdown.classList.remove('active'); filterMods(); } });
  document.addEventListener('click', function(e) { if (!searchContainer.contains(e.target)) searchDropdown.classList.remove('active'); });
  charaClose.addEventListener('click', function() { charaOverlay.classList.remove('active'); });
  charaOverlay.addEventListener('click', function(e) { if (e.target === charaOverlay) charaOverlay.classList.remove('active'); });
  function openCharaDetail() { if (logoImg.src && logoImg.style.display !== 'none') charaImg.src = logoImg.src; else charaImg.src = ''; charaOverlay.classList.add('active'); }

  /* ===== 编辑模式事件绑定（仅一次） ===== */
  editFab.addEventListener('click', toggleEditMode);
  editExit.addEventListener('click', function() { editMode = false; editCollapsed = false; editFab.classList.remove('active'); editToolbar.style.display = 'none'; editToolbarMini.style.display = 'none'; document.body.classList.remove('edit-mode-active'); selectedCardIds.clear(); filterMods(); showToast('已退出编辑模式'); });
  editAddMod.addEventListener('click', addNewMod);
  editSelectAll.addEventListener('click', function() { modData.forEach(function(m) { selectedCardIds.add(m.id); }); updateExportSelectedBtn(); filterMods(); });
  editDeselectAll.addEventListener('click', function() { selectedCardIds.clear(); updateExportSelectedBtn(); filterMods(); });
  editClearData.addEventListener('click', function() { if (confirm('确定要清除当前分类的本地编辑数据吗？')) { clearEditData(activeCategory); dataCache = {}; loadModData(activeCategory); showToast('编辑数据已清除'); } });
  editExportAll.addEventListener('click', function() { var cn = activeCategory === 'all' ? 'sts2_mods' : 'O_o_interface'; exportJSON(modData, getExportFilename(cn)); showToast('全部数据已导出'); });
  editExportSelected.addEventListener('click', function() { if (!selectedCardIds.size) return; var sel = modData.filter(function(m) { return selectedCardIds.has(m.id); }); var cn = activeCategory === 'all' ? 'sts2_mods' : 'O_o_interface'; exportJSON(sel, getExportFilename(cn + '_selected_' + sel.length)); showToast('已导出 ' + sel.length + ' 条选中数据'); });

  /* 工具栏收起/展开 */
  editCollapse.addEventListener('click', function() { editCollapsed = true; editToolbar.style.display = 'none'; editToolbarMini.style.display = 'block'; document.body.classList.remove('edit-mode-active'); });
  editToolbarMini.addEventListener('click', function() { editCollapsed = false; editToolbar.style.display = 'flex'; editToolbarMini.style.display = 'none'; document.body.classList.add('edit-mode-active'); });

  /* 弹窗 */
  editPopupCancel.addEventListener('click', function() { editPopupOverlay.style.display = 'none'; if (editPopupResolve) editPopupResolve(null); editPopupResolve = null; });
  editPopupConfirm.addEventListener('click', function() { editPopupOverlay.style.display = 'none'; var v = editPopupInput.value.trim(); if (editPopupResolve) editPopupResolve(v || null); editPopupResolve = null; });
  editPopupInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') editPopupConfirm.click(); else if (e.key === 'Escape') editPopupCancel.click(); });
  editPopupOverlay.addEventListener('click', function(e) { if (e.target === editPopupOverlay) { editPopupOverlay.style.display = 'none'; if (editPopupResolve) editPopupResolve(null); editPopupResolve = null; } });

  /* 快捷键 */
  document.addEventListener('keydown', function(e) { if (e.ctrlKey && e.shiftKey && e.key === 'E') { e.preventDefault(); toggleEditMode(); } });

  /* ===== 初始化 ===== */
  async function initPage() {
    var gifUrls = ['https://cdn.jsdmirror.com/gh/eyteamd-max/HTML-full-linked-html-/loaded.gif'];
    var logoUrls = ['https://cdn.jsdmirror.com/gh/eyteamd-max/HTML-full-linked-html-/Lihui.gif'];
    var l2Urls = ['http://shp.qpic.cn/collector/1976464052/35195f23-993a-4bae-a95b-b01054c9aa2c/0', 'https://cdn.jsdmirror.com/gh/eyteamd-max/HTML-full-linked-html-/loaded_2.gif', 'https://cdn.jsdelivr.net/gh/eyteamd-max/HTML-full-linked-html-/loaded_2.gif'];
    try { var r = await Promise.race([fetch('resources/json/config.json'), new Promise(function(_, rej) { setTimeout(function() { rej(new Error('t')); }, 3000); })]); if (r.ok) { var c = await r.json(); if (c.loadingGifUrls && c.loadingGifUrls.length) gifUrls = c.loadingGifUrls; if (c.logoUrls && c.logoUrls.length) logoUrls = c.logoUrls; if (c.loaded2GifUrls && c.loaded2GifUrls.length) l2Urls = c.loaded2GifUrls; } } catch(e) {}
    var gp = raceImage(gifUrls).catch(function() { return null; });
    var lp = raceImage(logoUrls).catch(function() { return null; });
    var l2p = raceImage(l2Urls).catch(function() { return null; });
    setTimeout(function() { loadingOverlay.classList.add('hidden'); mainContent.style.opacity = '1'; loadModData('all'); }, 100);
    gp.then(function(s) { if (s) { loadingGif.src = s; loadingGif.style.display = 'block'; if (potionWrapper) potionWrapper.style.display = 'none'; } });
    lp.then(function(s) { if (s) { logoImg.src = s; logoImg.style.display = 'block'; logoTower.style.display = 'none'; } });
    l2p.then(function(s) { if (s) window.loaded2GifSrc = s; });
    logoArea.addEventListener('click', function(e) { if (e.target === logoArea || e.target === logoImg || e.target.closest('.logo-img') || e.target.closest('.logo-tower')) openCharaDetail(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initPage); else initPage();
})();
