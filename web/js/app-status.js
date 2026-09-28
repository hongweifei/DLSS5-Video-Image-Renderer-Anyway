// 日志面板、状态轮询（poll/renderStatus）、任务配置构建
// 日志面板、状态轮询（poll/renderStatus）、任务配置构建 — 见文件内注释
//
// 由 tools/split-web.js 从原 index.html 的内联 <script> 机械拆分而成：
// 分块连续且顺序不变，因此执行语义与拆分前完全一致。
// 全部文件共享同一全局作用域（非 ES module），互相可以直接引用。

// ------------------------------------------------------------ floating log panel
let logSeen = 0;             // number of log lines we have already appended
let logPanelFolded = true;   // start folded so the page stays clean
let logSticky = true;        // auto-scroll to bottom unless the user has scrolled away

const $log = $('logBody');
const $logCnt = $('logCount');
const $logPanel = $('logPanel');

function setLogFolded(folded) {
  logPanelFolded = folded;
  $logPanel.classList.toggle('folded', folded);
  $logPanel.classList.toggle('expanded', !folded);
  $('logToggleBtn').textContent = folded ? '▾' : '▴';
}

// Surface an inline UI error in the floating log instead of next to the file picker.
function logError(msg) {
  appendLogLines(['[UI] ' + msg]);
  setLogFolded(false);
}

function appendLogLines(lines) {
  if (!lines || !lines.length) return;
  // Build a text node in one shot to avoid layout thrash from per-line DOM appends.
  const text = (logSeen === 0 && !$log.textContent ? '' : '\n') + lines.join('\n');
  $log.appendChild(document.createTextNode(text));
  logSeen += lines.length;
  $logCnt.textContent = String(logSeen);
  if (logSticky) $log.scrollTop = $log.scrollHeight;
}

function clearLogPanel() {
  $log.textContent = '';
  logSeen = 0;
  $logCnt.textContent = '0';
}

$log.addEventListener('scroll', () => {
  // Resume auto-scroll only when the user is at (or within 8px of) the bottom.
  logSticky = ($log.scrollHeight - $log.scrollTop - $log.clientHeight) <= 8;
});

['logHead', 'logToggleBtn'].forEach((id) => {
  $(id).addEventListener('click', (e) => {
    if (id === 'logToggleBtn') e.stopPropagation();
    setLogFolded(!logPanelFolded);
  });
});

$('logClearBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  clearLogPanel();
});

$('logCopyBtn').addEventListener('click', async (e) => {
  e.stopPropagation();
  try {
    await navigator.clipboard.writeText($log.textContent || '');
    const old = $('logCopyBtn').textContent;
    $('logCopyBtn').textContent = '已复制';
    setTimeout(() => { $('logCopyBtn').textContent = old; }, 1200);
  } catch (err) {
    $('logCopyBtn').textContent = '失败';
    setTimeout(() => { $('logCopyBtn').textContent = '复制'; }, 1200);
  }
});

setLogFolded(true);

let timer = null;

function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

function escHtml(t) {
  return String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}
// Renders the pending render queue from /api/status -> queue.
let queueSnapshot = [];
function updateQueueBox(q) {
  const box = $('queueBox');
  if (!box) return;
  queueSnapshot = ((q && q.items) || []).slice();
  const items = queueSnapshot;
  if (!items.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
  box.style.display = '';
  const key = items.map((x) => x.id).join('|');
  if (key === (box.dataset.key || '')) return;   // fixed FIFO + ▲/▼ reorder; skip pointless rebuilds
  box.dataset.key = key;
  const act = (it, first, last) =>
    '<div style="display:flex; gap:4px; align-items:center; padding:2px 0; border-top:1px solid var(--line);">' +
    '<button class="btn" style="padding:0 6px; font-size:11px;" data-id="' + it.id + '" data-a="up" ' + (first ? 'disabled' : '') + '>▲</button>' +
    '<button class="btn" style="padding:0 6px; font-size:11px;" data-id="' + it.id + '" data-a="dn" ' + (last ? 'disabled' : '') + '>▼</button>' +
    '<span style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="' + escHtml(it.out) + '">' + escHtml(it.label) + '</span>' +
    '<button class="btn" style="padding:0 6px; font-size:11px;" data-id="' + it.id + '" data-a="del">✕</button></div>';
  box.innerHTML = items.map((it, k) => act(it, k === 0, k === items.length - 1)).join('');
  box.querySelectorAll('button[data-a]').forEach((b) => {
    b.addEventListener('click', async () => {
      const id = b.dataset.id, a = b.dataset.a;
      const p = a === 'del'
        ? '/api/queue-remove'
        : '/api/queue-move';
      const body = a === 'del' ? { id } : { id, dir: a };
      await fetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      poll();
    });
  });
}
function renderStatus(s) {
  updateQueueBox(s.queue);
  $('startBtn').textContent = s.running ? '加入队列' : '开始处理';
  $('cancelBtn').disabled = !s.running;
  // "正在渲染: <file>" next to the progress bar
  const nowF = $('nowFile');
  if (nowF) {
    if (s.running && s.output) {
      nowF.textContent = '正在渲染: ' + String(s.output).split(/[\\/]/).pop();
      nowF.style.display = '';
    } else {
      nowF.style.display = 'none';
    }
  }
  // Import each finished (queue) job into the video compare as it completes. lastDone.id lets us
  // dedupe; the very first poll after a page load only records it (no surprise re-import of old
  // results), afterwards every new finished job auto-loads its own pair + window start.
  if (window.__vdSeenDone === undefined) {
    window.__vdSeenDone = (s.lastDone && s.lastDone.id) || null;
  } else if (window.vdCompare && s.lastDone && s.lastDone.code === 0 &&
             s.lastDone.id !== window.__vdSeenDone && s.lastDone.input && s.lastDone.output) {
    window.__vdSeenDone = s.lastDone.id;
    window.vdCompare.autoload(s.lastDone.input, s.lastDone.output, s.lastDone.start || 0);
  }
  const doneF = s.overallDone || 0, totalF = s.overallTotal || 0;
  const pct = totalF > 0 ? Math.min(100, (doneF / totalF) * 100) : 0;
  $('bar').style.width = pct + '%';

  const st = $('statusText');
  const ps = $('progStats');
  const fps = s.avgFps || 0;
  const showStats = (txt) => {
    ps.textContent = txt || '';
    ps.style.display = txt ? '' : 'none';
  };

  if (s.finished) {
    if (s.code === 0) {
      st.textContent = '渲染完成';
      st.className = 'status done';
      if (s.output) {
        showExportMsg('渲染完成，视频已保存至：' + s.output, false);
      }

      showStats(totalF > 0
        ? `共 ${totalF} 帧 · 平均 ${fps.toFixed(1)} 帧/秒 · 用时 ${fmtDur(s.elapsedSec)}`
        : '');
    } else {
      st.textContent = `结束码 ${s.code} · 见日志`;
      st.className = 'status err';
      showStats('');
    }
  } else if (s.running) {
    // Whole-video multi-pass: "第 n/m 轮,第 a/b 帧" with an overall (not per-pass) bar.
    const roundTxt = (s.passes || 1) > 1 ? `第 ${s.pass || 1}/${s.passes} 轮,` : '';
    st.textContent = totalF > 0
      ? `${roundTxt}第 ${doneF}/${totalF} 帧`
      : `${roundTxt}渲染中 ${doneF} 帧`;
    st.className = 'status';
    showStats(fps > 0 && s.etaSec > 0
      ? `平均 ${fps.toFixed(1)} 帧/秒 · 剩余约 ${fmtDur(s.etaSec)}`
      : '统计中…');
  } else {
    // idle: nothing transient to show
    showStats('');
  }
}

async function poll() {
  try {
    const s = await fetch('/api/status?since=' + logSeen).then((x) => x.json());
    appendLogLines(s.lines);
    renderStatus(s);
    if (!s.running && s.finished) {
      clearInterval(timer); timer = null;
      $('startBtn').disabled = false;
      $('cancelBtn').disabled = true;
    }
  } catch (e) { /* transient */ }
}

function buildJobCfg() {
    return {
        model: $('model').value,
        intensity: parseFloat($('intensity').value),
        localTone: parseFloat($('localTone').value),
        localStructure: parseFloat($('localStructure').value),
        skinStructure: parseFloat($('skinStructure').value),
        encoder: $('encoder').value,
        gpuIdx: parseInt($('gpuSel').value, 10) || -1,
        preset: parseInt($('preset').value, 10),
        style: parseInt($('style').value, 10),
        autoMask: $('autoMask').checked ? 1 : 0,
        uiCorrection: $('uiCorrection').checked ? 1 : 0,
        residualMult: parseFloat($('residualMult_n').value) || 1.0,
        frameGuidance: $('flowEnable').checked ? 3 : 0,
        mvecQuality: parseInt($('mvecQuality').value, 10) || 2,
        depthInterval: parseInt($('depthInterval').value, 10) || 0,
        renderPasses: Math.max(1, parseInt($('renderPasses').value, 10) || 1),
    };
}

// Still-image single/batch jobs ("渲染此图" + the folder batch) share the video-tuning
// parameters but carry their OWN 渲染次数 (imgRenderPasses), so the whole-video 渲染次数 and
// the image module's are independent controls. Note: the player's "快速渲染当前帧" is NOT
// routed through here — it snapshots the video frame and therefore uses the VIDEO board's
// 渲染次数 (buildJobCfg) instead.
function imgJobCfg() {
  const o = buildJobCfg();
  o.renderPasses = Math.max(1, parseInt($('imgRenderPasses').value, 10) || 1);
  return o;
}

function showExportMsg(text, isErr) {
  const m = $('exportMsg');
  m.textContent = text;
  m.className = isErr ? 'status err' : 'status done';
  m.style.display = '';
}

$('startBtn').addEventListener('click', async () => {
  const input = $('input').value.trim();
  if (!input) {
    alert('请选择或填写输入视频');
    return;
  }
  // Render-window guard: never start a job with an illegal range (end must be > start).
  const st = parseFloat($('startTime').value) || 0;
  const et = parseFloat($('endTime').value) || 0;
  if (st < 0 || et < 0) {
    alert('开始/结束时间不能为负数');
    return;
  }
  if (et > 0 && et <= st) {
    alert('结束时间必须大于开始时间（当前：' + st + 's → ' + et + 's）');
    $('endTime').focus();
    return;
  }

  const body = Object.assign({
    input,
    output: $('output').value.trim(),   // 文件夹；留空 = <项目根>/outputs/
    fileName: $('exportName').value.trim(), // 留空 = 默认名（nr_ 前缀）
    startTime: st,
    endTime: et,
  }, buildJobCfg());

  $('exportMsg').style.display = 'none';
  $('statusText').textContent = '提交中…';
  $('cancelBtn').disabled = false;

  const r = await fetch('/api/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((x) => x.json());

  if (r.ok && r.output) {
    // remember the pair (and the render start) for the video compare module
    window.__vdOrig = input;
    window.__vdStart = st;
    window.__vdAutoDone = false;
  }
  if (r.ok) {
    if (r.state === 'queued') {
      $('statusText').textContent = '已加入渲染队列 #' + r.id + '（前方还有 ' + Math.max(0, (r.queueLen || 1) - 1) + ' 个任务，按各自参数依次渲染）';
      $('statusText').className = 'status';
    } else if (r.state === 'running') {
      $('statusText').textContent = '渲染中…';
    }
  } else {
    $('statusText').textContent = '提交失败: ' + (r.error || '?');
    $('statusText').className = 'status err';
    return;
  }
  if (timer) clearInterval(timer);
  timer = setInterval(poll, 500);
  poll();
});

$('cancelBtn').addEventListener('click', async () => {
  await fetch('/api/cancel', { method: 'POST' });
  $('cancelBtn').disabled = true;
});

$('exitBtn').addEventListener('click', async () => {
  if (!confirm('退出将立即停止当前渲染、清空缓存、结束本程序并关闭本页面，确定退出吗？')) return;
  $('exitBtn').disabled = true;
  $('startBtn').disabled = true;
  $('cancelBtn').disabled = true;
  try { await fetch('/api/exit', { method: 'POST' }); } catch (e) { /* process already going down */ }
  // Auto-close the web page (works when the tab was script-opened); otherwise show a hint.
  try { window.close(); } catch (e) { /* ignore */ }
  setTimeout(() => {
    $('statusText').textContent = '已正常退出（页面未自动关闭时请手动关闭本窗口）';
  }, 700);
});

