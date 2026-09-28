// 基础：DOM 助手、滑杆绑定、输入视频的载入、拖入文件的接收
//
// 全局拖放的**监听**已经全部搬到 app-shell.js（唯一的实现 + 全屏提示 +
// 按文件类型自动切换模式）。这里只保留"拿到一个 File 之后怎么处理"。
// 原先两处拖放监听各自维护 dragDepth，dragleave 不带 dataTransfer.types 时
// 计数不会归零，卡片上的拖放高亮会永久留在页面上。

const $ = (id) => document.getElementById(id);
(function () {
  document.querySelectorAll('input, textarea').forEach((el) => {
    el.setAttribute('autocomplete', 'off');
    el.setAttribute('autocorrect', 'off');
    el.setAttribute('autocapitalize', 'off');
    el.setAttribute('spellcheck', 'false');
  });
})();

// 滑杆 + 配对数字框：两者是同一个值的两个视图，永远同步。
// 数字框越界时会被夹到范围内，并用 setCustomValidity 标红（不改变实际值）。
['intensity', 'localTone', 'localStructure', 'skinStructure', 'residualMult'].forEach((k) => {
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
    num.setCustomValidity(Math.abs(raw - v) > 1e-9 ? '超出范围，已夹到 ' + fmt(v) : '');
  };

  slider.addEventListener('input', fromSlider);
  num.addEventListener('input', fromNum);
  num.addEventListener('blur', fromNum);
  fromSlider();
});

// 清掉上一次的"原图/渲染后"对比。
//
// 这不只是把两张图清空：控件状态必须跟着一起回到"还没有图片"的样子，
// 否则会出现一片空白的图片卡片 + 一个看上去能用、点了却没反应的「渲染此图」
// （原实现只清图片，不动按钮和拖放区，拖放区从此再也不显示）。
function resetImgCompare() {
  imgRenderedAbs = null;
  imgPickPath = null;
  try {
    $('imgSaveBtn').disabled = true;
    $('imgZoomBtn').disabled = true;
    $('imgRenderBtn').disabled = true;
    $('imgOrigImg').src = '';
    $('imgRenderImg').src = '';
    $('imgBox').style.display = 'none';
    $('imgBox').classList.add('empty');
    $('imgPreview').style.display = 'none';
    $('imgPreview').removeAttribute('src');
    $('imgDropZone').style.display = '';
    const st = $('imgStatus');
    if (st) st.textContent = '选择或粘贴一张图片后即可渲染';
  } catch (e) { /* 元素缺失时忽略 */ }
}

function applyInputPath(path) {
  $('input').value = path;
  resetRangeFromInput();
  resetImgCompare();          // 新视频不能还挂着上一段视频截下来的对比图
  loadCmpPlayer(path);
}

// 让对比播放器指向选中的视频，用户才能拖进度条选帧。
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
    status.textContent = `播放器就绪 · 总长 ${v.duration ? v.duration.toFixed(1) : '?'}s — 拖动进度条选帧，再点「渲染当前帧并对比」`;
  };
  const oe = () => {
    v.removeEventListener('loadedmetadata', om);
    v.removeEventListener('error', oe);
    status.textContent = '播放器无法解码该视频（浏览器缺少对应解码器）';
    if (window.uiWarn) window.uiWarn('浏览器无法解码这个视频，仍可以直接开始渲染');
  };
  v.addEventListener('loadedmetadata', om);
  v.addEventListener('error', oe);
  v.load();
}

// 把一个拖入/粘贴的文件内容上传到服务端的临时目录，然后当成正常选中的输入。
// 浏览器只能拿到文件内容，拿不到真实磁盘路径。
async function handleDroppedFile(file) {
  if (!isVideoFile(file.name)) {
    logError('不支持的文件类型：' + file.name + '（视频支持 mp4/mov/mkv/avi/webm/m4v）');
    return;
  }
  const zone = $('videoDropZone');
  if (zone) zone.classList.add('drop-active');
  try {
    const r = await fetch('/api/upload', {
      method: 'POST',
      headers: { 'X-Filename': encodeURIComponent(file.name) },
      body: file,
    }).then((x) => x.json());
    if (r.ok) {
      applyInputPath(r.path);
      if (window.uiOk) window.uiOk('已导入视频：' + file.name);
    } else {
      logError('接收拖入文件失败：' + (r.error || '未知原因'));
    }
  } catch (e) {
    logError('接收拖入文件失败：' + e.message);
  } finally {
    if (zone) zone.classList.remove('drop-active');
  }
}

function isImageFile(name) {
  return /\.(png|jpe?g|bmp|webp|tif?f)$/i.test(name || '');
}
function isVideoFile(name) {
  return /\.(mp4|mov|mkv|avi|webm|m4v)$/i.test(name || '');
}

// 选择视频文件 / 输出文件夹：调服务端的原生对话框（拿到的是原始路径，不复制文件）。
// 请求期间按钮进入忙碌态，避免连点开出两个对话框。
$('filePickerBtn').addEventListener('click', window.uiGuard($('filePickerBtn'), async () => {
  const r = await fetch('/api/pick-file').then((x) => x.json());
  if (r.ok) {
    applyInputPath(r.path);
    if (window.uiOk) window.uiOk('已选择：' + r.name);
  } else if (!r.cancelled) {
    logError('选择视频失败：' + (r.error || '未知原因'));
  }
}));

$('outputPickBtn').addEventListener('click', window.uiGuard($('outputPickBtn'), async () => {
  const r = await fetch('/api/save-file?input=' + encodeURIComponent($('input').value.trim()))
    .then((x) => x.json());
  if (r.ok) {
    const sep = r.dir.includes('\\') ? '\\' : '/';
    const tail = r.dir.endsWith('\\') || r.dir.endsWith('/') ? '' : sep;
    // 这里只选文件夹，最终文件名由「保存的文件名」决定
    $('output').value = r.dir + tail;
    if (window.uiOk) window.uiOk('输出文件夹：' + r.dir);
  } else if (!r.cancelled) {
    logError('选择输出文件夹失败：' + (r.error || '未知原因'));
  }
}));

// 拖放区点击也能选文件（与顶部的按钮等价）
(function () {
  const zone = $('videoDropZone');
  if (!zone) return;
  zone.addEventListener('click', () => $('filePickerBtn').click());
  zone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('filePickerBtn').click(); }
  });
})();
