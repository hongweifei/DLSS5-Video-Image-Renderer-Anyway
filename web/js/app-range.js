// 时间范围与"快速渲染当前帧"对比预览
// 时间范围与"快速渲染当前帧"对比预览 — 见文件内注释
//
// 由 tools/split-web.js 从原 index.html 的内联 <script> 机械拆分而成：
// 分块连续且顺序不变，因此执行语义与拆分前完全一致。
// 全部文件共享同一全局作用域（非 ES module），互相可以直接引用。

// ---------------------------------------------------------------- time range
// The compare player (in 输出设置) is the picker now: drag the timeline, then click the
// "选择当前时间为起点 / 终点" buttons to push the value back into the start/end inputs.
// Direct typing into the inputs still works.
function syncRangeFields() {
  const st = parseFloat($('startTime').value) || 0;
  const et = parseFloat($('endTime').value) || 0;
  $('rangeInfo').textContent = et > 0 ? `${st.toFixed(1)} → ${et.toFixed(1)} s` : `${st.toFixed(1)} s → 结尾`;
}
$('startTime').addEventListener('input', syncRangeFields);
$('endTime').addEventListener('input', syncRangeFields);

// When a new input file is chosen, reset the range to the whole clip.
function resetRangeFromInput() {
  $('startTime').value = '0';
  $('endTime').value = '0';
  syncRangeFields();
}

function playerCurrentTimeSafe() {
  const v = $('cmpVideo');
  if (!v || !isFinite(v.currentTime) || v.currentTime < 0) return 0;
  return v.currentTime;
}

$('pickStartBtn').addEventListener('click', () => {
  $('startTime').value = playerCurrentTimeSafe().toFixed(1);
  syncRangeFields();
});
$('pickEndBtn').addEventListener('click', () => {
  const t = playerCurrentTimeSafe();
  const st = parseFloat($('startTime').value) || 0;
  if (t <= st) {
    alert('终点必须大于起点(当前 ' + t.toFixed(2) + 's ≤ 起点 ' + st.toFixed(2) + 's)');
    return;
  }
  $('endTime').value = t.toFixed(1);
  syncRangeFields();
});

// ---------------------------------------------------------------- compare preview
// The user picks the frame in an inline <video> player (scrub the timeline), then presses the
// render button; we render exactly that time and show an orig/rendered split-comparison panel.

function playerCurrentTimeOrLoad(input) {
  return new Promise((resolve, reject) => {
    const v = $('cmpVideo');
    if (v.getAttribute('data-src') === '/api/video?path=' + encodeURIComponent(input)) {
      if (v.readyState >= 1) return resolve(v.currentTime || 0);
      const om = () => { v.removeEventListener('loadedmetadata', om); resolve(v.currentTime || 0); };
      v.addEventListener('loadedmetadata', om);
      return;
    }
    loadCmpPlayer(input);
    const oe = () => { v.removeEventListener('loadedmetadata', om2); v.removeEventListener('error', oe); reject(new Error('播放器无法解码该视频')); };
    const om2 = () => { v.removeEventListener('loadedmetadata', om2); v.removeEventListener('error', oe); resolve(v.currentTime || 0); };
    v.addEventListener('loadedmetadata', om2);
    v.addEventListener('error', oe);
  });
}

$('setCmpFrameBtn').addEventListener('click', async () => {
  const v = $('cmpVideo');
  const btn = $('setCmpFrameBtn');
  const status = $('cmpStatus');
  if (!v || !v.readyState || v.readyState < 2) {
    const input = $('input').value.trim();
    if (!input) { alert('请先选择输入视频'); return; }
    status.textContent = '正在加载播放器…';
    try {
      await playerCurrentTimeOrLoad(input);
    } catch (e) {
      status.textContent = e.message;
      return;
    }
  }
  if (!v.videoWidth) { status.textContent = '播放器尚未就绪,请稍候再试'; return; }
  const t = (v.currentTime && isFinite(v.currentTime)) ? v.currentTime : 0;
  btn.disabled = true;
  status.textContent = `正在截取 t=${t.toFixed(2)}s 画面并单帧渲染…`;
  try {
    // 1) Snapshot the PLAYER's decoded frame at its native resolution (no ffmpeg re-decode).
    const cv = document.createElement('canvas');
    cv.width = v.videoWidth;
    cv.height = v.videoHeight;
    cv.getContext('2d').drawImage(v, 0, 0);
    resetImgCompare();                      // hide the previous pair until this frame's result lands
    status.textContent = '渲染当前帧…';
    const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
    if (!blob) throw new Error('截图失败:canvas 没有输出');
    // 2) Upload the PNG, then reuse the still-image renderer (16-bit, no NV-OF) on that exact
    //    frame -- a couple of engine calls, not a full video-window render.
    const up = await fetch('/api/upload', {
      method: 'POST',
      headers: { 'x-filename': 'frame_shot.png' },
      body: blob,
    }).then((x) => x.json());
    if (!up.ok || !up.path) throw new Error('上传失败: ' + (up.error || '?'));
    const rr = await fetch('/api/render-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: up.path, cfg: buildJobCfg() }),
    }).then((x) => x.json());
    if (!rr.ok) throw new Error('渲染失败: ' + (rr.error || '?'));
    // Show the result in the IMAGE module's compare area (right column).
    $('imgPreview').style.display = 'none';
    $('imgBox').style.display = '';
    $('imgOrigImg').src = rr.orig;
    $('imgRenderImg').src = rr.render;
    $('imgBox').classList.remove('empty');
    imgPickPath = up.path;                       // 保存/放大/重渲都作用于这一帧
    imgRenderedAbs = rr.renderedAbs || null;
    $('imgSaveBtn').disabled = !imgRenderedAbs;
    $('imgZoomBtn').disabled = !imgRenderedAbs;
    status.textContent = `${rr.width}x${rr.height} @ 播放器 t=${t.toFixed(2)}s — 已渲染,见右侧图片模块对比`;
    setImgSplit(0.5);
  } catch (e) {
    status.textContent = '请求失败: ' + e.message;
  } finally {
    btn.disabled = false;
  }
});

// Convert a mouse event over the compare box into a split position relative to the .img-stage
// (the exact rect the picture occupies). Using the box rect instead would shift the divider
// whenever the picture is smaller than the box (letterbox).
function splitFromEvent(e, stage, setter) {
  const st = stage.getBoundingClientRect();
  if (st.width <= 0) return;
  const p = Math.min(1, Math.max(0, (e.clientX - st.left) / st.width));
  setter(p);
}
