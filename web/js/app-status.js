// 日志面板、状态轮询（poll / renderStatus）、任务提交与任务配置构建
//
// 与服务端的日志协议：`?since=` 传的是**绝对行序号**，不是数组下标。
// jobs.js 里 lines[] 上限 300 行，超了会 shift()；如果客户端拿"我已有多少行"
// 当下标用，一旦溢出就永远取不到新行（日志冻结），而新任务的前 N 行也会被吞掉。
// 服务端现在同时返回 lineFrom（lines[0] 的绝对序号）与 lineSeq（最新序号）。
//
// 轮询常驻：原来首个任务结束后会 clearInterval，导致队列/日志/进度条全部停摆，
// 而且服务端收不到 UI 心跳（60s 后认为页面已关闭并开始清理 .frame_previews，
// 于是已经渲染好、正在对比的图片会变成裂图）。

// ------------------------------------------------------------ floating log panel
let logSeen = 0;             // 已追加的**绝对**行序号（不是下标）
let logJobId = null;         // 当前跟踪的任务 id，用于识别"换了任务"
let logPanelFolded = true;   // 默认折叠，保持页面干净
let logSticky = true;        // 用户往上翻时不要强制回到底部
let logCountShown = 0;       // 面板里当前显示了多少行（仅用于计数显示）

const $log = $('logBody');
const $logCnt = $('logCount');
const $logPanel = $('logPanel');

function setLogFolded(folded) {
  logPanelFolded = folded;
  $logPanel.classList.toggle('folded', folded);
  $logPanel.classList.toggle('expanded', !folded);
  $('logToggleBtn').textContent = folded ? '▾' : '▴';
  if (window.uiShell && window.uiShell.syncLogAria) window.uiShell.syncLogAria();
}

// 统一的错误出口：写日志 **并且** 弹提示条。
// 原先错误只进右下角折叠的日志面板 —— 用户点了按钮却看不到任何反应。
function logError(msg, opts) {
  appendLogLines(['[UI] ' + msg]);
  setLogFolded(false);
  if (window.uiErr) window.uiErr(msg, opts);
}

function appendLogLines(lines) {
  if (!lines || !lines.length) return;
  // 一次拼成文本节点，避免逐行 DOM 追加造成的布局抖动
  const text = (logCountShown === 0 && !$log.textContent ? '' : '\n') + lines.join('\n');
  $log.appendChild(document.createTextNode(text));
  logCountShown += lines.length;
  $logCnt.textContent = String(logCountShown);
  if (logSticky) $log.scrollTop = $log.scrollHeight;
}

function clearLogPanel() {
  // 只清空"显示"，不动游标：否则下一次轮询会把整段缓冲重新灌回来（原来的 bug）
  $log.textContent = '';
  logCountShown = 0;
  $logCnt.textContent = '0';
}

$log.addEventListener('scroll', () => {
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
  const btn = $('logCopyBtn');
  try {
    await navigator.clipboard.writeText($log.textContent || '');
    btn.textContent = '已复制';
    setTimeout(() => { btn.textContent = '复制'; }, 1200);
  } catch (err) {
    btn.textContent = '失败';
    setTimeout(() => { btn.textContent = '复制'; }, 1200);
    logError('复制日志失败：' + err.message);
  }
});

setLogFolded(true);

// 常驻轮询定时器（保留 timer 这个名字，其它模块仍会引用）
let timer = null;
let pollBusy = false;        // 单飞：500ms 的间隔比请求还快时，避免响应乱序
let offlineStreak = 0;

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

// ------------------------------------------------------------ queue
let queueSnapshot = [];
function updateQueueBox(q) {
  const box = $('queueBox');
  if (!box) return;
  queueSnapshot = ((q && q.items) || []).slice();
  const items = queueSnapshot;
  if (!items.length) { box.style.display = 'none'; box.innerHTML = ''; box.dataset.key = ''; return; }
  box.style.display = '';
  const key = items.map((x) => x.id).join('|');
  if (key === (box.dataset.key || '')) return;   // 固定 FIFO，只有顺序真变了才重建
  box.dataset.key = key;

  const row = (it, i, n) =>
    '<div class="qrow" role="listitem">' +
      '<span class="qidx">' + (i + 1) + '</span>' +
      '<button class="btn icon" data-id="' + it.id + '" data-a="up" title="上移" aria-label="把第 ' + (i + 1) + ' 个任务上移"' + (i === 0 ? ' disabled' : '') + '>' +
        '<svg width="13" height="13" aria-hidden="true"><use href="#i-up"/></svg></button>' +
      '<button class="btn icon" data-id="' + it.id + '" data-a="dn" title="下移" aria-label="把第 ' + (i + 1) + ' 个任务下移"' + (i === n - 1 ? ' disabled' : '') + '>' +
        '<svg width="13" height="13" aria-hidden="true"><use href="#i-down"/></svg></button>' +
      '<span class="qlabel" title="' + escHtml(it.out) + '">' + escHtml(it.label) + '</span>' +
      (it.encoder ? '<span class="qenc">' + escHtml(it.encoder) + '</span>' : '') +
      '<button class="btn icon" data-id="' + it.id + '" data-a="del" title="从队列移除" aria-label="把第 ' + (i + 1) + ' 个任务移出队列">' +
        '<svg width="13" height="13" aria-hidden="true"><use href="#i-x"/></svg></button>' +
    '</div>';

  box.innerHTML = '<div role="list">' + items.map((it, k) => row(it, k, items.length)).join('') + '</div>';
  box.querySelectorAll('button[data-a]').forEach((b) => {
    b.addEventListener('click', async () => {
      const id = b.dataset.id, a = b.dataset.a;
      const path = a === 'del' ? '/api/queue-remove' : '/api/queue-move';
      const payload = a === 'del' ? { id } : { id, dir: a };
      try {
        const r = await fetch(path, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        }).then((x) => x.json());
        // 服务端的拒绝理由要显示出来：原来完全丢弃，点"✕"删一个正在跑的任务毫无反应
        if (r && r.ok === false && r.error) logError('队列操作失败：' + r.error);
        poll();
      } catch (e) {
        logError('队列操作失败：' + e.message);
      }
    });
  });
}

// ------------------------------------------------------------ status rendering
function renderStatus(s) {
  updateQueueBox(s.queue);

  $('startBtn').textContent = s.running ? '加入队列' : '开始处理';
  $('cancelBtn').disabled = !s.running;

  const nowF = $('nowFile');
  if (nowF) {
    if (s.running && s.output) {
      nowF.textContent = '正在渲染：' + String(s.output).split(/[\\/]/).pop();
      nowF.style.display = '';
    } else {
      nowF.style.display = 'none';
    }
  }

  // 每个完成的任务自动导入视频对比，用 lastDone.id 去重。首次轮询只记录不发。
  if (window.__vdSeenDone === undefined) {
    window.__vdSeenDone = (s.lastDone && s.lastDone.id) || null;
  } else if (window.vdCompare && s.lastDone && s.lastDone.code === 0 &&
             s.lastDone.id !== window.__vdSeenDone && s.lastDone.input && s.lastDone.output) {
    window.__vdSeenDone = s.lastDone.id;
    // 用户手动选过对比视频就不要再覆盖他正在看的东西
    const manual = window.__vdManual === true;
    if (!manual) window.vdCompare.autoload(s.lastDone.input, s.lastDone.output, s.lastDone.start || 0);
  }

  const doneF = s.overallDone || 0, totalF = s.overallTotal || 0;
  const pct = totalF > 0 ? Math.min(100, (doneF / totalF) * 100) : 0;
  const bar = $('bar');
  // 用 --p + transform: scaleX() 而不是 width：进度条只做合成，不触发布局
  bar.style.setProperty('--p', (pct / 100).toFixed(4));
  const pctEl = $('progPct');
  if (pctEl) pctEl.textContent = Math.round(pct) + '%';

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
      st.className = 'status is-done';
      if (s.output) showExportMsg('渲染完成，已保存至：' + s.output, false);
      showStats(totalF > 0
        ? `共 ${totalF} 帧 · 平均 ${fps.toFixed(1)} 帧/秒 · 用时 ${fmtDur(s.elapsedSec)}`
        : '');
    } else {
      st.textContent = `失败（结束码 ${s.code}）· 详情见日志`;
      st.className = 'status is-error';
      showStats('');
    }
  } else if (s.running) {
    const roundTxt = (s.passes || 1) > 1 ? `第 ${s.pass || 1}/${s.passes} 轮 · ` : '';
    st.textContent = totalF > 0 ? `${roundTxt}${doneF}/${totalF} 帧` : `${roundTxt}已渲染 ${doneF} 帧`;
    st.className = 'status is-running';
    showStats(fps > 0 && s.etaSec > 0
      ? `平均 ${fps.toFixed(1)} 帧/秒 · 剩余约 ${fmtDur(s.etaSec)}`
      : '正在统计速度…');
  } else {
    // 空闲：进度条要归零，否则上一次的 100% 会留在屏幕上，看起来像还在跑
    st.textContent = '空闲';
    st.className = 'status';
    showStats('');
    bar.style.setProperty('--p', '0');
    if (pctEl) pctEl.textContent = '0%';
  }

  // 顶栏胶囊 + 底部操作栏（切到别的模式也能看到渲染状态）
  if (window.uiStatus) window.uiStatus(s);
}

// ------------------------------------------------------------ polling
async function poll() {
  if (pollBusy) return;              // 上一次还没回来就跳过这一拍
  pollBusy = true;
  try {
    const requested = logSeen;
    const s = await fetch('/api/status?since=' + requested).then((x) => x.json());

    const id = s.id || null;
    const jobChanged = id !== null && id !== logJobId;
    const lineFrom = typeof s.lineFrom === 'number' ? s.lineFrom : 0;
    const lineSeq = typeof s.lineSeq === 'number' ? s.lineSeq : 0;
    const inRange = requested >= lineFrom && requested <= lineSeq;
    const sentWholeBuffer = !inRange && (s.lines || []).length > 0;

    if (jobChanged) {
      if (logCountShown > 0) appendLogLines([`────────  任务 #${id}  ────────`]);
      logJobId = id;
      logSeen = 0;
    } else if (sentWholeBuffer) {
      // 同一任务内落后超过缓冲上限：说明中间的行已被服务端丢弃，明确告知而不是静默断流
      appendLogLines(['……（日志产生过快，中间部分已被丢弃）']);
    }

    appendLogLines(s.lines);
    logSeen = lineSeq;

    renderStatus(s);
    offlineStreak = 0;
  } catch (e) {
    offlineStreak++;
    // 连续失败才提示，避免渲染期间一次抖动就弹窗
    if (offlineStreak === 4) logError('与本地服务的连接中断，正在重试…（' + e.message + '）');
  } finally {
    pollBusy = false;
  }
}

// 常驻：页面开着就一直轮询。既是 UI 数据来源，也是服务端判断"页面还在"的心跳。
function startPolling() {
  if (timer) return;
  timer = setInterval(poll, 800);
  poll();
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

// 图片单张/批量与视频共用同一套调参，但「渲染次数」各自独立（imgRenderPasses）。
// 注意：播放器的「渲染当前帧并对比」不走这里 —— 它截的是视频帧，用的是视频板的渲染次数。
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

// ------------------------------------------------------------ submit
let submitting = false;

$('startBtn').addEventListener('click', async () => {
  if (submitting) return;                    // 双击不再提交两个相同任务
  const input = $('input').value.trim();
  if (!input) {
    logError('请先选择或填写输入视频');
    $('input').focus();
    return;
  }
  const st = parseFloat($('startTime').value) || 0;
  const et = parseFloat($('endTime').value) || 0;
  if (st < 0 || et < 0) {
    logError('开始 / 结束时间不能为负数');
    $('startTime').focus();
    return;
  }
  if (et > 0 && et <= st) {
    logError('结束时间必须大于开始时间（当前 ' + st + 's → ' + et + 's）');
    $('endTime').focus();
    return;
  }

  const body = Object.assign({
    input,
    output: $('output').value.trim(),
    fileName: $('exportName').value.trim(),
    startTime: st,
    endTime: et,
  }, buildJobCfg());

  submitting = true;
  const btn = $('startBtn');
  if (window.uiBusy) window.uiBusy(btn, true);

  // 提交前先把上一轮的状态清干净（原来会残留上一次的 100% 和"渲染完成"配色）
  $('exportMsg').style.display = 'none';
  const stEl = $('statusText');
  stEl.textContent = '正在提交…';
  stEl.className = 'status is-running';
  $('bar').style.setProperty('--p', '0');
  const pctEl = $('progPct');
  if (pctEl) pctEl.textContent = '0%';
  // 停止按钮要等任务真的存在了再可用，否则会去取消一个还不存在的任务
  $('cancelBtn').disabled = true;

  try {
    const r = await fetch('/api/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((x) => x.json());

    if (!r.ok) {
      stEl.textContent = '提交失败';
      stEl.className = 'status is-error';
      logError('提交失败：' + (r.error || '未知原因'));
      return;
    }
    if (r.output) {
      window.__vdOrig = input;
      window.__vdStart = st;
    }
    if (r.state === 'queued') {
      stEl.textContent = '已加入队列（第 ' + r.id + ' 个，前方还有 ' + Math.max(0, (r.queueLen || 1) - 1) + ' 个任务）';
      stEl.className = 'status';
      if (window.uiToast) window.uiToast('已加入渲染队列：' + (r.output || ''), 'info');
    } else {
      stEl.textContent = '渲染中…';
      stEl.className = 'status is-running';
    }
    startPolling();
    poll();
  } catch (e) {
    stEl.textContent = '提交失败';
    stEl.className = 'status is-error';
    logError('提交失败：' + e.message);
  } finally {
    submitting = false;
    if (window.uiBusy) window.uiBusy(btn, false);
  }
});

$('cancelBtn').addEventListener('click', async () => {
  const btn = $('cancelBtn');
  if (window.uiBusy) window.uiBusy(btn, true);
  try {
    const r = await fetch('/api/cancel', { method: 'POST' }).then((x) => x.json());
    if (r && r.ok) {
      if (window.uiToast) window.uiToast('已请求停止，正在收尾…', 'warn');
    } else {
      logError('停止失败：' + ((r && r.error) || '未知原因'));
    }
  } catch (e) {
    logError('停止失败：' + e.message);
  } finally {
    if (window.uiBusy) window.uiBusy(btn, false);
    poll();
  }
});

$('exitBtn').addEventListener('click', async () => {
  const ok = window.uiConfirm
    ? await window.uiConfirm('退出程序？', '会立即停止当前渲染、清空临时缓存并结束本程序，本页面也会失效。', '退出')
    : window.confirm('退出将立即停止当前渲染、清空缓存、结束本程序并关闭本页面，确定退出吗？');
  if (!ok) return;

  const btn = $('exitBtn');
  if (window.uiBusy) window.uiBusy(btn, true);
  let exited = false;
  try {
    const r = await fetch('/api/exit', { method: 'POST' }).then((x) => x.json());
    exited = !!(r && r.ok);
  } catch (e) {
    // 进程可能已经先退出，连接被断开 —— 这其实也算成功
    exited = true;
  }
  if (!exited) {
    if (window.uiBusy) window.uiBusy(btn, false);
    logError('退出失败：服务未确认退出，可以再试一次');
    return;
  }
  $('startBtn').disabled = true;
  $('cancelBtn').disabled = true;
  try { window.close(); } catch (e) { /* ignore */ }
  setTimeout(() => {
    const st = $('statusText');
    st.textContent = '已退出（页面没有自动关闭时请手动关闭本窗口）';
    st.className = 'status is-done';
  }, 700);
});

// 页面开着就一直轮询（首屏即开始，这样服务端从第一秒就能看到 UI 心跳）
startPolling();
