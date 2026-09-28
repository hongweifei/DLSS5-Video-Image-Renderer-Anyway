// 图片渲染、图片批量渲染与对比视图
// 图片渲染、图片批量渲染与对比视图 — 见文件内注释
//
// 由 tools/split-web.js 从原 index.html 的内联 <script> 机械拆分而成：
// 分块连续且顺序不变，因此执行语义与拆分前完全一致。
// 全部文件共享同一全局作用域（非 ES module），互相可以直接引用。

// ---------------------------------------------------------------- image render
let imgPickPath = null;      // chosen still image on disk
let imgRenderedAbs = null;   // server path of the last rendered PNG (for 保存)

// Generic split-line driver: layer's clip-path reveals the rendered side from the left, the
// divider slides to match. Both the inline image compare (#imgBox) and the full-screen modal
// (#imgModalBox) reuse the same code so they stay perfectly in sync.
function setBoxSplit(layerEl, dividerEl, p) {
  const pct = (p * 100).toFixed(2);
  layerEl.style.clipPath = `inset(0 0 0 ${pct}%)`;
  dividerEl.style.left = pct + '%';
}
function setImgSplit(p) { setBoxSplit($('imgRenderLayer'), $('imgDivider'), p); }
function setModalImgSplit(p) { setBoxSplit($('imgModalRenderLayer'), $('imgModalDivider'), p); }
$('imgBox').addEventListener('mousemove', (e) => splitFromEvent(e, $('imgStage'), setImgSplit));
$('imgBox').addEventListener('mouseleave', () => setImgSplit(0.5));
setImgSplit(0.5);

// Full-screen compare modal: same drag-to-split UX as the inline box, just near fullscreen so
// pixel-level differences are easy to spot. Pulled out so the inline card can stay compact.
let imgModalOpen = false;
function openImgModal() {
  if (!$('imgRenderImg').getAttribute('src')) return;   // no rendered result yet
  $('imgModalOrig').src = $('imgOrigImg').src;
  $('imgModalRender').src = $('imgRenderImg').src;
  setModalImgSplit(0.5);
  $('imgModal').classList.add('show');
  $('imgModal').setAttribute('aria-hidden', 'false');
  imgModalOpen = true;
}
function closeImgModal() {
  $('imgModal').classList.remove('show');
  $('imgModal').setAttribute('aria-hidden', 'true');
  imgModalOpen = false;
}
$('imgModalBox').addEventListener('mousemove', (e) => splitFromEvent(e, $('imgModalStage'), setModalImgSplit));
$('imgModalBox').addEventListener('mouseleave', () => setModalImgSplit(0.5));
$('imgModalClose').addEventListener('click', closeImgModal);
$('imgModal').addEventListener('click', (e) => {
  // Click outside the compare box (on the dark backdrop) closes the modal.
  if (e.target === $('imgModal')) closeImgModal();
});
document.addEventListener('keydown', (e) => {
  if (imgModalOpen && e.key === 'Escape') closeImgModal();
});
$('imgZoomBtn').addEventListener('click', openImgModal);
setModalImgSplit(0.5);

// Loads an image source (disk file via the picker, or a drag-in / clipboard-paste copy stored in
// the uploads dir) into the image module: shows the plain preview and arms the render button.
// Any previous rendered comparison is discarded -- a new source invalidates the old "after" image.
function applyImgInput(path, name) {
  imgPickPath = path;
  imgRenderedAbs = null;
  $('imgSaveBtn').disabled = true;
  $('imgZoomBtn').disabled = true;
  $('imgRenderBtn').disabled = false;
  // Reset: hide the split-compare, show a plain preview of the source image.
  $('imgBox').style.display = 'none';
  $('imgBox').classList.add('empty');
  $('imgOrigImg').src = '';
  $('imgRenderImg').src = '';
  $('imgDropZone').style.display = 'none';
  $('imgPreview').src = '/api/image?path=' + encodeURIComponent(path);
  $('imgPreview').style.display = '';
  $('imgStatus').textContent = `已选: ${name} — 点「渲染此图」`;
}

async function pickImgFile() {
  try {
    const r = await fetch('/api/pick-image').then((x) => x.json());
    if (r.ok) {
      applyImgInput(r.path, r.name);
    } else if (!r.cancelled) {
      $('imgStatus').textContent = '选择失败: ' + (r.error || 'unknown');
    }
  } catch (e) {
    $('imgStatus').textContent = '选择失败: ' + e.message;
  }
}
$('imgPickBtn').addEventListener('click', pickImgFile);
$('imgDropZone').addEventListener('click', pickImgFile);

// Drag-in / paste an image file. The browser only hands over the file's CONTENT (never its real
// disk path), so it is uploaded to the disposable uploads dir under its original filename, then
// loaded exactly like a picked image. Errors go to the floating log and never touch the current
// selection.
async function handleDroppedImage(file) {
  if (!isImageFile(file.name)) {
    logError('不支持的图片文件: ' + (file.name || '未知') + ' (支持 png/jpg/jpeg/bmp/webp/tif/tiff)');
    return;
  }
  try {
    const r = await fetch('/api/upload', {
      method: 'POST',
      headers: { 'X-Filename': encodeURIComponent(file.name) },
      body: file,
    }).then((x) => x.json());
    if (r.ok) {
      applyImgInput(r.path, file.name);
    } else {
      logError('接收图片失败: ' + (r.error || 'unknown'));
    }
  } catch (e) {
    logError('接收图片失败: ' + e.message);
  }
}

// Pulls an image out of a clipboard paste event: a screenshot (capture tool / Win+Shift+S), a
// picture copied from a web page, or an image file copied in Explorer. Returns a File or null.
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

// Ctrl+V feeds an image from the clipboard into the image module. Text pastes are left alone:
// when the focus is in a text/number field AND the clipboard also carries text/html, the field
// wins so normal copy-paste of values keeps working.
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
  // Browsers usually name a screenshot "image.png"; give nameless pasted content a filename so
  // the upload + preview paths stay consistent.
  if (!isImageFile(img.name)) {
    const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp',
                  'image/bmp': '.bmp', 'image/tiff': '.tif' }[img.type] || '.png';
    img = new File([img], 'pasted_' + Date.now().toString(36) + ext, { type: img.type });
  }
  handleDroppedImage(img);
});

$('imgRenderBtn').addEventListener('click', async () => {
  if (!imgPickPath) return;
  const btn = $('imgRenderBtn');
  btn.disabled = true;
  $('imgStatus').textContent = '正在渲染(引擎冷启动需数秒)…';
  try {
    const r = await fetch('/api/render-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: imgPickPath, cfg: imgJobCfg() }),
    }).then((x) => x.json());
    if (!r.ok) {
      $('imgStatus').textContent = '渲染失败: ' + (r.error || 'unknown');
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
    $('imgStatus').textContent = `${r.width}x${r.height} — 渲染完成,移动鼠标对比`;
    setImgSplit(0.5);
  } catch (e) {
    $('imgStatus').textContent = '请求失败: ' + e.message;
  } finally {
    btn.disabled = false;
  }
});

$('imgSaveBtn').addEventListener('click', async () => {
  if (!imgRenderedAbs) return;
  $('imgStatus').textContent = '等待选择保存位置…';
  try {
    const r = await fetch('/api/save-image?src=' + encodeURIComponent(imgRenderedAbs)).then((x) => x.json());
    if (r.ok) {
      $('imgStatus').textContent = '已保存: ' + r.path;
    } else if (!r.cancelled) {
      $('imgStatus').textContent = '保存失败: ' + (r.error || 'unknown');
    }
  } catch (e) {
    $('imgStatus').textContent = '保存失败: ' + e.message;
  }
});

// ---------------------------------------------------------------- batch image render
let imgBatchCur = {};
let imgBatchTimer = null;
let imgBatchBusy = false;

function imgBatchRender() {
  $('imgBatchInfo').textContent = '第 ' + imgBatchCur.idx + '/' + imgBatchCur.total + ' 张…';
  if (imgBatchCur.current) {
    $('imgBatchInfo').textContent = '第 ' + imgBatchCur.idx + '/' + imgBatchCur.total +
      ' 张 (' + imgBatchCur.current + ') · 成功 ' + imgBatchCur.ok +
      ' · 跳过 ' + imgBatchCur.skip + (imgBatchCur.failed.length ? ' · 失败 ' + imgBatchCur.failed.length : '');
  }
}
function imgBatchPoll() {
  fetch('/api/image-batch').then((x) => x.json()).then((b) => {
    imgBatchCur = b;
    if (!b.running) {
      clearInterval(imgBatchTimer); imgBatchTimer = null;
      imgBatchBusy = false;
      $('imgBatchPickSrc').disabled = false;
      $('imgBatchPickOut').disabled = false;
      $('imgBatchStart').disabled = !$('imgBatchSrc').value.trim();
      $('imgBatchStop').disabled = true;
      if (b.done) {
        const fail = b.failed && b.failed.length ? '（失败 ' + b.failed.length + ': ' + b.failed.join('；') + '）' : '';
        $('imgBatchInfo').textContent = '批量完成：成功 ' + b.ok + ' / 跳过 ' + b.skip + fail +
          ' → ' + (b.outDir || '');
      } else if (b.cancelled) {
        $('imgBatchInfo').textContent = '已停止批量（已处理 ' + (b.idx || 0) + ' 张）';
      }
      return;
    }
    imgBatchRender();
  }).catch(() => { /* server restart etc. */ });
}

// 输入路径：选源文件夹，并自动预填默认输出路径（源目录\nr_<源夹名>）
$('imgBatchPickSrc').addEventListener('click', async () => {
  if (imgBatchBusy) return;
  const pk = await fetch('/api/pick-folder').then((x) => x.json());
  if (!pk.ok) { if (!pk.cancelled) $('imgBatchInfo').textContent = '选择失败: ' + (pk.error || '?'); return; }
  const base = pk.dir.replace(/[\\/]+$/, '');
  const sep = pk.dir.indexOf('\\') >= 0 ? '\\' : '/';
  $('imgBatchSrc').value = pk.dir;
  $('imgBatchOut').value = base + sep + 'nr_' + base.split(/[\\\/]/).pop();
  $('imgBatchStart').disabled = false;
  $('imgBatchInfo').textContent = '已选输入文件夹：' + pk.dir;
});

// 输出路径：只改保存位置（留空则由服务端默认到 源目录\nr_<源夹名>）
$('imgBatchPickOut').addEventListener('click', async () => {
  if (imgBatchBusy) return;
  const pk = await fetch('/api/pick-folder').then((x) => x.json());
  if (!pk.ok) { if (!pk.cancelled) $('imgBatchInfo').textContent = '选择失败: ' + (pk.error || '?'); return; }
  $('imgBatchOut').value = pk.dir;
  $('imgBatchStart').disabled = !$('imgBatchSrc').value.trim();
  $('imgBatchInfo').textContent = '已选输出文件夹：' + pk.dir;
});

// 开始渲染：src = 输入路径（必填）；outDir 留空由服务端默认。
$('imgBatchStart').addEventListener('click', async () => {
  if (imgBatchBusy) return;
  const src = $('imgBatchSrc').value.trim();
  if (!src) {
    $('imgBatchInfo').textContent = '请先选择输入文件夹';
    return;
  }
  const body = {
    dir: src,
    outDir: $('imgBatchOut').value.trim(),
    format: $('imgBatchFmt').value,
    cfg: imgJobCfg(),
  };
  const r = await fetch('/api/image-batch', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then((x) => x.json());
  if (!r.ok) { $('imgBatchInfo').textContent = '批量启动失败：' + (r.error || '?'); return; }
  imgBatchBusy = true;
  $('imgBatchStart').disabled = true;
  $('imgBatchPickSrc').disabled = true;
  $('imgBatchPickOut').disabled = true;
  $('imgBatchStop').disabled = false;
  $('imgBatchInfo').textContent = '批量开始：共 ' + r.total + ' 张 → ' + r.outDir;
  if (imgBatchTimer) clearInterval(imgBatchTimer);
  imgBatchTimer = setInterval(imgBatchPoll, 700);
  imgBatchPoll();
});

