// 参数持久化、渲染参数恢复、撤销/重做、命名预设
// 参数持久化、渲染参数恢复、撤销/重做、命名预设 — 见文件内注释
//
// 由 tools/split-web.js 从原 index.html 的内联 <script> 机械拆分而成：
// 分块连续且顺序不变，因此执行语义与拆分前完全一致。
// 全部文件共享同一全局作用域（非 ES module），互相可以直接引用。

// ---------------------------------------------------------------- persist params
// Model / render parameters are remembered across page reloads (localStorage), so reopening the
// page keeps the previous tuning instead of resetting to defaults. Only "parameter" controls are
// persisted: file paths and the trim start/end belong to one specific job and are left out (a new
// input resets the range anyway).
const LS_PARAMS_KEY = 'dlss5nr.params.v1';
const PARAM_IDS = [
  'model', 'preset', 'style',
  'intensity', 'localTone', 'localStructure', 'skinStructure',
  'autoMask', 'uiCorrection', 'residualMult',
  'flowEnable', 'mvecQuality', 'depthInterval',
  'encoder', 'renderPasses',
];

function persistParams() {
  try {
    const o = { v: 1 };
    for (const id of PARAM_IDS) {
      const el = $(id);
      if (!el) continue;
      o[id] = (el.type === 'checkbox') ? el.checked : el.value;
    }
    localStorage.setItem(LS_PARAMS_KEY, JSON.stringify(o));
  } catch (e) { /* storage disabled / full: ignore */ }
}

function applyParamTo(id, val) {
  const el = $(id);
  if (!el) return;
  if (el.type === 'checkbox') {
    el.checked = !!val;
    return;
  }
  const asStr = String(val);
  if (el.tagName === 'SELECT' && ![].some.call(el.options, (op) => op.value === asStr)) return;
  el.value = asStr;
  const twin = $(id + '_n'); // slider + number pair: keep the number box in sync too
  if (twin && twin.type === 'number' && el.type === 'range') twin.value = asStr;
}

function restoreParams() {
  let o = null;
  try { o = JSON.parse(localStorage.getItem(LS_PARAMS_KEY) || 'null'); } catch (e) {}
  if (!o || o.v !== 1) return;
  for (const id of PARAM_IDS) if (id in o) applyParamTo(id, o[id]);
}

PARAM_IDS.forEach((id) => {
  const el = $(id);
  if (!el) return;
  const save = () => persistParams();
  el.addEventListener('input', save);
  el.addEventListener('change', save);
});
restoreParams();

// ---------------------------------------------------------------- meta 恢复 + 参数撤销/重做
// The engine stamps finished mp4/png/jpg with the render parameters ("render_cfg=" payload).
// Dropping such a file restores those settings instantly (no confirmation — the user asked for
// it by dropping). An undo/redo stack records parameter-set changes so a mistaken restore can
// be rolled back with Ctrl+Z / Ctrl+Y.
// Mapping between the meta JSON keys (engine whitelist) and the UI control ids. frameGuidance
// drives the flowEnable checkbox; keys with no UI control are ignored on restore.
const META_TO_UI = {
  preset: 'preset', style: 'style',
  intensity: 'intensity', localTone: 'localTone', localStructure: 'localStructure',
  skinStructure: 'skinStructure', autoMask: 'autoMask', uiCorrection: 'uiCorrection',
  residualMult: 'residualMult', mvecQuality: 'mvecQuality', depthInterval: 'depthInterval',
};

let paramHistory = [];    // snapshots (oldest first); newest at the end
let historyIndex = -1;    // index of the current state within paramHistory
const HISTORY_MAX = 24;

function snapshotParams() {
  const o = {};
  for (const id of PARAM_IDS) {
    const el = $(id);
    if (!el) continue;
    o[id] = (el.type === 'checkbox') ? el.checked : el.value;
  }
  return o;
}

function pushHistory() {
  const snap = snapshotParams();
  // Drop any redo tail (a new change after undo invalidates the redo branch).
  paramHistory = paramHistory.slice(0, historyIndex + 1);
  paramHistory.push(snap);
  if (paramHistory.length > HISTORY_MAX) paramHistory.shift();
  historyIndex = paramHistory.length - 1;
  syncHistoryBtns();
}

function applySnapshot(snap) {
  if (!snap) return;
  for (const id of PARAM_IDS) if (id in snap) applyParamTo(id, snap[id]);
}

function undoParams() {
  if (historyIndex <= 0) return;
  historyIndex--;
  applySnapshot(paramHistory[historyIndex]);
  persistParams();
  syncHistoryBtns();
}

function redoParams() {
  if (historyIndex < 0 || historyIndex >= paramHistory.length - 1) return;
  historyIndex++;
  applySnapshot(paramHistory[historyIndex]);
  persistParams();
  syncHistoryBtns();
}

function syncHistoryBtns() {
  $('metaUndoBtn').disabled = historyIndex <= 0;
  $('metaRedoBtn').disabled = historyIndex < 0 || historyIndex >= paramHistory.length - 1;
}

$('metaUndoBtn').addEventListener('click', undoParams);
$('metaRedoBtn').addEventListener('click', redoParams);
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); undoParams(); }
  else if (e.ctrlKey && e.shiftKey && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); redoParams(); }
  else if (e.ctrlKey && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); redoParams(); }
});
pushHistory();   // baseline state

// Record a history step on slider/number/checkbox changes (input events during dragging would
// flood the stack, so only the settled change is recorded).
PARAM_IDS.forEach((id) => {
  const el = $(id);
  if (!el) return;
  el.addEventListener('change', pushHistory);
});

// Apply a decoded meta JSON to the UI controls, then snapshot the new state as one undo step.
function applyRenderMeta(meta) {
  for (const [k, id] of Object.entries(META_TO_UI)) {
    if (k in meta) applyParamTo(id, meta[k]);
  }
  if ('frameGuidance' in meta) applyParamTo('flowEnable', meta.frameGuidance !== 0);
  persistParams();
  pushHistory();
}

async function metaDropFile(file) {
  const okExt = /\.(mp4|mkv|mov|m4v|png|jpe?g)$/i.test(file.name);
  if (!okExt) {
    showMetaMsg('仅支持本软件输出的 mp4/mkv/png/jpg', true);
    return;
  }
  try {
    const up = await fetch('/api/upload', {
      method: 'POST',
      headers: { 'X-Filename': encodeURIComponent(file.name) },
      body: file,
    }).then((x) => x.json());
    if (!up.ok || !up.path) throw new Error(up.error || '上传失败');
    const r = await fetch('/api/read-meta', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: up.path }),
    }).then((x) => x.json());
    if (!r.ok || !r.found || !r.meta) {
      showMetaMsg('该文件未包含渲染参数（可能不是本软件输出的）', true);
      return;
    }
    applyRenderMeta(r.meta);
    const summ = Object.entries(r.meta)
      .filter(([k]) => META_TO_UI[k] || k === 'frameGuidance')
      .map(([k, v]) => k + '=' + v).join('  ');
    showMetaMsg('✅ 已恢复参数：' + summ, false);
  } catch (e) {
    showMetaMsg('恢复失败: ' + e.message, true);
  }
}

function showMetaMsg(text, isErr) {
  const m = $('metaDropMsg');
  m.textContent = text;
  m.style.color = isErr ? '#c44' : '#3a8a4a';
  m.style.display = '';
  setTimeout(() => { m.style.display = 'none'; }, 6000);
}

const metaDrop = $('metaDrop');
['dragenter', 'dragover'].forEach((ev) => metaDrop.addEventListener(ev, (e) => {
  e.preventDefault(); e.stopPropagation(); metaDrop.style.borderColor = '#4a9';
}));
['dragleave', 'drop'].forEach((ev) => metaDrop.addEventListener(ev, (e) => {
  e.preventDefault(); e.stopPropagation(); metaDrop.style.borderColor = '';
}));
metaDrop.addEventListener('drop', (e) => {
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) metaDropFile(f);
});
metaDrop.addEventListener('click', () => {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.mp4,.mkv,.mov,.m4v,.png,.jpg,.jpeg';
  inp.onchange = () => { if (inp.files && inp.files[0]) metaDropFile(inp.files[0]); };
  inp.click();
});

// ---------------------------------------------------------------- named presets
// User-saved snapshots of the 参数设置 card ONLY (encoder belongs to 输出设置 and is not part
// of a preset). They live in localStorage under their own key, separate from the automatic
// "remember last tuning" (restoreParams/persistParams) above, so the two mechanisms coexist:
// opening the page still restores the last-used tuning, and presets add named save/load/delete.
const LS_PRESETS_KEY = 'dlss5nr.presets.v1';
const PRESET_IDS = PARAM_IDS.filter((id) => id !== 'encoder');
let presetCurrent = '';   // currently selected preset name (driven by the custom dropdown)

function presetCollect() {
  const o = {};
  for (const id of PRESET_IDS) {
    const el = $(id);
    if (!el) continue;
    o[id] = (el.type === 'checkbox') ? el.checked : el.value;
  }
  return o;
}

function presetLoadAll() {
  try { return JSON.parse(localStorage.getItem(LS_PRESETS_KEY) || '[]') || []; }
  catch (e) { return []; }
}

function presetStoreAll(list) {
  try { localStorage.setItem(LS_PRESETS_KEY, JSON.stringify(list)); }
  catch (e) { logError('无法保存预设: ' + e.message); }
}

function refreshPresetList() {
  const list = presetLoadAll();
  const label = $('presetListLabel');
  if (!list.length) {
    presetCurrent = '';
    label.textContent = '（暂无预设）';
  } else if (presetCurrent && list.some((x) => x.n === presetCurrent)) {
    label.textContent = presetCurrent;
  } else {
    presetCurrent = '';
    label.textContent = '选择预设…';
  }
  presetRenderMenu(list);
  $('presetLoadBtn').disabled = !presetCurrent;
  $('presetDelBtn').disabled = !presetCurrent;
}

function presetRenderMenu(items) {
  const menu = $('presetListMenu');
  menu.innerHTML = '';
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'item empty';
    li.textContent = '（暂无预设）';
    menu.appendChild(li);
    return;
  }
  for (const it of items) {
    const li = document.createElement('li');
    li.className = 'item';
    li.dataset.name = it.n;
    li.textContent = it.n;
    if (it.n === presetCurrent) li.classList.add('active');
    li.addEventListener('click', () => {
      presetCurrent = it.n;
      $('presetListMenu').classList.remove('open');
      refreshPresetList();
    });
    menu.appendChild(li);
  }
}

$('presetSaveBtn').addEventListener('click', () => {
  const typed = $('presetName').value.trim();
  const name = typed || presetCurrent;   // empty box + selected preset = update that one
  if (!name) { logError('保存预设需要先输入名称，或先在列表中选择要覆盖的预设'); return; }
  const list = presetLoadAll();
  const params = presetCollect();
  const i = list.findIndex((x) => x.n === name);
  if (i >= 0) list[i].p = params; else list.push({ n: name, p: params });
  presetStoreAll(list);
  $('presetName').value = '';
  presetCurrent = name;
  refreshPresetList();
});

$('presetLoadBtn').addEventListener('click', () => {
  const it = presetLoadAll().find((x) => x.n === presetCurrent);
  if (!it) return;
  for (const id of PRESET_IDS) if (id in it.p) applyParamTo(id, it.p[id]);
  persistParams();
});

$('presetDelBtn').addEventListener('click', () => {
  const name = presetCurrent;
  if (!name) return;
  presetStoreAll(presetLoadAll().filter((x) => x.n !== name));
  $('presetName').value = name;   // handy if the user wants to re-create it under the same name
  presetCurrent = '';
  refreshPresetList();
});

$('presetListBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  $('presetListMenu').classList.toggle('open');
});
// Click anywhere outside the preset picker collapses the open menu.
document.addEventListener('click', (e) => {
  if (!$('presetListWrap').contains(e.target)) $('presetListMenu').classList.remove('open');
});
refreshPresetList();

