// 图片渲染、图片批量渲染与对比视图

// ---------------------------------------------------------------- image render
let imgPickPath = null;      // 选中的磁盘图片
let imgRenderedAbs = null;   // 上一次渲染结果的服务端绝对路径（用于保存）

// 通用分隔线驱动：渲染层用 clip-path 从左侧露出，分界线跟着移动。
// 内联对比（#imgBox）与全屏弹层（#imgModalBox）共用这段逻辑，保证两者完全同步。
function setBoxSplit(layerEl, dividerEl, p) {
  const pct = (p * 100).toFixed(2);
  layerEl.style.clipPath = `inset(0 0 0 ${pct}%)`;
  dividerEl.style.left = pct + '%';
}
function setImgSplit(p) { setBoxSplit($('imgRenderLayer'), $('imgDivider'), p); }
function setModalImgSplit(p) { setBoxSplit($('imgModalRenderLayer'), $('imgModalDivider'), p); }

// 指针拖动 + 键盘可调（原来只有 mousemove，且鼠标移开就弹回 50%）
if (window.uiBindSplit) {
  window.uiBindSplit($('imgStage'), setImgSplit);
  window.uiBindSplit($('imgModalStage'), setModalImgSplit);
} else {
  setImgSplit(0.5);
  setModalImgSplit(0.5);
}

// ---------------------------------------------------------------- fullscreen modal
let imgModalOpen = false;
function openImgModal() {
  if (!$('imgRenderImg').getAttribute('src')) return;   // 还没有渲染结果
  $('imgModalOrig').src = $('imgOrigImg').src;
  $('imgModalRender').src = $('imgRenderImg').src;
  setModalImgSplit(0.5);
  $('imgModal').classList.add('show');
  $('imgModal').setAttribute('aria-hidden', 'false');
  imgModalOpen = true;
  setTimeout(() => $('imgModalClose').focus(), 0);
}
function closeImgModal() {
  $('imgModal').classList.remove('show');
  $('imgModal').setAttribute('aria-hidden', 'true');
  imgModalOpen = false;
  const back = $('imgZoomBtn');
  if (back && !back.disabled) back.focus();
}
$('imgModalClose').addEventListener('click', closeImgModal);
$('imgModal').addEventListener('click', (e) => {
  if (e.target === $('imgModal')) closeImgModal();   // 点背景关闭
});
$('imgZoomBtn').addEventListener('click', openImgModal);

// 载入一张图片（磁盘文件，或拖入/粘贴后存在临时目录的副本）：
// 显示普通预览，并让「渲染此图」可用。旧的渲染结果一并作废。
function applyImgInput(path, name) {
  imgPickPath = path;
  imgRenderedAbs = null;
  $('imgSaveBtn').disabled = true;
  $('imgZoomBtn').disabled = true;
  $('imgRenderBtn').disabled = false;
  $('imgBox').style.display = 'none';
  $('imgBox').classList.add('empty');
  $('imgOrigImg').src = '';
  $('imgRenderImg').src = '';
  // 拖放区保持可见：它同时也是"换一张"的入口。原实现在这里把它隐藏后就再也没有
  // 恢复过，而状态文字却仍在提示可以 Ctrl+V。
  $('imgPreview').src = '/api/image?path=' + encodeURIComponent(path);
  $('imgPreview').style.display = '';
  $('imgStatus').textContent = `已选：${name || path} — 点「渲染此图」开始`;
}

async function pickImgFile() {
  const btn = $('imgPickBtn');
  if (window.uiBusy) window.uiBusy(btn, true);
  try {
    const r = await fetch('/api/pick-image').then((x) => x.json());
    if (r.ok) {
      applyImgInput(r.path, r.name);
    } else if (!r.cancelled) {
      logError('选择图片失败：' + (r.error || '未知原因'));
    }
  } catch (e) {
    logError('选择图片失败：' + e.message);
  } finally {
    if (window.uiBusy) window.uiBusy(btn, false);
  }
}
$('imgPickBtn').addEventListener('click', pickImgFile);
$('imgDropZone').addEventListener('click', pickImgFile);

// 拖入 / 粘贴一张图片。浏览器只给文件内容，所以先上传到临时目录，再当作选中的图片。
async function handleDroppedImage(file) {
  if (!isImageFile(file.name)) {
    logError('不支持的图片：' + (file.name || '未知') + '（支持 png/jpg/jpeg/bmp/webp/tif/tiff）');
    return;
  }
  const zone = $('imgDropZone');
  if (zone) zone.classList.add('drop-active');
  try {
    const r = await fetch('/api/upload', {
      method: 'POST',
      headers: { 'X-Filename': encodeURIComponent(file.name) },
      body: file,
    }).then((x) => x.json());
    if (r.ok) {
      applyImgInput(r.path, file.name);
      if (window.uiOk) window.uiOk('已导入图片：' + file.name);
    } else {
      logError('接收图片失败：' + (r.error || '未知原因'));
    }
  } catch (e) {
    logError('接收图片失败：' + e.message);
  } finally {
    if (zone) zone.classList.remove('drop-active');
  }
}

// 从剪贴板里取出图片（截图工具 / 网页复制的图 / 资源管理器里复制的图片文件）。
function clipboardImage(dt) {
  if (!dt) return null;
  const pick = (f) => {
    if (!f) return null;
    const t = (f.type || '').toLowerCase();
    return (t.startsWith('image/') || isImageFile(f.name)) ? f : null;
  };
  if (dt.items) {
    for (const it of Array.from(dt.items)) {
      if (it.kind !== 'file') continue;
      try {
        const f = pick(it.getAsFile());
        if (f) return f;
      } catch (e) { /* ignore */ }
    }
  }
  for (const f of Array.from(dt.files || [])) {
    const g = pick(f);
    if (g) return g;
  }
  return null;
}

// Ctrl+V 把剪贴板里的图片送进图片模块。纯文本粘贴不动：焦点在输入框里且剪贴板
// 同时带文本时，让输入框自己处理，保证普通的复制粘贴照常工作。
document.addEventListener('paste', (e) => {
  const dt = e.clipboardData;
  if (!dt) return;
  const t = e.target;
  const editable = !!(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable));
  const hasText = Array.from(dt.types || []).some((x) => x === 'text/plain' || x === 'text/html');
  if (editable && hasText) return;
  let img = clipboardImage(dt);
  if (!img) return;
  e.preventDefault();
  if (!isImageFile(img.name)) {
    const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp',
                  'image/bmp': '.bmp', 'image/tiff': '.tif' }[img.type] || '.png';
    img = new File([img], 'pasted_' + Date.now().toString(36) + ext, { type: img.type });
  }
  if (window.uiShell) window.uiShell.showTab('image');
  handleDroppedImage(img);
});

// ---------------------------------------------------------------- render one still
$('imgRenderBtn').addEventListener('click', async () => {
  if (!imgPickPath) {
    logError('还没有选择图片');
    return;
  }
  if (stillBusy) return;                     // 与「渲染当前帧」/ 批量共用互斥，防止并发推理
  const btn = $('imgRenderBtn');
  const status = $('imgStatus');
  stillEnter();
  if (window.uiBusy) window.uiBusy(btn, true);
  const stopTick = window.uiElapsed ? window.uiElapsed(status, '正在渲染（真实模型推理）') : null;
  try {
    const r = await fetch('/api/render-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: imgPickPath, cfg: imgJobCfg() }),
    }).then((x) => x.json());
    if (!r.ok) {
      status.textContent = '渲染失败';
      logError('渲染失败：' + (r.error || '未知原因'));
      return;
    }
    $('imgPreview').style.display = 'none';
    $('imgBox').style.display = '';
    $('imgOrigImg').src = r.orig;
    $('imgRenderImg').src = r.render;
    $('imgBox').classList.remove('empty');
    imgRenderedAbs = r.renderedAbs || null;
    $('imgSaveBtn').disabled = !imgRenderedAbs;
    $('imgZoomBtn').disabled = !imgRenderedAbs;
    status.textContent = `${r.width}x${r.height} — 渲染完成，拖动分界线对比`;
    setImgSplit(0.5);
    if (window.uiOk) window.uiOk('渲染完成 — 可拖动分界线对比，或点「放大对比」');
  } catch (e) {
    status.textContent = '请求失败';
    logError('渲染失败：' + e.message);
  } finally {
    if (stopTick) stopTick();
    if (window.uiBusy) window.uiBusy(btn, false);
    stillLeave();
  }
});

$('imgSaveBtn').addEventListener('click', async () => {
  if (!imgRenderedAbs) return;
  const btn = $('imgSaveBtn');
  const status = $('imgStatus');
  const before = status.textContent;
  status.textContent = '等待选择保存位置…（在弹出的对话框里操作）';
  if (window.uiBusy) window.uiBusy(btn, true);
  try {
    const r = await fetch('/api/save-image?src=' + encodeURIComponent(imgRenderedAbs)).then((x) => x.json());
    if (r.ok) {
      status.textContent = '已保存：' + r.path;
      if (window.uiOk) window.uiOk('已保存：' + r.path);
    } else if (r.cancelled) {
      // 取消要恢复原文案，否则"等待选择保存位置…"会永远留在那里
      status.textContent = before;
    } else {
      status.textContent = '保存失败';
      logError('保存失败：' + (r.error || '未知原因'));
    }
  } catch (e) {
    status.textContent = '保存失败';
    logError('保存失败：' + e.message);
  } finally {
    if (window.uiBusy) window.uiBusy(btn, false);
  }
});

// ---------------------------------------------------------------- batch image render
let imgBatchCur = {};
let imgBatchTimer = null;
let imgBatchBusy = false;
let imgBatchFails = 0;      // 轮询连续失败次数

function imgBatchRender() {
  const b = imgBatchCur;
  if (b.current) {
    $('imgBatchInfo').textContent = '第 ' + b.idx + '/' + b.total + ' 张（' + b.current + '）' +
      ' · 成功 ' + b.ok + ' · 跳过 ' + b.skip + (b.failed && b.failed.length ? ' · 失败 ' + b.failed.length : '');
  } else {
    $('imgBatchInfo').textContent = '第 ' + (b.idx || 0) + '/' + (b.total || 0) + ' 张…';
  }
}

function imgBatchRelease() {
  imgBatchBusy = false;
  $('imgBatchPickSrc').disabled = false;
  $('imgBatchPickOut').disabled = false;
  $('imgBatchStop').disabled = true;
  syncStillButtons();
}

function imgBatchPoll() {
  fetch('/api/image-batch').then((x) => x.json()).then((b) => {
    imgBatchFails = 0;
    imgBatchCur = b;
    if (!b.running) {
      clearInterval(imgBatchTimer); imgBatchTimer = null;
      const wasBusy = imgBatchBusy;
      imgBatchRelease();
      if (b.done) {
        const fail = b.failed && b.failed.length ? '（失败 ' + b.failed.length + '：' + b.failed.join('；') + '）' : '';
        $('imgBatchInfo').textContent = '批量完成：成功 ' + b.ok + ' / 跳过 ' + b.skip + fail + ' → ' + (b.outDir || '');
        if (window.uiOk) window.uiOk('图片批量完成：成功 ' + b.ok + '，跳过 ' + b.skip);
      } else if (b.cancelled) {
        $('imgBatchInfo').textContent = '已停止（已处理 ' + (b.idx || 0) + ' 张）';
        if (wasBusy && window.uiWarn) window.uiWarn('图片批量已停止');
      }
      return;
    }
    imgBatchRender();
  }).catch((e) => {
    // 轮询失败不能把忙碌标志永久卡住（原实现的 busy 只在成功回调里复位，
    // 服务重启一次就再也点不动任何按钮，只能刷新页面）
    imgBatchFails++;
    if (imgBatchFails === 3) {
      $('imgBatchInfo').textContent = '与服务的连接中断，正在重试…';
    } else if (imgBatchFails >= 8) {
      clearInterval(imgBatchTimer); imgBatchTimer = null;
      imgBatchBusy = false;
      imgBatchRelease();
      logError('图片批量状态查询失败，已停止跟踪：' + e.message);
    }
  });
}

$('imgBatchPickSrc').addEventListener('click', async () => {
  if (imgBatchBusy) return;
  const btn = $('imgBatchPickSrc');
  if (window.uiBusy) window.uiBusy(btn, true);
  try {
    const pk = await fetch('/api/pick-folder').then((x) => x.json());
    if (!pk.ok) {
      if (!pk.cancelled) logError('选择文件夹失败：' + (pk.error || '未知原因'));
      return;
    }
    const base = pk.dir.replace(/[\\/]+$/, '');
    const sep = pk.dir.indexOf('\\') >= 0 ? '\\' : '/';
    $('imgBatchSrc').value = pk.dir;
    $('imgBatchOut').value = base + sep + 'nr_' + base.split(/[\\\/]/).pop();
    $('imgBatchInfo').textContent = '输入文件夹：' + pk.dir;
    syncStillButtons();
  } catch (e) {
    logError('选择文件夹失败：' + e.message);
  } finally {
    if (window.uiBusy) window.uiBusy(btn, false);
  }
});

$('imgBatchPickOut').addEventListener('click', async () => {
  if (imgBatchBusy) return;
  const btn = $('imgBatchPickOut');
  if (window.uiBusy) window.uiBusy(btn, true);
  try {
    const pk = await fetch('/api/pick-folder').then((x) => x.json());
    if (!pk.ok) {
      if (!pk.cancelled) logError('选择文件夹失败：' + (pk.error || '未知原因'));
      return;
    }
    $('imgBatchOut').value = pk.dir;
    $('imgBatchInfo').textContent = '输出文件夹：' + pk.dir;
    syncStillButtons();
  } catch (e) {
    logError('选择文件夹失败：' + e.message);
  } finally {
    if (window.uiBusy) window.uiBusy(btn, false);
  }
});

$('imgBatchStart').addEventListener('click', async () => {
  if (imgBatchBusy) return;
  const src = $('imgBatchSrc').value.trim();
  if (!src) {
    logError('请先选择输入文件夹');
    return;
  }
  if (stillBusy) {
    logError('正在渲染单张图片，请等它完成后再开始批量');
    return;
  }
  const btn = $('imgBatchStart');
  // 立刻置忙：原来要等 POST 返回才置忙，双击会发出第二次请求
  imgBatchBusy = true;
  if (window.uiBusy) window.uiBusy(btn, true);
  $('imgBatchPickSrc').disabled = true;
  $('imgBatchPickOut').disabled = true;
  $('imgBatchStop').disabled = false;
  $('imgBatchInfo').textContent = '正在扫描并提交…';
  try {
    const body = {
      dir: src,
      outDir: $('imgBatchOut').value.trim(),
      format: $('imgBatchFmt').value,
      cfg: imgJobCfg(),
    };
    const r = await fetch('/api/image-batch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).then((x) => x.json());
    if (!r.ok) {
      imgBatchRelease();
      $('imgBatchInfo').textContent = '启动失败';
      logError('图片批量启动失败：' + (r.error || '未知原因'));
      return;
    }
    $('imgBatchInfo').textContent = '批量开始：共 ' + r.total + ' 张 → ' + r.outDir;
    if (window.uiToast) window.uiToast('图片批量已开始：共 ' + r.total + ' 张', 'info');
    if (imgBatchTimer) clearInterval(imgBatchTimer);
    imgBatchTimer = setInterval(imgBatchPoll, 700);
    imgBatchPoll();
  } catch (e) {
    imgBatchRelease();
    logError('图片批量启动失败：' + e.message);
  } finally {
    // 注意：这里只解除"提交中"的忙碌态；批量的忙碌态由轮询结束或失败释放
    if (window.uiBusy) {
      btn.removeAttribute('aria-busy');
      const sp = btn.querySelector('.spinner');
      if (sp) sp.parentNode.removeChild(sp);
    }
    if (imgBatchBusy) { btn.disabled = true; }
  }
});

// 停止图片批量。
// 原来这个按钮完全没有绑定点击事件 —— 状态会被改来改去，但按下去什么都不会发生，
// 服务端早就实现好的 /api/image-batch/cancel 也从没被调用过。
$('imgBatchStop').addEventListener('click', async () => {
  const btn = $('imgBatchStop');
  if (window.uiBusy) window.uiBusy(btn, true);
  try {
    const r = await fetch('/api/image-batch/cancel', { method: 'POST' }).then((x) => x.json());
    if (r && r.ok) {
      $('imgBatchInfo').textContent = '正在停止…当前这张渲染完后就会结束';
      if (window.uiToast) window.uiToast('已请求停止图片批量', 'warn');
    } else {
      logError('停止失败：' + ((r && r.error) || '未知原因'));
    }
  } catch (e) {
    logError('停止失败：' + e.message);
  } finally {
    if (window.uiBusy) window.uiBusy(btn, false);
  }
});
