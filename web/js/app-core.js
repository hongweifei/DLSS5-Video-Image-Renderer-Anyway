// 基础：DOM 助手、应用根路径、滑杆绑定、输入与拖放、预览播放器
// 基础：DOM 助手、应用根路径、滑杆绑定、输入与拖放、预览播放器 — 见文件内注释
//
// 由 tools/split-web.js 从原 index.html 的内联 <script> 机械拆分而成：
// 分块连续且顺序不变，因此执行语义与拆分前完全一致。
// 全部文件共享同一全局作用域（非 ES module），互相可以直接引用。

const $ = (id) => document.getElementById(id);
(function () {
  document.querySelectorAll('input, textarea').forEach((el) => {
    el.setAttribute('autocomplete', 'off');
    el.setAttribute('autocorrect', 'off');
    el.setAttribute('autocapitalize', 'off');
    el.setAttribute('spellcheck', 'false');
  });
})();

// Project root + default outputs dir, populated by GET /api/info on boot. Cached so autoFillOutput
// and the output picker can build <ROOT>/outputs/nr_<stem>.<ext> without an extra round-trip.
let APP_ROOT = '';
let APP_OUTPUTS = '';
fetch('/api/info').then((r) => r.json()).then((j) => {
    if (j && j.ok) { APP_ROOT = j.root; APP_OUTPUTS = j.outputs; }
}).catch(() => { /* root stays ''; autoFillOutput then leaves the output field untouched */ });

// Slider + paired number input with range clamping. Slider moves update the input; typing in
// the input clamps to [min, max] and snaps to the step, and pushes the value back to the slider.
['intensity','localTone','localStructure','skinStructure','residualMult'].forEach((k) => {
  const slider = $(k);
  const num = $(k + '_n');
  const min = parseFloat(slider.min);
  const max = parseFloat(slider.max);
  const step = parseFloat(slider.step) || 0.01;

  const clamp = (v) => {
    if (isNaN(v)) return min;
    v = Math.max(min, Math.min(max, v));
    return Math.round(v / step) * step;
  };
  const fmt = (v) => v.toFixed(2);

  const fromSlider = () => {
    const v = clamp(parseFloat(slider.value));
    slider.value = fmt(v);
    num.value = fmt(v);
  };
  const fromNum = () => {
    const raw = parseFloat(num.value);
    if (isNaN(raw)) {
      num.value = fmt(parseFloat(slider.value));
      num.setCustomValidity('');
      return;
    }
    const v = clamp(raw);
    slider.value = fmt(v);
    num.value = fmt(v);
    // flag out-of-range so the browser can style it red; we already clamped the value
    num.setCustomValidity(Math.abs(raw - v) > 1e-9 ? 'out of range' : '');
  };

  slider.addEventListener('input', fromSlider);
  num.addEventListener('input', fromNum);
  num.addEventListener('blur', fromNum);
  fromSlider();
});

// True when the current input path is a disposable drag-and-drop copy. Kept as a flag in case
// future features (e.g. "open original location") need to know; not currently consumed by any
// auto-fill code now that all defaults go to <ROOT>/outputs/.
let inputIsTmp = false;
// Original display filename of the current input (e.g. "clip.mp4"). Used to build the default
// output name nr_<stem>.<ext> so drag-and-drop (whose temp path is a random id) still produces
// an output named after the user's real file.
let lastOrigName = '';

// Drops any previously rendered frame comparison (orig+render pair) so a NEW video/frame never
// shows mixed with the OLD video's picture while the next render is in flight or failed.
function resetImgCompare() {
  imgRenderedAbs = null;
  imgPickPath = null;
  try { $('imgSaveBtn').disabled = true; $('imgZoomBtn').disabled = true; } catch (e) { /* ignore */ }
  try {
    $('imgOrigImg').src = '';
    $('imgRenderImg').src = '';
    $('imgBox').style.display = 'none';
    $('imgBox').classList.add('empty');
  } catch (e) { /* ignore */ }
}

function applyInputPath(path, name, isTmp) {
  inputIsTmp = !!isTmp;
  lastOrigName = name || '';
  $('input').value = path;
  resetRangeFromInput();
  resetImgCompare();          // previous video's rendered frame must not leak into the new one
  loadCmpPlayer(path);
}

// Legacy: used to pre-fill the output field with outputs/nr_<name>.<ext>. With the two-stage
// export the output field holds a FOLDER only (or stays empty = default outputs/) and the file
// name belongs to 「保存的文件名」-- so this is intentionally a no-op now.
function autoFillOutput() { /* no-op: keep callers happy */ }

// Points the compare player at the chosen video so the user can scrub to the frame they want.
function loadCmpPlayer(path) {
  const v = $('cmpVideo');
  const status = $('cmpStatus');
  const src = '/api/video?path=' + encodeURIComponent(path);
  if (v.getAttribute('data-src') === src) return;
  v.setAttribute('data-src', src);
  v.src = src;
  const om = () => {
    v.removeEventListener('loadedmetadata', om);
    v.removeEventListener('error', oe);
    status.textContent = `播放器就绪:拖动进度条选帧(总长 ${v.duration ? v.duration.toFixed(1) : '?'}s),选好后点按钮`;
  };
  const oe = () => {
    v.removeEventListener('loadedmetadata', om);
    v.removeEventListener('error', oe);
    status.textContent = '播放器无法解码该视频(浏览器缺少对应解码器)';
  };
  v.addEventListener('loadedmetadata', om);
  v.addEventListener('error', oe);
  v.load();
}

// Upload a dropped file's content to the server's disposable temp dir, then treat it like any
// other chosen input. The browser cannot provide the file's real local path -- only its content.
// The original filename is remembered so the auto-filled output uses nr_<original>.mp4 instead
// of the random temp name. No inline status text: mistakes go to the floating log instead.
async function handleDroppedFile(file) {
  if (!/\.(mp4|mov|mkv|avi|webm|m4v)$/i.test(file.name)) {
    logError('不支持的拖入文件: ' + file.name + ' (支持 mp4/mov/mkv/avi/webm/m4v)');
    return;
  }
  try {
    const r = await fetch('/api/upload', {
      method: 'POST',
      headers: { 'X-Filename': encodeURIComponent(file.name) },
      body: file,
    }).then((x) => x.json());
    if (r.ok) {
      applyInputPath(r.path, file.name, r.tmp);
      autoFillOutput();
    } else {
      logError('接收拖入文件失败: ' + (r.error || 'unknown'));
    }
  } catch (e) {
    logError('接收拖入文件失败: ' + e.message);
  }
}

// Drag & drop: a file may be released anywhere on the page -- both the video card and the image
// card are highlighted while a file drag is in progress, and the drop is routed by extension
// (video -> 视频渲染, image -> 图片渲染).
let dragDepth = 0;
function fileDragActive(e) {
  return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') >= 0;
}
function isImageFile(name) {
  return /\.(png|jpe?g|bmp|webp|tif?f)$/i.test(name || '');
}
function isVideoFile(name) {
  return /\.(mp4|mov|mkv|avi|webm|m4v)$/i.test(name || '');
}
document.addEventListener('dragenter', (e) => {
  if (!fileDragActive(e)) return;
  dragDepth++;
  $('fileCard').classList.add('drop-active');
  $('imgCard').classList.add('drop-active');
});
document.addEventListener('dragleave', (e) => {
  if (!fileDragActive(e)) return;
  if (--dragDepth <= 0) {
    dragDepth = 0;
    $('fileCard').classList.remove('drop-active');
    $('imgCard').classList.remove('drop-active');
  }
});
document.addEventListener('dragover', (e) => {
  if (fileDragActive(e)) e.preventDefault();
});
document.addEventListener('drop', (e) => {
  if (!fileDragActive(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $('fileCard').classList.remove('drop-active');
  $('imgCard').classList.remove('drop-active');
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (!f) return;
  if (isImageFile(f.name)) handleDroppedImage(f);
  else if (isVideoFile(f.name)) handleDroppedFile(f);
  else logError('不支持的拖入文件: ' + f.name + ' (视频 mp4/mov/mkv/avi/webm/m4v;图片 png/jpg/jpeg/bmp/webp/tif/tiff)');
});

// Ask the server to show a native file picker; the returned path is the original file path,
// so the output can default to nr_<original>.mp4 under the outputs dir. No inline status text.
$('filePickerBtn').addEventListener('click', async () => {
  try {
    const r = await fetch('/api/pick-file').then((x) => x.json());
    if (r.ok) {
      applyInputPath(r.path, r.name, false);
      autoFillOutput();
    } else if (!r.cancelled) {
      logError('选择视频失败: ' + (r.error || 'unknown'));
    }
  } catch (e) {
    logError('选择视频失败: ' + e.message);
  }
});

// Pick an output folder via a native folder dialog, then compose a default "nr_<stem><ext>"
// filename inside it and fill the output field. The stem prefers the original filename (so a
// dragged-in copy does not leak its random temp name into the output).
$('outputPickBtn').addEventListener('click', async () => {
  try {
    const r = await fetch('/api/save-file?input=' + encodeURIComponent($('input').value.trim()))
      .then((x) => x.json());
    if (r.ok) {
      const sep = r.dir.includes('\\') ? '\\' : '/';
      const tail = r.dir.endsWith('\\') || r.dir.endsWith('/') ? '' : sep;
      // Folder only -- the final file name comes from 「保存的文件名」.
      $('output').value = r.dir + tail;
    } else if (!r.cancelled) {
      logError('选择输出文件夹失败: ' + (r.error || 'unknown'));
    }
  } catch (e) {
    logError('选择输出文件夹失败: ' + e.message);
  }
});

