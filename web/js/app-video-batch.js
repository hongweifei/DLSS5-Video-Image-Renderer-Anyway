// 视频批量渲染与显卡列表加载
// 视频批量渲染与显卡列表加载 — 见文件内注释
//
// 由 tools/split-web.js 从原 index.html 的内联 <script> 机械拆分而成：
// 分块连续且顺序不变，因此执行语义与拆分前完全一致。
// 全部文件共享同一全局作用域（非 ES module），互相可以直接引用。

// ---------------------------------------------------------------- video batch render
let vbBusy = false;

function vbSetStart() { $('vbStart').disabled = vbBusy || !$('vbSrc').value.trim(); }

$('vbPickSrc').addEventListener('click', async () => {
  if (vbBusy) return;
  const pk = await fetch('/api/pick-folder').then((x) => x.json());
  if (!pk.ok) { if (!pk.cancelled) $('vbInfo').textContent = '选择失败: ' + (pk.error || '?'); return; }
  const base = pk.dir.replace(/[\\/]+$/, '');
  const sep = pk.dir.indexOf('\\') >= 0 ? '\\' : '/';
  $('vbSrc').value = pk.dir;
  $('vbOut').value = base + sep + 'nr_' + base.split(/[\\\/]/).pop();
  $('vbInfo').textContent = '已选输入文件夹：' + pk.dir;
  vbSetStart();
});
$('vbPickOut').addEventListener('click', async () => {
  if (vbBusy) return;
  const pk = await fetch('/api/pick-folder').then((x) => x.json());
  if (!pk.ok) { if (!pk.cancelled) $('vbInfo').textContent = '选择失败: ' + (pk.error || '?'); return; }
  $('vbOut').value = pk.dir;
  $('vbInfo').textContent = '已选输出文件夹：' + pk.dir;
});
$('vbSrc').addEventListener('input', vbSetStart);

// Start: every video found under 输入路径 is enqueued with the CURRENT render params snapshot.
$('vbStart').addEventListener('click', async () => {
  if (vbBusy) return;
  const src = $('vbSrc').value.trim();
  if (!src) { $('vbInfo').textContent = '请先选择输入文件夹'; return; }
  vbBusy = true;
  $('vbStart').disabled = true;
  const body = {
    inputDir: src,
    outDir: $('vbOut').value.trim(),
    jobCfg: Object.assign({}, buildJobCfg(), { encoder: $('encoder').value }),
  };
  $('vbInfo').textContent = '正在扫描视频并加入队列…';
  const r = await fetch('/api/video-batch', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then((x) => x.json());
  if (!r.ok) {
    $('vbInfo').textContent = '失败：' + (r.error || '?');
  } else {
    $('vbInfo').textContent = '已加入队列 ' + r.pushed + '/' + r.total + ' 个视频 → ' + r.outDir +
      (r.failed && r.failed.length ? '（失败 ' + r.failed.length + '）' : '');
    // Start the shared queue/progress poller: a pure batch never went through 开始处理, so the
    // 500ms poll that renders 队列 rows + the progress bar may not be running yet.
    if (typeof timer !== 'undefined') {
      if (timer) clearInterval(timer);
      timer = setInterval(poll, 500);
    }
    poll();
  }
  vbBusy = false;
  vbSetStart();
});

// Populate the GPU selector from the engine's own enumeration.
async function gpuLoad() {
  const sel = $('gpuSel');
  if (!sel) return;
  try {
    const r = await fetch('/api/gpus').then((x) => x.json());
    if (r && r.gpus) {
      for (const g of r.gpus) {
        const o = document.createElement('option');
        o.value = String(g.idx);
        o.textContent = g.idx + ': ' + g.name;
        sel.appendChild(o);
      }
    }
  } catch (e) { /* engine not available yet */ }
}
gpuLoad();

