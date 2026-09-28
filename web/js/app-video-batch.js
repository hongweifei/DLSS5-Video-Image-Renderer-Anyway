// 视频批量渲染与显卡列表加载

// ---------------------------------------------------------------- video batch
let vbBusy = false;

function vbSetStart() {
  $('vbStart').disabled = vbBusy || !$('vbSrc').value.trim();
}

$('vbPickSrc').addEventListener('click', async () => {
  if (vbBusy) return;
  const btn = $('vbPickSrc');
  if (window.uiBusy) window.uiBusy(btn, true);
  try {
    const pk = await fetch('/api/pick-folder').then((x) => x.json());
    if (!pk.ok) {
      if (!pk.cancelled) logError('选择文件夹失败：' + (pk.error || '未知原因'));
      return;
    }
    const base = pk.dir.replace(/[\\/]+$/, '');
    const sep = pk.dir.indexOf('\\') >= 0 ? '\\' : '/';
    $('vbSrc').value = pk.dir;
    $('vbOut').value = base + sep + 'nr_' + base.split(/[\\\/]/).pop();
    $('vbInfo').textContent = '输入文件夹：' + pk.dir;
    vbSetStart();
  } catch (e) {
    logError('选择文件夹失败：' + e.message);
  } finally {
    if (window.uiBusy) window.uiBusy(btn, false);
  }
});

$('vbPickOut').addEventListener('click', async () => {
  if (vbBusy) return;
  const btn = $('vbPickOut');
  if (window.uiBusy) window.uiBusy(btn, true);
  try {
    const pk = await fetch('/api/pick-folder').then((x) => x.json());
    if (!pk.ok) {
      if (!pk.cancelled) logError('选择文件夹失败：' + (pk.error || '未知原因'));
      return;
    }
    $('vbOut').value = pk.dir;
    $('vbInfo').textContent = '输出文件夹：' + pk.dir;
  } catch (e) {
    logError('选择文件夹失败：' + e.message);
  } finally {
    if (window.uiBusy) window.uiBusy(btn, false);
  }
});

$('vbSrc').addEventListener('input', vbSetStart);

// 开始：把输入路径下找到的每个视频，带着**当前**渲染参数的快照推进队列。
// 忙碌标志用 try/finally 复位 —— 原来只在成功路径复位，一次网络抖动就会让
// 「开始视频批量」永久灰掉，只能刷新页面。
$('vbStart').addEventListener('click', async () => {
  if (vbBusy) return;
  const src = $('vbSrc').value.trim();
  if (!src) {
    logError('请先选择输入文件夹');
    return;
  }
  const btn = $('vbStart');
  vbBusy = true;
  if (window.uiBusy) window.uiBusy(btn, true);
  $('vbInfo').textContent = '正在扫描视频并加入队列…';
  try {
    const body = {
      inputDir: src,
      outDir: $('vbOut').value.trim(),
      jobCfg: Object.assign({}, buildJobCfg(), { encoder: $('encoder').value }),
    };
    const r = await fetch('/api/video-batch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).then((x) => x.json());
    if (!r.ok) {
      $('vbInfo').textContent = '失败';
      logError('视频批量失败：' + (r.error || '未知原因'));
      return;
    }
    const failed = (r.failed && r.failed.length) ? '，失败 ' + r.failed.length : '';
    $('vbInfo').textContent = '已加入队列 ' + r.pushed + '/' + r.total + ' 个视频 → ' + r.outDir + failed;
    if (window.uiToast) {
      window.uiToast('已加入队列 ' + r.pushed + ' 个视频（共扫描到 ' + r.total + ' 个）' + failed,
        r.failed && r.failed.length ? 'warn' : 'ok');
    }
    // 队列 / 进度条由常驻轮询负责刷新，这里补一次立即更新
    poll();
  } catch (e) {
    $('vbInfo').textContent = '失败';
    logError('视频批量失败：' + e.message);
  } finally {
    vbBusy = false;
    if (window.uiBusy) window.uiBusy(btn, false);
    vbSetStart();
  }
});

// ---------------------------------------------------------------- GPU 列表
// 失败要说话：原实现静默失败，显卡下拉里永远只剩"自动"，用户无从知道引擎没跑起来。
async function gpuLoad() {
  const sel = $('gpuSel');
  if (!sel) return;
  try {
    const r = await fetch('/api/gpus').then((x) => x.json());
    if (!r || !r.gpus) return;
    if (!r.gpus.length) {
      $('gpuSel').title = '没有枚举到可用显卡；无 N 卡时会自动走 ONNX 重建模型';
      return;
    }
    // 保留"自动"作为第一项
    for (const g of r.gpus) {
      const o = document.createElement('option');
      o.value = String(g.idx);
      o.textContent = g.idx + '：' + g.name;
      sel.appendChild(o);
    }
    // 列表是异步拉回来的，而参数恢复在脚本加载时就跑完了 —— 那时还没有这些 option，
    // 保存过的显卡选择会被 applyParamTo 丢掉。列表就绪后补一次。
    try {
      const saved = JSON.parse(localStorage.getItem('dlss5nr.params.v1') || 'null');
      if (saved && saved.v === 1 && saved.gpuSel != null) sel.value = String(saved.gpuSel);
    } catch (e) { /* ignore */ }
  } catch (e) {
    logError('枚举显卡失败：' + e.message + '（会使用自动选择）');
  }
}
gpuLoad();
