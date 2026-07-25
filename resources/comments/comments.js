// comments.js — STS2娘化MOD站 评论区前端模块（B站楼层式）
(function () {
  'use strict';

  var API = window.COMMENT_API_BASE || 'https://cmt.axxxx.cyou';
  var MAX_ATTACH = 4;
  var SORT_KEY = 'cm_sort';

  var state = {
    user: null,
    rid: null,
    sort: localStorage.getItem(SORT_KEY) === 'time' ? 'time' : 'hot',
    tree: [],
    loading: false,
    rootEl: null,
    composeAtt: [],
    localPending: [],
    loadSeq: 0,
    mountedRid: null,
    lastModalOpen: false,
  };

  // ---------- 工具 ----------
  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function toast(msg) {
    if (typeof window._sTM === 'function') window._sTM(msg);
    else { var t = document.createElement('div'); t.textContent = msg; t.style.cssText = 'position:fixed;bottom:30px;left:50%;transform:translateX(-50%);background:#4a4458;color:#fff;padding:10px 20px;border-radius:8px;z-index:9999'; document.body.appendChild(t); setTimeout(function(){ t.remove(); }, 2000); }
  }
  async function api(path, opts) {
    opts = opts || {};
    opts.credentials = 'include';
    if (opts.body && typeof opts.body !== 'string' && !(opts.body instanceof FormData)) {
      opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
      opts.body = JSON.stringify(opts.body);
    }
    var r = await fetch(API + path, opts);
    var data = null;
    try { data = await r.json(); } catch (e) {}
    if (!r.ok) throw { status: r.status, message: (data && data.error) || ('请求失败 (' + r.status + ')') };
    return data;
  }
  function fileUrl(key) { return API + '/api/files/' + encodeURIComponent(key); }
  function avatarUrl(key) { return key ? fileUrl(key) : null; }
  function relTime(ts) {
    if (!ts) return '';
    var d = new Date(ts.replace(' ', 'T') + (ts.indexOf('T') === -1 ? 'Z' : ''));
    var diff = (Date.now() - d.getTime()) / 1000;
    if (isNaN(diff)) return ts;
    if (diff < 60) return '刚刚';
    if (diff < 3600) return Math.floor(diff / 60) + '分钟前';
    if (diff < 86400) return Math.floor(diff / 3600) + '小时前';
    if (diff < 2592000) return Math.floor(diff / 86400) + '天前';
    return ts.slice(0, 10);
  }
  function avatarHtml(key, nick, cls) {
    cls = cls || 'cm-avatar';
    var u = avatarUrl(key);
    if (u) return '<img class="' + cls + '" src="' + esc(u) + '" onerror="this.outerHTML=\'<div class=&quot;' + cls + ' def&quot;>' + esc((nick || '?').slice(0, 1)) + '</div>\'">';
    return '<div class="' + cls + ' def">' + esc((nick || '?').slice(0, 1)) + '</div>';
  }

  // SVG 点赞图标
  var LIKE_SVG = '<svg class="cm-like-icon" viewBox="0 0 24 24" width="15" height="15"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  // 通知推送（对接 main.js 全局通知系统）
  function addNotification(msg, type, data) {
    if (typeof window._addNotification === 'function') {
      window._addNotification(msg, type, data);
    }
  }

  // 用户状态同步到主站右上角菜单
  function syncUserToMenu(user) {
    if (typeof window._onUserChange === 'function') {
      window._onUserChange(user || null);
    }
  }

  // ---------- 用户态 ----------
  async function loadUser() {
    try { 
      var d = await api('/api/auth/me'); 
      state.user = d.user; 
      syncUserToMenu(state.user);
      if (d.user && d.user.mutedUntil && new Date(d.user.mutedUntil) > new Date()) {
        addNotification('你已被禁言，禁言结束时间：' + new Date(d.user.mutedUntil).toLocaleString(), 'mute');
      }
    }
    catch (e) { state.user = null; syncUserToMenu(null); }
  }

  // ---------- 评论加载 ----------
  async function loadComments() {
    if (!state.rid) return;
    var seq = ++state.loadSeq;
    try {
      var q = '?rid=' + encodeURIComponent(state.rid) + '&sort=' + state.sort;
      if (state.user && state.user.isAdmin) q += '&include=pending';
      var d = await api('/api/comments' + q);
      // 竞态保护：如果期间又切换了 rid，丢弃旧结果
      if (seq !== state.loadSeq) return;
      state.tree = d.tree || [];
      preprocessTree(state.tree);
      mergeLocalPending();
      render();
    } catch (e) {
      if (seq !== state.loadSeq) return;
      state.tree = [];
      toast(e.message || '评论加载失败');
      render();
    }
  }

  // 把嵌套 children 拍平为 _replies 数组，记录每条回复的直接父作者（用于 @提及）
  function flattenReplies(node) {
    var replies = [];
    if (node.children && node.children.length) {
      for (var i = 0; i < node.children.length; i++) {
        var child = node.children[i];
        child._replyTo = node.author.nickname;
        child._replyToId = node.author.id;
        replies.push(child);
        replies = replies.concat(flattenReplies(child));
      }
    }
    return replies;
  }

  function preprocessTree(tree) {
    for (var i = 0; i < tree.length; i++) {
      var node = tree[i];
      node._replies = flattenReplies(node);
      // 子回复统一按时间升序：旧的在上、新的在下
      node._replies.sort(function (a, b) { return a.createdAt.localeCompare(b.createdAt); });
    }
  }

  // ---------- 渲染 ----------
  function render() {
    var el = state.rootEl;
    if (!el) return;
    var h = '';
    h += '<div class="cm-header">';
    h += '<div class="cm-title">评论 <span class="cm-count">(' + state.tree.length + ')</span></div>';
    h += '<div class="cm-toolbar">';
    h += '<div class="cm-tabs"><button class="cm-tab ' + (state.sort === 'hot' ? 'active' : '') + '" data-sort="hot">热度</button><button class="cm-tab ' + (state.sort === 'time' ? 'active' : '') + '" data-sort="time">最新</button></div>';
    h += '<div class="cm-user">' + renderUserArea() + '</div>';
    h += '</div></div>';

    if (state.user && state.user.isAdmin) {
      var pendingCount = (state.tree || []).filter(function (n) { return n.status === 'pending'; }).length;
      h += '<div class="cm-admin-bar">';
      h += '<span class="cm-admin-label">管理员模式</span>';
      h += '<button class="cm-btn sm pending-btn" data-act="load-pending">待审核 (<span class="cm-pending-count">' + pendingCount + '</span>)</button>';
      h += '<button class="cm-btn sm pending-btn" data-act="load-user-mgmt">用户管理</button>';
      h += '<button class="cm-btn sm pending-btn" data-act="load-comment-mgmt">评论管理</button>';
      h += '</div>';
    }

    if (state.user) {
      h += renderCompose('top');
    } else {
      h += '<div class="cm-login-hint">登录后即可评论、回复与点赞 <button class="cm-btn sm primary" data-act="login">登录 / 注册</button></div>';
    }

    if (state.loading) {
      h += '<div class="cm-loading"><span class="cm-spin"></span>加载中…</div>';
    } else if (state.tree.length === 0) {
      h += '<div class="cm-empty">还没有评论，快来抢沙发吧</div>';
    } else {
      h += '<div class="cm-list" id="cmList">';
      for (var i = 0; i < state.tree.length; i++) h += renderFloor(state.tree[i]);
      h += '</div>';
    }
    el.innerHTML = h;
    bindEvents();
    bindAdminLongPress();
  }

  // 管理员长按顶层评论：显示置顶菜单（仅在外显评论区）
  function bindAdminLongPress() {
    if (!state.rootEl || !state.user || !state.user.isAdmin) return;
    state.rootEl.querySelectorAll('.cm-list > .cm-item').forEach(function (item) {
      if (item._longPressBound) return;
      item._longPressBound = true;
      var timer = null;
      var nodeId = Number(item.getAttribute('data-id'));
      var startX = 0, startY = 0;
      var start = function (e) {
        var t = e.touches ? e.touches[0] : e;
        startX = t.clientX; startY = t.clientY;
        timer = setTimeout(function () {
          timer = null;
          showPinMenu(item, nodeId);
        }, 600);
      };
      var cancel = function (e) {
        if (!timer) return;
        var t = e.changedTouches ? e.changedTouches[0] : e;
        if (t && Math.abs(t.clientX - startX) > 10) return;
        clearTimeout(timer); timer = null;
      };
      item.addEventListener('mousedown', start);
      item.addEventListener('touchstart', start, { passive: true });
      item.addEventListener('mouseup', cancel);
      item.addEventListener('mouseleave', function () { if (timer) { clearTimeout(timer); timer = null; } });
      item.addEventListener('touchend', cancel);
      item.addEventListener('touchmove', function () { if (timer) { clearTimeout(timer); timer = null; } }, { passive: true });
      item.addEventListener('contextmenu', function (e) {
        if (state.user && state.user.isAdmin) { e.preventDefault(); showPinMenu(item, nodeId); }
      });
    });
  }

  function showPinMenu(item, id) {
    var existing = document.getElementById('cmPinMenu');
    if (existing) existing.remove();
    var node = state.tree.find(function (n) { return n.id === id; });
    if (!node) return;
    var isPinned = !!node.pinned;
    var menu = document.createElement('div');
    menu.id = 'cmPinMenu';
    menu.className = 'cm-pin-menu';
    menu.innerHTML = '<button class="cm-pin-menu-item" data-act="pin">' + (isPinned ? '取消置顶' : '置顶评论') + '</button>' +
      '<button class="cm-pin-menu-item" data-act="cancel">取消</button>';
    var rect = item.getBoundingClientRect();
    menu.style.left = Math.max(8, rect.left + rect.width / 2 - 70) + 'px';
    menu.style.top = Math.max(8, rect.top - 84) + 'px';
    document.body.appendChild(menu);
    var close = function () { menu.remove(); document.removeEventListener('click', close); };
    menu.querySelectorAll('button').forEach(function (btn) {
      btn.onclick = function (e) {
        e.stopPropagation();
        var act = btn.getAttribute('data-act');
        if (act === 'cancel') { close(); return; }
        close();
        api('/api/admin/comments/' + id + '/pin', { method: 'POST', body: { pinned: !isPinned } })
          .then(function () {
            toast(isPinned ? '已取消置顶' : '已置顶');
            loadComments();
          }).catch(function (e) { toast(e.message || '操作失败'); });
      };
    });
    setTimeout(function () { document.addEventListener('click', close); }, 0);
  }

  function renderUserArea() {
    if (!state.user) return '<button class="cm-btn sm primary" data-act="login">登录 / 注册</button>';
    var u = state.user;
    var h = '<span class="cm-user-inner" data-act="profile">';
    h += avatarHtml(u.avatarKey, u.nickname, 'cm-avatar');
    h += '<span class="cm-nick">' + esc(u.nickname) + (u.isAdmin ? ' <span class="cm-admin-badge">管理员</span>' : '') + '</span>';
    h += '</span>';
    return h;
  }

  function renderCompose(scope, parentId, placeholder) {
    var id = 'cmCompose_' + scope + (parentId || '');
    var h = '<div class="cm-compose' + (scope === 'reply' ? ' in-item' : '') + '" data-scope="' + scope + '" data-parent="' + (parentId || '') + '">';
    h += '<textarea class="cm-compose-textarea" id="' + id + '" placeholder="' + esc(placeholder || '说点什么吧…') + '" maxlength="5000"></textarea>';
    h += '<div class="cm-compose-attachments" id="' + id + '_att"></div>';
    h += '<div class="cm-compose-actions">';
    h += '<div class="cm-compose-left"><label class="cm-file-btn" style="margin:0;cursor:pointer"><span class="cm-icon-paperclip"></span>附件<input type="file" class="cm-file-input" multiple accept="image/*,.txt,.log" style="display:none"></label><span class="cm-cooldown"></span></div>';
    h += '<button class="cm-btn primary sm cm-send" data-scope="' + scope + '" data-parent="' + (parentId || '') + '">发送</button>';
    h += '</div></div>';
    return h;
  }

  // 点赞按钮
  function renderLikeButton(node) {
    var liked = !!node.likedByMe;
    return '<button class="cm-action cm-like ' + (liked ? 'liked' : '') + '" data-act="like" data-id="' + node.id + '">' + LIKE_SVG + '<span class="cm-like-count">' + node.likeCount + '</span></button>';
  }

  // 渲染一个楼层（顶层评论）
  function renderFloor(node) {
    var isPending = node.status === 'pending';
    var replies = node._replies || [];

    var h = '<div class="cm-item' + (isPending ? ' pending' : '') + (node.pinned ? ' pinned' : '') + '" data-id="' + node.id + '">';
    h += '<div class="cm-item-row">';
    h += avatarHtml(node.author.avatarKey, node.author.nickname, 'cm-item-avatar');
    h += '<div class="cm-item-main">';
    h += '<div class="cm-item-meta">';
    h += '<span class="cm-item-nick">' + esc(node.author.nickname) + '</span>';
    if (node.author.isAdmin) h += '<span class="cm-admin-badge">管理员</span>';
    if (isPending) h += '<span class="cm-pending-badge">审核中</span>';
    if (node.pinned) h += '<span class="cm-pinned-badge">置顶</span>';
    h += '<span class="cm-item-time">' + esc(relTime(node.createdAt)) + '</span>';
    h += '</div>';
    h += '<div class="cm-item-content">' + esc(node.content) + '</div>';
    if (isPending) h += '<div class="cm-pending-hint">审核通过后将对所有人可见</div>';
    h += renderAttachments(node.attachments);
    // 操作栏
    h += '<div class="cm-item-actions">';
    h += renderLikeButton(node);
    if (state.user) h += '<button class="cm-action" data-act="reply" data-id="' + node.id + '">回复</button>';
    if (state.user && (state.user.id === node.author.id || state.user.isAdmin)) h += '<button class="cm-action" data-act="delete" data-id="' + node.id + '">删除</button>';
    if (state.user && state.user.isAdmin && isPending) {
      h += '<button class="cm-action cm-mod-approve" data-act="approve" data-id="' + node.id + '">通过</button>';
      h += '<button class="cm-action cm-mod-reject" data-act="reject" data-id="' + node.id + '">拒绝</button>';
    }
    h += '</div>';
    h += '</div></div>'; // main + row

    // 回复入口按钮（B 站式：点击打开详情页）
    if (replies.length) {
      h += '<button class="cm-reply-entry" data-act="open-detail" data-id="' + node.id + '">共 ' + replies.length + ' 条回复 ></button>';
    }

    h += '</div>'; // item
    return h;
  }

  // 渲染单条楼层评论（不含回复区，用于详情页顶部）
  function renderFloorSingle(node) {
    var isPending = node.status === 'pending';
    var h = '<div class="cm-item' + (isPending ? ' pending' : '') + '" data-id="' + node.id + '">';
    h += '<div class="cm-item-row">';
    h += avatarHtml(node.author.avatarKey, node.author.nickname, 'cm-item-avatar');
    h += '<div class="cm-item-main">';
    h += '<div class="cm-item-meta">';
    h += '<span class="cm-item-nick">' + esc(node.author.nickname) + '</span>';
    if (node.author.isAdmin) h += '<span class="cm-admin-badge">管理员</span>';
    if (isPending) h += '<span class="cm-pending-badge">审核中</span>';
    h += '<span class="cm-item-time">' + esc(relTime(node.createdAt)) + '</span>';
    h += '</div>';
    h += '<div class="cm-item-content">' + esc(node.content) + '</div>';
    if (isPending) h += '<div class="cm-pending-hint">审核通过后将对所有人可见</div>';
    h += renderAttachments(node.attachments);
    h += '<div class="cm-item-actions">';
    h += renderLikeButton(node);
    if (state.user) h += '<button class="cm-action" data-act="reply" data-id="' + node.id + '">回复</button>';
    if (state.user && (state.user.id === node.author.id || state.user.isAdmin)) h += '<button class="cm-action" data-act="delete" data-id="' + node.id + '">删除</button>';
    if (state.user && state.user.isAdmin && isPending) {
      h += '<button class="cm-action cm-mod-approve" data-act="approve" data-id="' + node.id + '">通过</button>';
      h += '<button class="cm-action cm-mod-reject" data-act="reject" data-id="' + node.id + '">拒绝</button>';
    }
    h += '</div>';
    h += '</div></div>';
    h += '</div>';
    return h;
  }

  // 渲染一条回复（扁平，@提及形式）
  function renderReply(reply, floorId) {
    var isPending = reply.status === 'pending';
    var showAt = reply._replyTo && reply.parentId !== Number(floorId);

    var h = '<div class="cm-reply' + (isPending ? ' pending' : '') + '" data-id="' + reply.id + '" data-floor="' + floorId + '">';
    h += avatarHtml(reply.author.avatarKey, reply.author.nickname, 'cm-reply-avatar');
    h += '<div class="cm-reply-main">';
    h += '<div class="cm-reply-meta">';
    h += '<span class="cm-reply-nick">' + esc(reply.author.nickname) + '</span>';
    if (reply.author.isAdmin) h += '<span class="cm-admin-badge">管理员</span>';
    if (isPending) h += '<span class="cm-pending-badge">审核中</span>';
    if (showAt) h += '<span class="cm-reply-at">回复 <b>@' + esc(reply._replyTo) + '</b></span>';
    h += '<span class="cm-item-time">' + esc(relTime(reply.createdAt)) + '</span>';
    h += '</div>';
    h += '<div class="cm-reply-content">' + esc(reply.content) + '</div>';
    if (isPending) h += '<div class="cm-pending-hint">审核通过后将对所有人可见</div>';
    h += renderAttachments(reply.attachments);
    // 操作
    h += '<div class="cm-reply-actions">';
    h += renderLikeButton(reply);
    if (state.user) h += '<button class="cm-action" data-act="reply" data-id="' + reply.id + '">回复</button>';
    if (state.user && (state.user.id === reply.author.id || state.user.isAdmin)) h += '<button class="cm-action" data-act="delete" data-id="' + reply.id + '">删除</button>';
    if (state.user && state.user.isAdmin && isPending) {
      h += '<button class="cm-action cm-mod-approve" data-act="approve" data-id="' + reply.id + '">通过</button>';
      h += '<button class="cm-action cm-mod-reject" data-act="reject" data-id="' + reply.id + '">拒绝</button>';
    }
    h += '</div>';
    h += '</div></div>';
    return h;
  }

  function renderAttachments(attachments) {
    if (!attachments || !attachments.length) return '';
    var images = [];
    var files = [];
    for (var i = 0; i < attachments.length; i++) {
      if (attachments[i].kind === 'image') images.push(attachments[i]);
      else files.push(attachments[i]);
    }
    var h = '';
    if (images.length) {
      h += '<div class="cm-att-images">';
      for (var i = 0; i < images.length; i++) {
        h += '<img class="pii cm-att-img" src="' + esc(images[i].url) + '" alt="图片" onclick="window._oLB(this.src)" onerror="this.style.display=\'none\'">';
      }
      h += '</div>';
    }
    if (files.length) {
      h += '<div class="cm-att-files">';
      for (var i = 0; i < files.length; i++) {
        var a = files[i];
        var sizeStr = formatSize(a.size || 0);
        h += '<div class="cm-att file" data-url="' + esc(a.url) + '" data-name="' + esc(a.name) + '">';
        h += '<div class="cm-att-file-icon"><svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></div>';
        h += '<div class="cm-att-file-info">';
        h += '<div class="cm-att-file-name">' + esc(a.name) + '</div>';
        h += '<div class="cm-att-file-meta">' + sizeStr + '</div>';
        h += '</div></div>';
      }
      h += '</div>';
    }
    return h;
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  // ---------- 事件绑定 ----------
  function bindEvents(rootEl) {
    rootEl = rootEl || state.rootEl;
    var el = rootEl;
    // 排序
    el.querySelectorAll('.cm-tab').forEach(function (t) {
      t.onclick = function () {
        state.sort = t.getAttribute('data-sort');
        localStorage.setItem(SORT_KEY, state.sort);
        loadComments();
      };
    });
    // 登录/资料
    el.querySelectorAll('[data-act="login"]').forEach(function (b) { b.onclick = function () { openAuthModal('login'); }; });
    var ua = el.querySelector('[data-act="profile"]');
    if (ua) ua.onclick = function () { openProfileModal(); };
    var pb = el.querySelector('[data-act="load-pending"]');
    if (pb) pb.onclick = function () { openPendingModal(); };
    var ub = el.querySelector('[data-act="load-user-mgmt"]');
    if (ub) ub.onclick = function () { openUserMgmtModal(); };
    var cb = el.querySelector('[data-act="load-comment-mgmt"]');
    if (cb) cb.onclick = function () { openCommentMgmtModal(); };

    // 发送
    el.querySelectorAll('.cm-send').forEach(function (b) {
      b.onclick = function () {
        sendComment(b.getAttribute('data-scope'), b.getAttribute('data-parent') || null);
      };
    });
    // 附件
    el.querySelectorAll('.cm-file-input').forEach(function (inp) {
      inp.onchange = function () { handleFileInput(inp, inp.closest('.cm-compose')); };
    });
    // 打开回复详情页（B 站式）
    el.querySelectorAll('[data-act="open-detail"]').forEach(function (b) {
      b.onclick = function () { openReplyDetail(b.getAttribute('data-id')); };
    });
    // 点赞/回复/删除/审核
    el.querySelectorAll('.cm-action[data-act]').forEach(function (b) {
      var act = b.getAttribute('data-act');
      if (act === 'like') b.onclick = function () { doLike(b); };
      else if (act === 'reply') b.onclick = function () { toggleReply(b.getAttribute('data-id'), rootEl); };
      else if (act === 'delete') b.onclick = function () { doDelete(b.getAttribute('data-id')); };
      else if (act === 'approve') b.onclick = function () { doModerate(b.getAttribute('data-id'), 'approve'); };
      else if (act === 'reject') b.onclick = function () { doModerate(b.getAttribute('data-id'), 'reject'); };
    });
    // 图片预览（复用网站原有 _oLB lightbox，无需绑定）+ 文件下载
    el.querySelectorAll('.cm-att.file').forEach(function (el) {
      el.onclick = function () {
        var url = el.getAttribute('data-url');
        var name = el.getAttribute('data-name') || 'download';
        var a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.target = '_blank';
        document.body.appendChild(a);
        a.click();
        a.remove();
      };
    });
  }

  // ---------- 发评论 ----------
  async function sendComment(scope, parentId) {
    if (!state.user) { openAuthModal('login'); return; }
    // 详情页的 compose 框挂在 overlay 内而非 state.rootEl，需全局查找
    var composeEl = document.querySelector('.cm-compose[data-scope="' + scope + '"][data-parent="' + (parentId || '') + '"]');
    if (!composeEl) { toast('回复框未找到，请重试'); return; }
    var ta = composeEl.querySelector('textarea');
    var content = (ta.value || '').trim();
    if (!content) { toast('请输入评论内容'); return; }
    var attachments = getAttachmentsArr(composeEl).slice(0, MAX_ATTACH);
    var btn = composeEl.querySelector('.cm-send');
    btn.disabled = true;
    try {
      var body = { rid: state.rid, content: content, attachments: attachments.map(function (a) { return { key: a.key, name: a.name, mime: a.mime, size: a.size, kind: a.kind }; }) };
      if (parentId) body.parentId = Number(parentId);
      var d = await api('/api/comments', { method: 'POST', body: body });
      ta.value = '';
      if (scope === 'top') state.composeAtt = [];
      var cdEl = composeEl.querySelector('.cm-cooldown');
      startCooldown(btn, cdEl, 5);
      // 立即将新评论插入本地树，pending 状态仅自己可见并显示"审核中"
      insertNewComment(d, scope, parentId);
      if (d.status === 'pending') {
        d._localPending = true;
        state.localPending.push(d);
      }
      // 移除详情页内的回复输入框（发送成功后收起）
      if (scope === 'reply') {
        var overlay = document.getElementById('cmDetailOverlay');
        if (overlay) {
          var usedCompose = overlay.querySelector('.cm-compose[data-scope="reply"]');
          if (usedCompose) usedCompose.remove();
          // 刷新详情页回复列表，让新回复立即可见
          refreshDetailReplies();
        }
      }
      render();
      if (window.fetchServerNotifications) window.fetchServerNotifications();
    } catch (e) {
      btn.disabled = false;
      // 禁言等个人信息提示放入右上角通知菜单
      if (e.status === 403 && /禁言/.test(e.message || '')) {
        addNotification(e.message, 'mute');
      } else {
        toast(e.message || '发送失败');
      }
    }
  }

  // 刷新详情页回复列表（发送回复后立即显示新回复）
  function refreshDetailReplies() {
    if (!detailState.floor) return;
    detailState.replies = (detailState.floor._replies || []).slice();
    var repliesEl = document.getElementById('cmDetailReplies');
    if (!repliesEl) return;
    var shown = detailState.replies.slice(0, detailState.page * detailState.pageSize);
    var h = '';
    for (var i = 0; i < shown.length; i++) h += renderReply(shown[i], detailState.floor.id);
    repliesEl.innerHTML = h;
    // 重新绑定 action 按钮事件
    var overlay = document.getElementById('cmDetailOverlay');
    if (overlay) bindDetailActions(overlay);
  }

  // 仅绑定详情页内 action 按钮（like/reply/delete/approve/reject/load-more/handle/overlay）
  function bindDetailActions(overlay) {
    overlay.querySelectorAll('.cm-action[data-act]').forEach(function (b) {
      var act = b.getAttribute('data-act');
      if (act === 'like') b.onclick = function () { doLike(b); };
      else if (act === 'reply') b.onclick = function () { toggleReply(b.getAttribute('data-id'), overlay); };
      else if (act === 'delete') b.onclick = function () { doDelete(b.getAttribute('data-id')); };
      else if (act === 'approve') b.onclick = function () { doModerate(b.getAttribute('data-id'), 'approve'); };
      else if (act === 'reject') b.onclick = function () { doModerate(b.getAttribute('data-id'), 'reject'); };
    });
    var loadMore = overlay.querySelector('[data-act="load-more"]');
    if (loadMore) loadMore.onclick = function () { detailState.page++; renderDetailOverlay(); };
  }

  function insertNewComment(node, scope, parentId) {
    node.children = node.children || [];
    node._replies = node._replies || [];
    if (scope === 'top') {
      if (state.sort === 'time') {
        state.tree.unshift(node);
      } else {
        state.tree.push(node);
      }
      preprocessTree(state.tree);
      // 保持与后端一致的顶层排序
      if (state.sort === 'time') {
        state.tree.sort(function (a, b) { return b.createdAt.localeCompare(a.createdAt); });
      } else {
        state.tree.sort(function (a, b) {
          var sa = a.likeCount + a.replyCount, sb = b.likeCount + b.replyCount;
          return sb - sa || b.createdAt.localeCompare(a.createdAt);
        });
      }
    } else {
      // 找到父楼层与实际被回复的节点（支持回复回复）
      var pid = Number(parentId);
      var floor = state.tree.find(function (n) { return n.id === pid; });
      var parentNode = floor;
      if (!floor) {
        for (var i = 0; i < state.tree.length; i++) {
          var r = state.tree[i]._replies.find(function (x) { return x.id === pid; });
          if (r) { floor = state.tree[i]; parentNode = r; break; }
        }
      }
      if (floor && parentNode) {
        node.parentId = pid;
        node._replyTo = parentNode.author ? parentNode.author.nickname : '';
        parentNode.children = parentNode.children || [];
        parentNode.children.push(node);
        // 重新计算该楼层的扁平回复列表
        floor._replies = flattenReplies(floor);
        floor.replyCount = floor._replies.length;
        // 子回复统一按时间升序：旧的在上、新的在下
        floor._replies.sort(function (a, b) { return a.createdAt.localeCompare(b.createdAt); });
      }
    }
  }

  // 把本地 pending 评论补回列表，防止 Cookie/鉴权瞬断导致“评论消失”
  function mergeLocalPending() {
    if (!state.localPending.length) return;
    var allIds = new Set();
    state.tree.forEach(function (n) {
      allIds.add(n.id);
      (n._replies || []).forEach(function (r) { allIds.add(r.id); });
    });
    var stillPending = [];
    for (var i = 0; i < state.localPending.length; i++) {
      var n = state.localPending[i];
      if (allIds.has(n.id)) continue; // 服务器已返回，无需保留本地副本
      stillPending.push(n);
      insertNewComment(n, n.parentId ? 'reply' : 'top', n.parentId);
    }
    state.localPending = stillPending;
  }

  function startCooldown(btn, cdEl, sec) {
    var n = sec;
    btn.disabled = true;
    if (cdEl) cdEl.textContent = '请 ' + n + 's 后再发';
    var timer = setInterval(function () {
      n--;
      if (n <= 0) { clearInterval(timer); btn.disabled = false; if (cdEl) cdEl.textContent = ''; }
      else if (cdEl) cdEl.textContent = '请 ' + n + 's 后再发';
    }, 1000);
  }

  // ---------- 附件上传 ----------
  // 使用 XHR 上传，支持进度回调（fetch 不支持上传进度）
  function uploadFileWithProgress(file, onProgress) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', API + '/api/uploads/comment-file');
      xhr.withCredentials = true;
      xhr.upload.onprogress = function (e) {
        if (e.lengthComputable) {
          var percent = Math.round((e.loaded / e.total) * 100);
          onProgress(e.loaded, e.total, percent);
        }
      };
      xhr.onload = function () {
        try {
          var data = JSON.parse(xhr.responseText);
          if (xhr.status >= 200 && xhr.status < 300) resolve(data);
          else reject({ status: xhr.status, message: (data && data.error) || '上传失败 (' + xhr.status + ')' });
        } catch (e) {
          reject({ status: xhr.status, message: '解析响应失败' });
        }
      };
      xhr.onerror = function () { reject({ status: 0, message: '网络错误' }); };
      var fd = new FormData();
      fd.append('file', file);
      xhr.send(fd);
    });
  }
  function getAttachmentsArr(composeEl) {
    if (composeEl.dataset.scope === 'top') {
      return state.composeAtt;
    }
    if (!composeEl._attachments) {
      composeEl._attachments = [];
    }
    return composeEl._attachments;
  }

  async function handleFileInput(inp, composeEl) {
    if (!state.user) { openAuthModal('login'); return; }
    var files = Array.prototype.slice.call(inp.files);
    inp.value = '';
    var arr = getAttachmentsArr(composeEl);
    var attBox = composeEl.querySelector('.cm-compose-attachments');
    if (!attBox) { toast('附件容器未找到，请刷新页面重试'); return; }
    var progressItems = [];
    for (var i = 0; i < files.length && arr.length + progressItems.length < MAX_ATTACH; i++) {
      (function (f) {
        var item = document.createElement('div');
        item.className = 'cm-upload-progress';
        item.innerHTML = '<div class="cm-upload-name">' + esc(f.name) + '</div>' +
          '<div class="cm-upload-bar-wrap"><div class="cm-upload-bar" style="width:0%"></div></div>' +
          '<div class="cm-upload-percent">0%</div>';
        attBox.appendChild(item);
        progressItems.push({ file: f, el: item });
      })(files[i]);
    }
    if (!progressItems.length) { toast('最多上传 ' + MAX_ATTACH + ' 个附件'); return; }
    var successCount = 0;
    var failCount = 0;
    var failMsgs = [];
    var uploadPromises = [];
    for (var j = 0; j < progressItems.length; j++) {
      (function (pi) {
        var p = new Promise(function (resolve) {
          uploadFileWithProgress(pi.file, function (loaded, total, percent) {
            var bar = pi.el.querySelector('.cm-upload-bar');
            var pct = pi.el.querySelector('.cm-upload-percent');
            if (bar) bar.style.width = percent + '%';
            if (pct) pct.textContent = percent + '%';
          }).then(function (d) {
            pi.el.querySelector('.cm-upload-bar').style.width = '100%';
            pi.el.querySelector('.cm-upload-percent').textContent = '100%';
            arr.push(d);
            successCount++;
            pi.el.remove();
            resolve();
          }).catch(function (e) {
            failCount++;
            failMsgs.push((pi.file.name || '文件') + ': ' + (e.message || '上传失败'));
            pi.el.classList.add('error');
            pi.el.querySelector('.cm-upload-percent').textContent = e.message || '失败';
            setTimeout(function () { pi.el.remove(); }, 3000);
            resolve();
          });
        });
        uploadPromises.push(p);
      })(progressItems[j]);
    }
    await Promise.all(uploadPromises);
    renderAttachments2(composeEl);
    if (successCount > 0) {
      toast('上传成功 ' + successCount + ' 个附件');
    }
    if (failCount > 0) {
      toast(failMsgs[0] || ('上传失败 ' + failCount + ' 个'));
    }
  }
  function renderAttachments2(composeEl) {
    var attBox = composeEl.querySelector('.cm-compose-attachments');
    if (!attBox) return;
    var arr = getAttachmentsArr(composeEl);
    arr = arr || [];
    var h = '';
    for (var i = 0; i < arr.length; i++) {
      var a = arr[i];
      if (!a) continue;
      if (a.kind === 'image') h += '<div class="cm-compose-att"><img class="pii" src="' + esc(a.url) + '"><button class="cm-remove" data-idx="' + i + '" style="position:absolute;top:-4px;right:-4px;width:18px;height:18px;border-radius:50%;background:#e89b9b;color:#fff;border:none;font-size:.7rem;cursor:pointer;line-height:1;display:flex;align-items:center;justify-content:center;z-index:2">×</button></div>';
      else h += '<div class="cm-compose-att"><span class="cm-file-chip"><span class="cm-icon-doc"></span> ' + esc(a.name || '未命名') + '</span><button class="cm-remove" data-idx="' + i + '" style="position:absolute;top:-4px;right:-4px;width:18px;height:18px;border-radius:50%;background:#e89b9b;color:#fff;border:none;font-size:.7rem;cursor:pointer;line-height:1;display:flex;align-items:center;justify-content:center;z-index:2">×</button></div>';
    }
    attBox.innerHTML = h;
    attBox.querySelectorAll('.cm-remove').forEach(function (b) {
      b.onclick = function () {
        var idx = Number(b.getAttribute('data-idx'));
        var list = getAttachmentsArr(composeEl);
        if (idx >= 0 && idx < list.length) {
          list.splice(idx, 1);
          renderAttachments2(composeEl);
        }
      };
    });
  }

  // ---------- 点赞 ----------
  async function doLike(btn) {
    if (!state.user) { openAuthModal('login'); return; }
    var id = btn.getAttribute('data-id');
    var countEl = btn.querySelector('.cm-like-count');
    var path = btn.querySelector('.cm-like-icon path');
    var liked = btn.classList.contains('liked');
    // 乐观更新
    btn.classList.toggle('liked', !liked);
    if (!liked) { path.setAttribute('fill', 'currentColor'); path.setAttribute('stroke', 'none'); }
    else { path.setAttribute('fill', 'none'); path.setAttribute('stroke', 'currentColor'); }
    countEl.textContent = Number(countEl.textContent) + (liked ? -1 : 1);
    try {
      var d = await api('/api/comments/' + id + '/like', { method: 'POST' });
      countEl.textContent = d.count;
      btn.classList.toggle('liked', d.liked);
      if (d.liked) { path.setAttribute('fill', 'currentColor'); path.setAttribute('stroke', 'none'); }
      else { path.setAttribute('fill', 'none'); path.setAttribute('stroke', 'currentColor'); }
      if (window.fetchServerNotifications) window.fetchServerNotifications();
    } catch (e) {
      btn.classList.toggle('liked', liked);
      if (liked) { path.setAttribute('fill', 'currentColor'); path.setAttribute('stroke', 'none'); }
      else { path.setAttribute('fill', 'none'); path.setAttribute('stroke', 'currentColor'); }
      countEl.textContent = Number(countEl.textContent) + (liked ? 1 : -1);
      toast(e.message || '操作失败');
    }
  }

  // ---------- 回复 ----------
  function toggleReply(id, contextEl) {
    if (!state.user) { openAuthModal('login'); return; }
    contextEl = contextEl || state.rootEl;
    // 找到楼层容器
    var replyTarget = contextEl.querySelector('.cm-item[data-id="' + id + '"], .cm-reply[data-id="' + id + '"]');
    if (!replyTarget) { toast('找不到该评论'); return; }
    var floorItem = replyTarget.closest('.cm-item');

    // 移除已有的回复输入框（同一目标则收起，不同目标则替换）
    var existing = contextEl.querySelector('.cm-compose[data-scope="reply"]');
    if (existing) {
      var sameTarget = existing.getAttribute('data-parent') === String(id);
      existing.remove();
      if (sameTarget) return; // 同一目标：仅收起
    }

    // 获取被回复者昵称
    var nickEl = replyTarget.querySelector('.cm-reply-nick, .cm-item-nick');
    var nick = nickEl ? nickEl.textContent.replace('管理员', '').trim() : '';
    var wrap = document.createElement('div');
    wrap.innerHTML = renderCompose('reply', id, '回复 @' + nick + ' …');
    var composeEl = wrap.firstChild;

    if (!floorItem) {
      // 详情页子回复场景：compose 框插入到 .cm-reply 元素之后
      replyTarget.after(composeEl);
    } else {
      // 正常场景：插入到楼层内部末尾
      floorItem.appendChild(composeEl);
    }

    // 直接给 compose 框绑定事件（不依赖 bindEvents，确保详情页内也能正常工作）
    bindComposeEvents(composeEl);

    // 聚焦输入框
    var ta = composeEl.querySelector('textarea');
    if (ta) { try { ta.focus(); } catch (e) {} }
  }

  // 给单个 compose 框绑定发送/附件事件
  function bindComposeEvents(composeEl) {
    if (!composeEl) return;
    var sendBtn = composeEl.querySelector('.cm-send');
    if (sendBtn) {
      sendBtn.onclick = function () {
        sendComment(sendBtn.getAttribute('data-scope'), sendBtn.getAttribute('data-parent') || null);
      };
    }
    var fileInput = composeEl.querySelector('.cm-file-input');
    if (fileInput) {
      fileInput.onchange = function () { handleFileInput(fileInput, composeEl); };
    }
  }

  // ---------- 删除 ----------
  async function doDelete(id) {
    if (!confirm('确定删除这条评论吗？')) return;
    try {
      await api('/api/comments/' + id, { method: 'DELETE' });
      toast('已删除');
      if (document.getElementById('cmDetailOverlay')) { closeDetailOverlay(); return; }
      // 从本地 pending 缓存中移除被删除的评论及其子评论，避免 mergeLocalPending 误判"服务器未返回"而重新插入
      removeLocalPendingById(Number(id));
      // 同步从当前 tree 中立即移除，避免 loadComments 返回前的短暂残留
      removeNodeFromTree(Number(id));
      render();
      loadComments();
      if (window.fetchServerNotifications) window.fetchServerNotifications();
    } catch (e) { toast(e.message || '删除失败'); }
  }

  // 从 state.localPending 中移除指定 id 及其子孙评论
  function removeLocalPendingById(id) {
    if (!state.localPending.length) return;
    // 收集所有应移除的 id（含子孙）
    var toRemove = new Set([id]);
    var changed = true;
    while (changed) {
      changed = false;
      for (var i = 0; i < state.localPending.length; i++) {
        var n = state.localPending[i];
        if (toRemove.has(n.id)) continue;
        if (n.parentId && toRemove.has(n.parentId)) {
          toRemove.add(n.id);
          changed = true;
        }
      }
    }
    state.localPending = state.localPending.filter(function (n) { return !toRemove.has(n.id); });
  }

  // 从 state.tree 中立即移除指定 id 的节点（顶层或回复）
  function removeNodeFromTree(id) {
    for (var i = state.tree.length - 1; i >= 0; i--) {
      var node = state.tree[i];
      if (node.id === id) {
        state.tree.splice(i, 1);
        return;
      }
      if (node._replies && node._replies.length) {
        for (var j = node._replies.length - 1; j >= 0; j--) {
          if (node._replies[j].id === id) {
            node._replies.splice(j, 1);
            return;
          }
        }
      }
    }
  }

  // ---------- 审核 ----------
  async function doModerate(id, action) {
    try {
      await api('/api/admin/comments/' + id + '/' + action, { method: 'POST', body: {} });
      toast(action === 'approve' ? '已通过' : '已拒绝');
      if (document.getElementById('cmDetailOverlay')) { closeDetailOverlay(); return; }
      loadComments();
      if (window.fetchServerNotifications) window.fetchServerNotifications();
    } catch (e) { toast(e.message || '操作失败'); }
  }

  // ---------- 评论详情页（B 站式） ----------
  var detailState = { floor: null, replies: [], page: 0, pageSize: 20 };

  function openReplyDetail(floorId) {
    var id = Number(floorId);
    var node = null;
    // 先在顶层评论中查找
    for (var i = 0; i < state.tree.length; i++) {
      if (state.tree[i].id === id) { node = state.tree[i]; break; }
    }
    // 如果没找到，在所有子回复中查找其所属的顶层评论
    if (!node) {
      for (var j = 0; j < state.tree.length; j++) {
        var replies = state.tree[j]._replies || [];
        for (var k = 0; k < replies.length; k++) {
          if (replies[k].id === id) { node = state.tree[j]; break; }
        }
        if (node) break;
      }
    }
    if (!node) { toast('评论不存在或已加载中'); return; }
    detailState.floor = node;
    detailState.replies = (node._replies || []).slice();
    detailState.page = 1;
    renderDetailOverlay();
  }

  function renderDetailOverlay() {
    closeModals();
    var node = detailState.floor;
    if (!node) return;
    var o = document.createElement('div');
    o.className = 'cm-overlay cm-detail-overlay';
    o.id = 'cmDetailOverlay';
    var h = '<div class="cm-detail-modal">';
    h += '<div class="cm-detail-handle"></div>';
    // 原楼层评论（单条，不含回复区）
    h += '<div class="cm-detail-floor">' + renderFloorSingle(node) + '</div>';
    // 回复列表（分页）
    h += '<div class="cm-detail-replies" id="cmDetailReplies">';
    var shown = detailState.replies.slice(0, detailState.page * detailState.pageSize);
    for (var i = 0; i < shown.length; i++) h += renderReply(shown[i], node.id);
    h += '</div>';
    // 加载更多按钮
    if (detailState.replies.length > detailState.page * detailState.pageSize) {
      h += '<button class="cm-detail-load-more" data-act="load-more">加载更多（剩余 ' + (detailState.replies.length - detailState.page * detailState.pageSize) + ' 条）</button>';
    }
    h += '</div>';
    o.innerHTML = h;
    document.body.appendChild(o);
    bindDetailEvents(o);
  }

  // 渲染单条楼层评论（不含回复区，用于详情页顶部）
  function renderFloorSingle(node) {
    var isPending = node.status === 'pending';
    var h = '<div class="cm-item' + (isPending ? ' pending' : '') + '" data-id="' + node.id + '">';
    h += '<div class="cm-item-row">';
    h += avatarHtml(node.author.avatarKey, node.author.nickname, 'cm-item-avatar');
    h += '<div class="cm-item-main">';
    h += '<div class="cm-item-meta">';
    h += '<span class="cm-item-nick">' + esc(node.author.nickname) + '</span>';
    if (node.author.isAdmin) h += '<span class="cm-admin-badge">管理员</span>';
    if (isPending) h += '<span class="cm-pending-badge">审核中</span>';
    h += '<span class="cm-item-time">' + esc(relTime(node.createdAt)) + '</span>';
    h += '</div>';
    h += '<div class="cm-item-content">' + esc(node.content) + '</div>';
    if (isPending) h += '<div class="cm-pending-hint">审核通过后将对所有人可见</div>';
    h += renderAttachments(node.attachments);
    h += '<div class="cm-item-actions">';
    h += renderLikeButton(node);
    if (state.user) h += '<button class="cm-action" data-act="reply" data-id="' + node.id + '">回复</button>';
    if (state.user && (state.user.id === node.author.id || state.user.isAdmin)) h += '<button class="cm-action" data-act="delete" data-id="' + node.id + '">删除</button>';
    if (state.user && state.user.isAdmin && isPending) {
      h += '<button class="cm-action cm-mod-approve" data-act="approve" data-id="' + node.id + '">通过</button>';
      h += '<button class="cm-action cm-mod-reject" data-act="reject" data-id="' + node.id + '">拒绝</button>';
    }
    h += '</div>';
    h += '</div></div>';
    h += '</div>';
    return h;
  }

  function bindDetailEvents(overlay) {
    // 把手点击关闭（移动端）
    var handle = overlay.querySelector('.cm-detail-handle');
    if (handle) handle.onclick = closeDetailOverlay;
    // ESC 关闭
    var escHandler = function (e) { if (e.key === 'Escape') { closeDetailOverlay(); document.removeEventListener('keydown', escHandler); } };
    document.addEventListener('keydown', escHandler);
    // 点击遮罩关闭
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) closeDetailOverlay();
    });
    // 阻止滚轮事件穿透到背景，且在回复区滚到顶/底时不再触发背景滚动
    overlay.addEventListener('wheel', function (e) {
      var replies = overlay.querySelector('.cm-detail-replies');
      if (!replies) return;
      var atTop = replies.scrollTop <= 0;
      var atBottom = replies.scrollTop + replies.clientHeight >= replies.scrollHeight - 1;
      if ((e.deltaY < 0 && atTop) || (e.deltaY > 0 && atBottom)) {
        e.preventDefault();
      }
    }, { passive: false });
    // 阻止触摸滑动穿透到背景（移动端）
    overlay.addEventListener('touchmove', function (e) {
      if (e.target.closest('.cm-detail-replies')) return; // 回复区内允许滚动
      e.preventDefault();
    }, { passive: false });
    // 锁定背景滚动
    document.body.style.overflow = 'hidden';
    // 绑定楼层和回复的 like/reply/delete/approve/reject/load-more 按钮
    bindDetailActions(overlay);
  }

  function closeDetailOverlay() {
    var o = document.getElementById('cmDetailOverlay');
    if (o) o.remove();
    detailState.floor = null;
    detailState.replies = [];
    detailState.page = 0;
    // 恢复背景滚动
    document.body.style.overflow = '';
    // 关闭后刷新原评论区，反映详情页内的改动
    loadComments();
  }

  // ---------- 登录/注册弹窗（简洁版） ----------
  function openAuthModal(mode) {
    closeModals();
    var isLogin = mode === 'login';
    var o = document.createElement('div');
    o.className = 'cm-overlay';
    o.innerHTML =
      '<div class="cm-modal auth-modal">' +
      '<button class="cm-auth-close" data-act="close">×</button>' +
      '<div class="cm-auth-title">' + (isLogin ? '登录' : '注册') + '</div>' +
      '<div class="cm-auth-body">' +
        '<div class="cm-auth-field"><input type="email" id="cmEmail" placeholder="邮箱地址" autocomplete="email"></div>' +
        '<div class="cm-auth-field"><input type="password" id="cmPwd" placeholder="密码（6-64位）" autocomplete="' + (isLogin ? 'current-password' : 'new-password') + '"></div>' +
        (isLogin ? '' : '<div class="cm-auth-field"><input type="text" id="cmNick" placeholder="昵称（1-24字符）" maxlength="24"></div>') +
        '<div class="cm-msg" id="cmMsg"></div>' +
        '<button class="cm-auth-submit" id="cmSubmit">' + (isLogin ? '登录' : '注册') + '</button>' +
        '<div class="cm-auth-switch">' + (isLogin ? '没有账号？<a id="cmSwitch">去注册</a>' : '已有账号？<a id="cmSwitch">去登录</a>') + '</div>' +
      '</div>' +
      '</div>';
    document.body.appendChild(o);
    o.querySelector('[data-act="close"]').onclick = closeModals;
    o.addEventListener('click', function (e) { if (e.target === o) closeModals(); });
    o.querySelector('#cmSwitch').onclick = function () { openAuthModal(isLogin ? 'register' : 'login'); };
    o.querySelector('#cmSubmit').onclick = function () { submitAuth(o, isLogin); };
    o.querySelector('#cmPwd').addEventListener('keydown', function (e) { if (e.key === 'Enter') submitAuth(o, isLogin); });
    setTimeout(function () { o.querySelector('#cmEmail').focus(); }, 50);
  }

  async function submitAuth(o, isLogin) {
    var email = o.querySelector('#cmEmail').value.trim();
    var pwd = o.querySelector('#cmPwd').value;
    var msg = o.querySelector('#cmMsg');
    msg.className = 'cm-msg'; msg.textContent = '';
    var btn = o.querySelector('#cmSubmit');
    btn.disabled = true; btn.textContent = '处理中…';
    try {
      if (isLogin) {
        var loginRes = await api('/api/auth/login', { method: 'POST', body: { email: email, password: pwd } });
        // 登录接口已返回用户信息，立即更新状态，避免再次请求 /api/auth/me 时 Cookie 可能未生效
        state.user = loginRes.user || null;
        closeModals();
        toast('登录成功');
        loadComments();
        syncUserToMenu(state.user);
      } else {
        var nick = o.querySelector('#cmNick').value.trim();
        var d = await api('/api/auth/register', { method: 'POST', body: { email: email, password: pwd, nickname: nick } });
        if (d.verify_sent === 'degraded') {
          msg.className = 'cm-msg ok';
          msg.textContent = '注册成功！邮件功能未配置，请联系管理员获取验证链接。';
        } else if (d.verify_sent) {
          msg.className = 'cm-msg ok';
          msg.textContent = '注册成功！验证邮件已发送，请在5分钟内前往邮箱查收。';
        } else {
          msg.className = 'cm-msg err';
          msg.textContent = '注册成功，但验证邮件发送失败：' + (d.mail_error || '未知错误');
        }
        btn.disabled = false; btn.textContent = '注册';
        return;
      }
    } catch (e) {
      msg.className = 'cm-msg err';
      msg.textContent = e.message || '操作失败';
      btn.disabled = false; btn.textContent = isLogin ? '登录' : '注册';
    }
  }

  // ---------- 资料编辑弹窗 ----------
  function openProfileModal() {
    closeModals();
    var u = state.user || {};
    var o = document.createElement('div');
    o.className = 'cm-overlay';
    o.innerHTML =
      '<div class="cm-modal profile-modal">' +
      '<button class="cm-modal-x" data-act="close">×</button>' +
      '<div class="cm-modal-head"><span>个人资料</span></div>' +
      '<div class="cm-modal-body">' +
        '<div class="cm-profile-head">' +
          '<div class="cm-profile-avatar-wrap">' + avatarHtml(u.avatarKey, u.nickname, 'cm-profile-avatar') + '</div>' +
          '<div class="cm-profile-info">' +
            '<div class="cm-profile-nick">' + esc(u.nickname || '') + '</div>' +
            '<div class="cm-profile-email">' + esc(u.email) + '</div>' +
            '<div class="cm-profile-tags">' +
              (u.isAdmin ? '<span class="cm-tag cm-tag-admin">管理员</span>' : '') +
              (u.isVerified ? '<span class="cm-tag cm-tag-verified">已验证</span>' : '<span class="cm-tag cm-tag-unverified">未验证</span>') +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="cm-profile-section">' +
          '<div class="cm-profile-label">昵称</div>' +
          '<input type="text" class="cm-profile-input" id="cmNick2" value="' + esc(u.nickname || '') + '" maxlength="24" placeholder="1-24 字符">' +
        '</div>' +
        '<div class="cm-profile-section">' +
          '<div class="cm-profile-label">更换头像</div>' +
          '<label class="cm-profile-upload" for="cmAvatarFile"><span class="cm-icon-paperclip"></span>选择图片（≤2MB）<input type="file" id="cmAvatarFile" accept="image/jpeg,image/png,image/webp,image/gif" style="display:none"></label>' +
          '<div class="cm-profile-upload-hint">支持 JPG / PNG / WEBP / GIF</div>' +
        '</div>' +
        '<div class="cm-msg" id="cmMsg"></div>' +
      '</div>' +
      '<div class="cm-modal-foot">' +
        '<button class="cm-btn danger" id="cmLogout">退出登录</button>' +
        '<button class="cm-btn primary" id="cmSave">保存修改</button>' +
      '</div>' +
      '</div>';
    document.body.appendChild(o);
    o.querySelector('[data-act="close"]').onclick = closeModals;
    o.addEventListener('click', function (e) { if (e.target === o) closeModals(); });
    o.querySelector('#cmLogout').onclick = async function () {
      try { await api('/api/auth/logout', { method: 'POST' }); } catch (e) {}
      state.user = null;
      syncUserToMenu(null);
      closeModals();
      toast('已退出登录');
      loadComments();
    };
    o.querySelector('#cmSave').onclick = async function () {
      var nick = o.querySelector('#cmNick2').value.trim();
      var msg = o.querySelector('#cmMsg');
      msg.className = 'cm-msg'; msg.textContent = '';
      if (nick && (nick.length < 1 || nick.length > 24)) {
        msg.className = 'cm-msg err'; msg.textContent = '昵称需 1-24 字符';
        return;
      }
      var saveBtn = o.querySelector('#cmSave');
      saveBtn.disabled = true;
      saveBtn.textContent = '保存中…';
      try {
        var patch = {};
        if (nick && nick !== u.nickname) patch.nickname = nick;
        var fileInput = o.querySelector('#cmAvatarFile');
        if (fileInput.files[0]) {
          var fd = new FormData(); fd.append('file', fileInput.files[0]);
          var up = await api('/api/uploads/avatar', { method: 'POST', body: fd });
          patch.avatarKey = up.key;
        }
        if (Object.keys(patch).length) {
          var d = await api('/api/auth/me', { method: 'PATCH', body: patch });
          state.user = d.user;
          syncUserToMenu(state.user);
        }
        msg.className = 'cm-msg ok'; msg.textContent = '已保存';
        setTimeout(function () { closeModals(); loadComments(); }, 600);
      } catch (e) {
        msg.className = 'cm-msg err';
        msg.textContent = e.message || '保存失败';
        saveBtn.disabled = false;
        saveBtn.textContent = '保存修改';
      }
    };
  }

  function closeModals() {
    document.querySelectorAll('.cm-overlay').forEach(function (e) { e.remove(); });
  }

  // 管理员：待审核列表弹窗
  function openPendingModal() {
    closeModals();
    var ov = document.createElement('div');
    ov.className = 'cm-overlay';
    ov.innerHTML =
      '<div class="cm-modal pending-modal" role="dialog" aria-label="待审核评论">' +
      '<div class="cm-modal-head"><span>待审核评论</span><button class="cm-modal-x" data-act="close">×</button></div>' +
      '<div class="cm-modal-body"><div class="cm-loading"><span class="cm-spin"></span>加载中…</div></div>' +
      '</div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', function (e) { if (e.target === ov) closeModals(); });
    ov.querySelector('[data-act="close"]').onclick = closeModals;

    api('/api/admin/comments/pending').then(function (d) {
      var list = d.comments || d.list || d || [];
      var body = ov.querySelector('.cm-modal-body');
      if (!list.length) { body.innerHTML = '<div class="cm-empty">暂无待审核评论</div>'; return; }
      var h = '<div class="cm-pending-list">';
      list.forEach(function (c) {
        h += '<div class="cm-pending-card" data-id="' + c.id + '">';
        h += '<div class="cm-pending-meta">';
        h += avatarHtml(c.author && c.author.avatarKey, c.author && c.author.nickname, 'cm-pending-avatar');
        h += '<span class="cm-nick">' + esc(c.author && c.author.nickname) + '</span>';
        h += '<span class="cm-item-time">' + esc(relTime(c.createdAt)) + '</span>';
        h += '<span class="cm-pending-rid">帖子 #' + esc(String(c.rid)) + '</span>';
        h += '</div>';
        h += '<div class="cm-pending-content">' + esc(c.content) + '</div>';
        if (c.attachments && c.attachments.length) {
          h += '<div class="cm-pending-attachments">' + renderAttachments(c.attachments) + '</div>';
        }
        h += '<div class="cm-pending-actions">';
        h += '<button class="cm-btn sm" data-mod="view" data-rid="' + esc(String(c.rid)) + '">查看帖子</button>';
        h += '<button class="cm-btn sm primary" data-mod="approve" data-id="' + c.id + '">通过</button>';
        h += '<button class="cm-btn sm danger" data-mod="reject" data-id="' + c.id + '">拒绝</button>';
        h += '</div>';
        h += '</div>';
      });
      h += '</div>';
      body.innerHTML = h;
      body.querySelectorAll('[data-mod]').forEach(function (btn) {
        var act = btn.getAttribute('data-mod');
        if (act === 'view') {
          btn.onclick = function () {
            var rid = btn.getAttribute('data-rid');
            closeModals();
            if (typeof window._openModByRid === 'function') window._openModByRid(rid);
            else window.location.href = '/?rid=' + encodeURIComponent(rid);
          };
          return;
        }
        var id = btn.getAttribute('data-id');
        btn.onclick = async function () {
          btn.disabled = true;
          btn.textContent = '处理中…';
          try {
            await api('/api/admin/comments/' + id + '/' + act, { method: 'POST', body: {} });
            var card = body.querySelector('.cm-pending-card[data-id="' + id + '"]');
            if (card) card.remove();
            if (!body.querySelector('.cm-pending-card')) body.innerHTML = '<div class="cm-empty">已全部审核完</div>';
            toast(act === 'approve' ? '已通过' : '已拒绝');
            loadComments();
          } catch (e) {
            btn.disabled = false;
            btn.textContent = act === 'approve' ? '通过' : '拒绝';
            toast(e.message || '操作失败');
          }
        };
      });
      // 绑定附件事件（图片预览 + 文件下载）
      body.querySelectorAll('.cm-att.file').forEach(function (el) {
        el.onclick = function () {
          var url = el.getAttribute('data-url');
          var name = el.getAttribute('data-name') || 'download';
          var a = document.createElement('a');
          a.href = url;
          a.download = name;
          a.target = '_blank';
          document.body.appendChild(a);
          a.click();
          a.remove();
        };
      });
    }).catch(function (e) {
      ov.querySelector('.cm-modal-body').innerHTML = '<div class="cm-empty">加载失败: ' + esc(e.message || '') + '</div>';
    });
  }

  // 管理员：用户管理弹窗
  function openUserMgmtModal() {
    closeModals();
    var ov = document.createElement('div');
    ov.className = 'cm-overlay';
    ov.innerHTML =
      '<div class="cm-modal pending-modal" role="dialog" aria-label="用户管理">' +
      '<div class="cm-modal-head"><span>用户管理</span><button class="cm-modal-x" data-act="close">×</button></div>' +
      '<div class="cm-modal-body"><div class="cm-loading"><span class="cm-spin"></span>加载中…</div></div>' +
      '</div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', function (e) { if (e.target === ov) closeModals(); });
    ov.querySelector('[data-act="close"]').onclick = closeModals;

    function loadUsers(q) {
      var url = '/api/admin/users';
      if (q) url += '?q=' + encodeURIComponent(q);
      api(url).then(function (d) {
        var list = d.list || [];
        var body = ov.querySelector('.cm-modal-body');
        var h = '<div class="cm-user-search"><input type="text" placeholder="搜索昵称或邮箱…" value="' + esc(q || '') + '" id="userSearchInput"><button class="cm-btn sm" id="userSearchBtn">搜索</button></div>';
        if (!list.length) { h += '<div class="cm-empty">暂无用户</div>'; body.innerHTML = h; bindSearch(body); return; }
        h += '<div class="cm-pending-list">';
        list.forEach(function (u) {
          var muted = u.mutedUntil && new Date(u.mutedUntil) > new Date();
          h += '<div class="cm-pending-card" data-uid="' + u.id + '">';
          h += '<div class="cm-pending-meta">';
          h += avatarHtml(u.avatarKey, u.nickname, 'cm-pending-avatar');
          h += '<span class="cm-nick">' + esc(u.nickname) + (u.isAdmin ? ' <span class="cm-admin-badge">管理员</span>' : '') + '</span>';
          h += '<span class="cm-item-time">' + esc(u.email) + '</span>';
          if (muted) h += '<span class="cm-pending-badge">禁言中</span>';
          h += '</div>';
          h += '<div class="cm-pending-content" style="font-size:.76rem;color:var(--tm)">注册: ' + esc(relTime(u.createdAt)) + (u.lastLoginAt ? ' · 最后登录: ' + esc(relTime(u.lastLoginAt)) : '') + '</div>';
          h += '<div class="cm-pending-actions">';
          h += '<button class="cm-btn sm" data-um="avatar" data-uid="' + u.id + '" data-avatar="' + esc(u.avatarKey || '') + '">改头像</button>';
          if (u.avatarKey) h += '<button class="cm-btn sm danger" data-um="del-avatar" data-uid="' + u.id + '">删头像</button>';
          h += '<button class="cm-btn sm" data-um="nick" data-uid="' + u.id + '" data-nick="' + esc(u.nickname) + '">改昵称</button>';
          if (u.isAdmin) {
            h += '<span style="font-size:.76rem;color:var(--tm)">管理员不可禁言</span>';
          } else if (muted) {
            h += '<button class="cm-btn sm" data-um="unmute" data-uid="' + u.id + '">解除禁言</button>';
          } else {
            h += '<button class="cm-btn sm danger" data-um="mute" data-uid="' + u.id + '">禁言</button>';
          }
          h += '</div>';
          h += '</div>';
        });
        h += '</div>';
        body.innerHTML = h;
        bindSearch(body);
        body.querySelectorAll('[data-um]').forEach(function (btn) {
          var act = btn.getAttribute('data-um');
          var uid = btn.getAttribute('data-uid');
          btn.onclick = async function () {
            if (act === 'nick') {
              var nick = prompt('输入新昵称（1-24字符）', btn.getAttribute('data-nick'));
              if (nick === null) return;
              nick = nick.trim();
              if (!nick || nick.length > 24) { toast('昵称需 1-24 字符'); return; }
              try {
                await api('/api/admin/users/' + uid, { method: 'PATCH', body: { nickname: nick } });
                toast('昵称已修改');
                loadUsers(ov.querySelector('#userSearchInput').value);
              } catch (e) { toast(e.message || '修改失败'); }
            } else if (act === 'avatar') {
              var input = document.createElement('input');
              input.type = 'file'; input.accept = 'image/*';
              input.onchange = async function () {
                if (!input.files[0]) return;
                try {
                  var fd = new FormData(); fd.append('file', input.files[0]);
                  var up = await api('/api/uploads/avatar', { method: 'POST', body: fd });
                  await api('/api/admin/users/' + uid, { method: 'PATCH', body: { avatarKey: up.key } });
                  toast('头像已修改');
                  loadUsers(ov.querySelector('#userSearchInput').value);
                } catch (e) { toast(e.message || '头像修改失败'); }
              };
              input.click();
            } else if (act === 'del-avatar') {
              if (!confirm('确认删除该用户头像？')) return;
              try {
                await api('/api/admin/users/' + uid, { method: 'PATCH', body: { avatarKey: '' } });
                toast('头像已删除');
                loadUsers(ov.querySelector('#userSearchInput').value);
              } catch (e) { toast(e.message || '删除失败'); }
            } else if (act === 'mute') {
              var minutes = prompt('禁言时长（分钟，1-43200）', '60');
              if (minutes === null) return;
              minutes = Number(minutes);
              if (!minutes || minutes < 1 || minutes > 43200) { toast('时长需 1-43200 分钟'); return; }
              try {
                await api('/api/admin/users/' + uid + '/mute', { method: 'POST', body: { minutes: minutes } });
                toast('已禁言');
                loadUsers(ov.querySelector('#userSearchInput').value);
              } catch (e) { toast(e.message || '操作失败'); }
            } else if (act === 'unmute') {
              try {
                await api('/api/admin/users/' + uid + '/unmute', { method: 'POST', body: {} });
                toast('已解除禁言');
                loadUsers(ov.querySelector('#userSearchInput').value);
              } catch (e) { toast(e.message || '操作失败'); }
            }
          };
        });
      }).catch(function (e) {
        ov.querySelector('.cm-modal-body').innerHTML = '<div class="cm-empty">加载失败: ' + esc(e.message || '') + '</div>';
      });
    }

    function bindSearch(body) {
      var input = body.querySelector('#userSearchInput');
      var btn = body.querySelector('#userSearchBtn');
      if (btn) btn.onclick = function () { loadUsers(input.value.trim()); };
      if (input) input.onkeydown = function (e) { if (e.key === 'Enter') loadUsers(input.value.trim()); };
    }

    loadUsers('');
  }

  // 管理员：评论管理弹窗
  function openCommentMgmtModal() {
    closeModals();
    var ov = document.createElement('div');
    ov.className = 'cm-overlay';
    ov.innerHTML =
      '<div class="cm-modal pending-modal" role="dialog" aria-label="评论管理">' +
      '<div class="cm-modal-head"><span>评论管理</span><button class="cm-modal-x" data-act="close">×</button></div>' +
      '<div class="cm-modal-body"><div class="cm-loading"><span class="cm-spin"></span>加载中…</div></div>' +
      '</div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', function (e) { if (e.target === ov) closeModals(); });
    ov.querySelector('[data-act="close"]').onclick = closeModals;

    // 内部状态（默认按当前帖子 rid 筛选）
    var mgmtState = { rid: state.rid || '', q: '', page: 1, size: 20, total: 0, list: [] };

    // 拉取评论列表
    function loadList() {
      var body = ov.querySelector('.cm-modal-body');
      body.innerHTML = '<div class="cm-loading"><span class="cm-spin"></span>加载中…</div>';
      var url = '/api/admin/comments?page=' + mgmtState.page + '&size=' + mgmtState.size;
      if (mgmtState.rid) url += '&rid=' + encodeURIComponent(mgmtState.rid);
      if (mgmtState.q) url += '&q=' + encodeURIComponent(mgmtState.q);
      api(url).then(function (d) {
        mgmtState.list = d.list || [];
        mgmtState.total = d.total || 0;
        renderList();
      }).catch(function (e) {
        body.innerHTML = '<div class="cm-empty">加载失败: ' + esc(e.message || '') + '</div>';
      });
    }

    // 渲染整个列表区（含工具栏、列表、分页）
    function renderList() {
      var body = ov.querySelector('.cm-modal-body');
      var totalPages = Math.max(1, Math.ceil(mgmtState.total / mgmtState.size));
      var h = '';
      // 顶部工具栏
      h += '<div class="cm-comment-mgmt-toolbar">';
      // 当前帖子 / 全站帖子 tab
      var currentRid = state.rid || '';
      var isCurrent = mgmtState.rid && mgmtState.rid === currentRid;
      h += '<div class="cm-mgmt-scope-tabs">';
      h += '<button class="cm-btn sm' + (isCurrent ? ' primary' : '') + '" data-scope="current"' + (!currentRid ? ' disabled' : '') + '>当前帖子</button>';
      h += '<button class="cm-btn sm' + (!isCurrent ? ' primary' : '') + '" data-scope="all">全站帖子</button>';
      h += '</div>';
      h += '<input type="text" id="cmMgmtRid" placeholder="按 rid 筛选" value="' + esc(mgmtState.rid) + '" style="flex:1 1 100px;min-width:80px">';
      h += '<input type="text" id="cmMgmtQ" placeholder="搜索内容/用户名" value="' + esc(mgmtState.q) + '">';
      h += '<button class="cm-btn sm" id="cmMgmtSearch">搜索</button>';
      h += '<label class="cm-mgmt-selectall"><input type="checkbox" id="cmMgmtSelectAll" class="cm-mgmt-check">全选</label>';
      h += '<button class="cm-btn sm danger" id="cmMgmtBatchDel">批量删除</button>';
      h += '</div>';
      // 列表
      if (!mgmtState.list.length) {
        h += '<div class="cm-empty">暂无评论</div>';
      } else {
        h += '<div class="cm-comment-mgmt-list">';
        for (var i = 0; i < mgmtState.list.length; i++) h += renderCard(mgmtState.list[i]);
        h += '</div>';
      }
      // 分页
      h += '<div class="cm-comment-mgmt-pager">';
      h += '<button class="cm-btn sm" id="cmMgmtPrev"' + (mgmtState.page <= 1 ? ' disabled' : '') + '>上一页</button>';
      h += '<span class="cm-mgmt-page-info">第 ' + mgmtState.page + ' 页 / 共 ' + totalPages + ' 页 (总 ' + mgmtState.total + ' 条)</span>';
      h += '<button class="cm-btn sm" id="cmMgmtNext"' + (mgmtState.page >= totalPages ? ' disabled' : '') + '>下一页</button>';
      h += '</div>';
      body.innerHTML = h;
      bindActions();
    }

    // 渲染单条评论卡片
    function renderCard(c) {
      var author = c.author || {};
      var h = '<div class="cm-comment-mgmt-card' + (c.pinned ? ' pinned' : '') + '" data-id="' + c.id + '">';
      h += '<input type="checkbox" class="cm-mgmt-check cm-mgmt-item-check" data-id="' + c.id + '">';
      h += '<div class="cm-mgmt-card-main">';
      h += '<div class="cm-pending-meta">';
      h += avatarHtml(author.avatarKey, author.nickname, 'cm-pending-avatar');
      h += '<span class="cm-nick">' + esc(author.nickname) + (author.isAdmin ? ' <span class="cm-admin-badge">管理员</span>' : '') + '</span>';
      h += '<span class="cm-item-time">' + esc(relTime(c.createdAt)) + '</span>';
      h += '<a class="cm-pending-rid cm-mgmt-rid-link" data-mgmt-rid="' + esc(String(c.rid)) + '" data-mgmt-cid="' + c.id + '">帖子 #' + esc(String(c.rid)) + '</a>';
      if (c.status === 'rejected') h += '<span class="cm-pending-badge" style="background:#e89b9b;color:#fff">已拒绝</span>';
      if (c.status === 'pending') h += '<span class="cm-pending-badge">待审核</span>';
      if (c.pinned) h += '<span class="cm-pinned-badge">置顶</span>';
      h += '</div>';
      h += '<div class="cm-pending-content">' + esc(c.content) + '</div>';
      if (c.attachments && c.attachments.length) {
        h += '<div class="cm-pending-attachments">' + renderAttachments(c.attachments) + '</div>';
      }
      h += '<div class="cm-mgmt-actions">';
      h += '<button class="cm-btn sm" data-mgmt="edit" data-id="' + c.id + '">编辑</button>';
      h += '<button class="cm-btn sm danger" data-mgmt="delete" data-id="' + c.id + '">删除</button>';
      h += '</div>';
      h += '</div>';
      h += '</div>';
      return h;
    }

    // 绑定工具栏、分页、单条操作事件
    function bindActions() {
      var body = ov.querySelector('.cm-modal-body');
      // 搜索按钮
      var ridInput = body.querySelector('#cmMgmtRid');
      var qInput = body.querySelector('#cmMgmtQ');
      var searchBtn = body.querySelector('#cmMgmtSearch');
      if (searchBtn) searchBtn.onclick = function () {
        mgmtState.rid = (ridInput.value || '').trim();
        mgmtState.q = (qInput.value || '').trim();
        mgmtState.page = 1;
        loadList();
      };
      if (qInput) qInput.onkeydown = function (e) { if (e.key === 'Enter') searchBtn.click(); };
      if (ridInput) ridInput.onkeydown = function (e) { if (e.key === 'Enter') searchBtn.click(); };
      // rid 输入框实时更新 scope tab 高亮
      if (ridInput) ridInput.oninput = function () {
        var val = (ridInput.value || '').trim();
        var curRid = state.rid || '';
        body.querySelectorAll('[data-scope]').forEach(function (btn) {
          var scope = btn.getAttribute('data-scope');
          if (scope === 'current') btn.className = 'cm-btn sm' + (val && val === curRid ? ' primary' : '');
          else btn.className = 'cm-btn sm' + (!val || val !== curRid ? ' primary' : '');
        });
      };
      // scope tab 切换
      body.querySelectorAll('[data-scope]').forEach(function (btn) {
        btn.onclick = function () {
          var scope = btn.getAttribute('data-scope');
          if (scope === 'current') {
            mgmtState.rid = state.rid || '';
            if (ridInput) ridInput.value = mgmtState.rid;
          } else {
            mgmtState.rid = '';
            if (ridInput) ridInput.value = '';
          }
          mgmtState.page = 1;
          loadList();
        };
      });
      // 帖子跳转链接：关闭弹窗，定位到指定评论
      body.querySelectorAll('.cm-mgmt-rid-link').forEach(function (link) {
        link.onclick = function (e) {
          e.preventDefault();
          var rid = link.getAttribute('data-mgmt-rid');
          var cid = Number(link.getAttribute('data-mgmt-cid'));
          // 关闭管理弹窗
          ov.remove();
          // 调用 main.js 的全局跳转定位函数
          if (window._openModByRid) {
            window._openModByRid(rid, cid);
          } else {
            // 回退：直接跳转页面
            window.location.href = '/?rid=' + encodeURIComponent(rid) + '&commentId=' + cid;
          }
        };
      });
      // 全选
      var selectAll = body.querySelector('#cmMgmtSelectAll');
      if (selectAll) selectAll.onclick = function () {
        var checked = selectAll.checked;
        body.querySelectorAll('.cm-mgmt-item-check').forEach(function (cb) { cb.checked = checked; });
      };
      // 批量删除
      var batchDel = body.querySelector('#cmMgmtBatchDel');
      if (batchDel) batchDel.onclick = async function () {
        var ids = [];
        body.querySelectorAll('.cm-mgmt-item-check:checked').forEach(function (cb) {
          ids.push(Number(cb.getAttribute('data-id')));
        });
        if (!ids.length) { toast('请先选择要删除的评论'); return; }
        if (!confirm('确定删除选中的 ' + ids.length + ' 条评论吗？')) return;
        batchDel.disabled = true;
        batchDel.textContent = '删除中…';
        try {
          await api('/api/admin/comments/batch-delete', { method: 'POST', body: { ids: ids } });
          toast('已批量删除');
          // 删除后若当前页已空，回到上一页
          var remaining = mgmtState.total - ids.length;
          var maxPage = Math.max(1, Math.ceil(remaining / mgmtState.size));
          if (mgmtState.page > maxPage) mgmtState.page = maxPage;
          loadList();
          loadComments();
        } catch (e) {
          batchDel.disabled = false;
          batchDel.textContent = '批量删除';
          toast(e.message || '操作失败');
        }
      };
      // 分页
      var prevBtn = body.querySelector('#cmMgmtPrev');
      var nextBtn = body.querySelector('#cmMgmtNext');
      if (prevBtn) prevBtn.onclick = function () {
        if (mgmtState.page > 1) { mgmtState.page--; loadList(); }
      };
      if (nextBtn) nextBtn.onclick = function () {
        var totalPages = Math.max(1, Math.ceil(mgmtState.total / mgmtState.size));
        if (mgmtState.page < totalPages) { mgmtState.page++; loadList(); }
      };
      // 单条操作
      body.querySelectorAll('[data-mgmt]').forEach(function (btn) {
        var act = btn.getAttribute('data-mgmt');
        var id = btn.getAttribute('data-id');
        if (act === 'edit') {
          btn.onclick = async function () {
            // 取当前卡片显示的评论内容作为默认值
            var card = body.querySelector('.cm-comment-mgmt-card[data-id="' + id + '"]');
            var contentEl = card ? card.querySelector('.cm-pending-content') : null;
            var oldContent = contentEl ? contentEl.textContent : '';
            var newContent = prompt('编辑评论内容', oldContent);
            if (newContent === null) return;
            newContent = newContent.trim();
            if (!newContent) { toast('内容不能为空'); return; }
            btn.disabled = true;
            btn.textContent = '处理中…';
            try {
              await api('/api/admin/comments/' + id + '/edit', { method: 'POST', body: { content: newContent } });
              toast('已编辑');
              if (contentEl) contentEl.textContent = newContent;
              btn.disabled = false;
              btn.textContent = '编辑';
            } catch (e) {
              btn.disabled = false;
              btn.textContent = '编辑';
              toast(e.message || '操作失败');
            }
          };
        } else if (act === 'delete') {
          btn.onclick = async function () {
            if (!confirm('确定删除这条评论吗？')) return;
            btn.disabled = true;
            btn.textContent = '删除中…';
            try {
              await api('/api/admin/comments/' + id, { method: 'DELETE' });
              toast('已删除');
              // 删除后若当前页已空，回到上一页
              var remaining = mgmtState.total - 1;
              var maxPage = Math.max(1, Math.ceil(remaining / mgmtState.size));
              if (mgmtState.page > maxPage) mgmtState.page = maxPage;
              loadList();
              loadComments();
            } catch (e) {
              btn.disabled = false;
              btn.textContent = '删除';
              toast(e.message || '操作失败');
            }
          };
        }
      });
      // 附件下载（复用主站文件下载逻辑）
      body.querySelectorAll('.cm-att.file').forEach(function (el) {
        el.onclick = function () {
          var url = el.getAttribute('data-url');
          var name = el.getAttribute('data-name') || 'download';
          var a = document.createElement('a');
          a.href = url;
          a.download = name;
          a.target = '_blank';
          document.body.appendChild(a);
          a.click();
          a.remove();
        };
      });
    }

    loadList();
  }

  // ---------- 挂载 ----------
  function mount(rootEl, rid) {
    // 切换 rid 时清空旧评论树，防止跨帖子串显示
    if (state.mountedRid && state.mountedRid !== rid) {
      state.tree = [];
      state.localPending = [];
      if (state.rootEl) state.rootEl.innerHTML = '';
    }
    state.rootEl = rootEl;
    state.rid = rid;
    state.mountedRid = rid;
    state.composeAtt = [];
    rootEl.innerHTML = '<div class="cm-loading"><span class="cm-spin"></span>加载中…</div>';
    loadUser().then(function () { loadComments(); });
  }

  function tryMount() {
    var mO = document.getElementById('mO');
    var mC = document.getElementById('mC');
    if (!mO || !mC) return;
    var isModalOpen = mO.classList.contains('act');
    // 仅在弹窗从关闭→打开的跳变时刷新，避免 setInterval(tryMount,800) 重复触发刷新
    var justOpened = isModalOpen && !state.lastModalOpen;
    state.lastModalOpen = isModalOpen;
    if (!isModalOpen) return;
    if (!window._cm || !window._cm.rid) return;
    var existing = document.getElementById('cmRoot');
    if (existing) {
      // 已挂载过
      if (state.mountedRid && String(window._cm.rid) !== String(state.mountedRid)) {
        // 切换到不同帖子，移除旧 cmRoot 重新挂载
        existing.remove();
        state.mountedRid = null;
      } else {
        // 再次进入同一帖子：仅在弹窗刚打开时刷新，避免停留期间重复刷新
        if (justOpened && state.rootEl && state.rootEl.isConnected) loadComments();
        return;
      }
    }
    if (!mC.children.length) return;
    var root = document.createElement('div');
    root.id = 'cmRoot';
    root.className = 'cm-root';
    mC.appendChild(root);
    mount(root, String(window._cm.rid));
  }

  function init() {
    var mO = document.getElementById('mO');
    var mC = document.getElementById('mC');
    if (!mO || !mC) { setTimeout(init, 500); return; }
    var obs = new MutationObserver(function () { tryMount(); });
    obs.observe(mO, { attributes: true, attributeFilter: ['class'] });
    obs.observe(mC, { childList: true });
    tryMount();
  }

  window._cmOpenAuth = openAuthModal;
  window._cmOpenProfile = openProfileModal;
  window._openReplyDetail = openReplyDetail;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
