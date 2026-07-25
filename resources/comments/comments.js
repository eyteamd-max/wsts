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
      var f = files[i];
      var item = document.createElement('div');
      item.className = 'cm-upload-progress';
      item.innerHTML = '<div class="cm-upload-name">' + esc(f.name) + '</div>' +
        '<div class="cm-upload-bar-wrap"><div class="cm-upload-bar" style="width:0%"></div></div>' +
        '<div class="cm-upload-percent">0%</div>';
      attBox.appendChild(item);
      progressItems.push({ file: f, el: item });
    }
    if (!progressItems.length) { toast('最多上传 ' + MAX_ATTACH + ' 个附件'); return; }
    var successCount = 0;
    for (var j = 0; j < progressItems.length; j++) {
      var pi = progressItems[j];
      try {
        var d = await uploadFileWithProgress(pi.file, function (loaded, total, percent) {
          var bar = pi.el.querySelector('.cm-upload-bar');
          var pct = pi.el.querySelector('.cm-upload-percent');
          if (bar) bar.style.width = percent + '%';
          if (pct) pct.textContent = percent + '%';
        });
        pi.el.querySelector('.cm-upload-bar').style.width = '100%';
        pi.el.querySelector('.cm-upload-percent').textContent = '100%';
        arr.push(d);
        successCount++;
        pi.el.remove();
      } catch (e) {
        pi.el.classList.add('error');
        pi.el.querySelector('.cm-upload-percent').textContent = e.message || '失败';
        (function (item) { setTimeout(function () { item.remove(); }, 2000); })(pi.el);
      }
    }
    renderAttachments2(composeEl);
    if (successCount > 0) {
      toast('上传成功 ' + successCount + ' 个附件');
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