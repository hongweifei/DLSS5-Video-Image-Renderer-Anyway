// 时间范围与「渲染当前帧并对比」
//
// 这里定义 stillBusy：单帧渲染有三个入口（渲染此图 / 渲染当前帧 / 图片批量），
// 它们打的是同一个 /api/render-image。原实现三个入口互不知情，可以同时起两个
// 引擎进程 —— 而本项目的 WebGPU 后端会话并发会直接让进程硬崩溃。
// 三个入口现在共用这一个互斥标志。

// ---------------------------------------------------------------- 单帧渲染互斥
let stillBusy = false;

function stillEnter() {
  stillBusy = true;
  syncStillButtons();
}
function stillLeave() {
  stillBusy = false;
  syncStillButtons();
}
// 按各入口自身的条件恢复禁用状态（而不是一律打开）
function syncStillButtons() {
  const a = $('setCmpFrameBtn');
  if (a) a.disabled = stillBusy;
  const b = $('imgRenderBtn');
  if (b) b.disabled = stillBusy || !imgPickPath;
  const c = $('imgBatchStart');
  if (c) {
    const batchBusy = (typeof imgBatchBusy !== 'undefined') ? imgBatchBusy : false;
    c.disabled = stillBusy || batchBusy || !$('imgBatchSrc').value.trim();
  }
}

// ---------------------------------------------------------------- time range
function syncRangeFields() {
  const st = parseFloat($('startTime').value) || 0;
  const et = parseFloat($('endTime').value) || 0;
  $('rangeInfo').textContent = et > 0
    ? `${st.toFixed(1)}s → ${et.toFixed(1)}s`
    : `${st.toFixed(1)}s → 结尾`;
}
$('startTime').addEventListener('input', syncRangeFields);
$('endTime').addEventListener('input', syncRangeFields);
syncRangeFields();   // 原来只在输入时同步，初始文本与 JS 的格式并不一致

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
  if (window.uiToast) window.uiToast('起点已设为 ' + $('startTime').value + 's', 'ok', { ms: 2200 });
});
$('pickEndBtn').addEventListener('click', () => {
  const t = playerCurrentTimeSafe();
  const st = parseFloat($('startTime').value) || 0;
  if (t <= st) {
    logError('终点必须大于起点（当前 ' + t.toFixed(2) + 's ≤ 起点 ' + st.toFixed(2) + 's）');
    return;
  }
  $('endTime').value = t.toFixed(1);
  syncRangeFields();
  if (window.uiToast) window.uiToast('终点已设为 ' + $('endTime').value + 's', 'ok', { ms: 2200 });
});

// ---------------------------------------------------------------- compare preview
// 用户在播放器里拖到想要的画面，点按钮 → 截取播放器已解码的那一帧 → 走单帧渲染
// → 结果放进「图片」模式的对比视图。
//
// 注意：这里用的是 /api/render-image（配合把画布上传成 PNG），不是 /api/render-frame。
// /api/render-frame 是另一条独立接口，前端并没有调用它。

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
  if (stillBusy) return;
  const v = $('cmpVideo');
  const btn = $('setCmpFrameBtn');
  const status = $('cmpStatus');
  if (!v || !v.readyState || v.readyState < 2) {
    const input = $('input').value.trim();
    if (!input) { logError('请先选择输入视频'); $('filePickerBtn').focus(); return; }
    status.textContent = '正在加载播放器…';
    try {
      await playerCurrentTimeOrLoad(input);
    } catch (e) {
      status.textContent = e.message;
      logError('预览失败：' + e.message);
      return;
    }
  }
  if (!v.videoWidth) { status.textContent = '播放器尚未就绪，请稍候再试'; return; }

  const t = (v.currentTime && isFinite(v.currentTime)) ? v.currentTime : 0;
  stillEnter();
  if (window.uiBusy) window.uiBusy(btn, true);
  const stopTick = window.uiElapsed
    ? window.uiElapsed(status, `正在渲染 t=${t.toFixed(2)}s 的单帧（真实模型推理）`)
    : null;
  try {
    // 1) 直接抓播放器已解码的画面（原生分辨率，不需要 ffmpeg 再解码一次）
    const cv = document.createElement('canvas');
    cv.width = v.videoWidth;
    cv.height = v.videoHeight;
    cv.getContext('2d').drawImage(v, 0, 0);
    resetImgCompare();
    const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
    if (!blob) throw new Error('截图失败：画布没有输出');

    // 2) 上传这一帧，再用单帧渲染器处理它（16-bit、跳过光流）
    const up = await fetch('/api/upload', {
      method: 'POST',
      headers: { 'x-filename': 'frame_shot.png' },
      body: blob,
    }).then((x) => x.json());
    if (!up.ok || !up.path) throw new Error('上传失败：' + (up.error || '未知原因'));

    const rr = await fetch('/api/render-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: up.path, cfg: buildJobCfg() }),
    }).then((x) => x.json());
    if (!rr.ok) throw new Error('渲染失败：' + (rr.error || '未知原因'));

    // 结果落在「图片」模式的对比区，所以直接切过去 —— 不用再靠一句说明文字
    // 让用户自己去找"右侧图片模块"。
    // 注意：前面调用的 resetImgCompare() 把对比区藏起来并清空了图片，
    // 必须把结果重新放回去，否则会显示"渲染完成"却看不到任何对比。
    imgPickPath = up.path;
    showImgCompare(rr.orig, rr.render, rr.renderedAbs || null, rr);
    $('imgStatus').textContent = `已渲染 ${rr.width}x${rr.height}（播放器 t=${t.toFixed(2)}s）— 拖动分界线对比`;
    if (window.uiShell) window.uiShell.showTab('image');
    if (window.uiOk) window.uiOk('单帧渲染完成，已切到「图片」查看对比');
    status.textContent = `${rr.width}x${rr.height} @ t=${t.toFixed(2)}s — 已渲染`;
  } catch (e) {
    status.textContent = '失败：' + e.message;
    logError('渲染当前帧失败：' + e.message);
  } finally {
    if (stopTick) stopTick();
    if (window.uiBusy) window.uiBusy(btn, false);
    stillLeave();
  }
});

// 鼠标横坐标 → 对比分隔位置，相对".img-stage"（画面真正占据的矩形）。
// 用外层盒子的矩形会在画面比盒子小时产生偏移（黑边导致的错位）。
function splitFromEvent(e, stage, setter) {
  const st = stage.getBoundingClientRect();
  if (st.width <= 0) return;
  const p = Math.min(1, Math.max(0, (e.clientX - st.left) / st.width));
  setter(p);
}
