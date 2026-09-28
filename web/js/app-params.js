// 参数持久化、渲染参数恢复、撤销/重做、命名预设

// ---------------------------------------------------------------- persist params
// 模型 / 渲染参数在刷新后保留（localStorage），重新打开页面不会回到默认值。
// 只持久化"参数"控件：文件路径与裁剪时间属于某一次具体任务，不保存。
const LS_PARAMS_KEY = 'dlss5nr.params.v1';
const PARAM_IDS = [
  'model', 'preset', 'style',
  'intensity', 'localTone', 'localStructure', 'skinStructure',
  'autoMask', 'uiCorrection', 'residualMult',
  'flowEnable', 'mvecQuality', 'depthInterval',
  'encoder', 'renderPasses',
  // 这两个原来漏了：显卡选择与图片迭代次数长得和别的参数一样，却每次刷新都重置
  'gpuSel', 'imgRenderPasses',
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
  } catch (e) { /* 隐私模式 / 配额满：忽略 */ }
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
  const twin = $(id + '_n');   // 滑杆 + 数字框：两个视图一起更新
  if (twin && twin.type === 'number' && el.type === 'range') twin.value = asStr;
}

function restoreParams() {
  let o = null;
  try { o = JSON.parse(localStorage.getItem(LS_PARAMS_KEY) || 'null'); } catch (e) { /* ignore */ }
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

// ---------------------------------------------------------------- 参数撤销 / 重做
// 引擎会把渲染参数写进成品文件（"render_cfg=" 载荷）。把这种文件拖进来即可还原
// 当时的设置。撤销栈记录"参数集合"的变化，误还原可以用 Ctrl+Z 退回。
//
// 快捷键在 app-shell.js 里统一处理（原来是这里的 document keydown，会在输入框里
// 抢走浏览器自己的 Ctrl+Z，把文字编辑变成滑杆跳动）。
const META_TO_UI = {
  preset: 'preset', style: 'style',
  intensity: 'intensity', localTone: 'localTone', localStructure: 'localStructure',
  skinStructure: 'skinStructure', autoMask: 'autoMask', uiCorrection: 'uiCorrection',
  residualMult: 'residualMult', mvecQuality: 'mvecQuality', depthInterval: 'depthInterval',
  renderPasses: 'renderPasses',
};

let paramHistory = [];    // 快照（最旧在前）
let historyIndex = -1;    // 当前状态在栈中的位置
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
  paramHistory = paramHistory.slice(0, historyIndex + 1);   // 新改动会丢弃 redo 分支
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
  if (window.uiToast) window.uiToast('已撤销参数修改', 'info', { ms: 1800 });
}

function redoParams() {
  if (historyIndex < 0 || historyIndex >= paramHistory.length - 1) return;
  historyIndex++;
  applySnapshot(paramHistory[historyIndex]);
  persistParams();
  syncHistoryBtns();
  if (window.uiToast) window.uiToast('已重做参数修改', 'info', { ms: 1800 });
}

function syncHistoryBtns() {
  $('metaUndoBtn').disabled = historyIndex <= 0;
  $('metaRedoBtn').disabled = historyIndex < 0 || historyIndex >= paramHistory.length - 1;
}

$('metaUndoBtn').addEventListener('click', undoParams);
$('metaRedoBtn').addEventListener('click', redoParams);
pushHistory();   // 基线

PARAM_IDS.forEach((id) => {
  const el = $(id);
  if (!el) return;
  el.addEventListener('change', pushHistory);
});

// 把解析出来的 meta JSON 应用到界面，并作为一步撤销记录。
function applyRenderMeta(meta) {
  for (const [k, id] of Object.entries(META_TO_UI)) {
    if (k in meta) applyParamTo(id, meta[k]);
  }
  if ('frameGuidance' in meta) applyParamTo('flowEnable', meta.frameGuidance !== 0);
  persistParams();
  pushHistory();
}

// 参数键名 → 中文说明，恢复后给用户看的是人话而不是英文键
const META_LABEL = {
  preset: '预设档位', style: '风格', intensity: 'NR 强度', localTone: '局部色调',
  localStructure: '局部结构', skinStructure: '皮肤结构', autoMask: '自动遮罩',
  uiCorrection: 'UI 修正', residualMult: '残差倍增', mvecQuality: '光流质量',
  depthInterval: '深度间隔', renderPasses: '渲染次数', frameGuidance: '光流',
};

function showMetaMsg(text, isErr) {
  const m = $('metaDropMsg');
  m.textContent = text;
  m.className = 'dz-msg ' + (isErr ? 'is-error' : 'is-ok');
  m.style.display = '';
  setTimeout(() => { m.style.display = 'none'; }, 8000);
}

async function metaDropFile(file) {
  const okExt = /\.(mp4|mkv|mov|m4v|png|jpe?g)$/i.test(file.name);
  if (!okExt) {
    showMetaMsg('仅支持本软件输出的 mp4 / mkv / png / jpg', true);
    return;
  }
  const zone = $('metaDrop');
  const stopTick = window.uiElapsed ? window.uiElapsed($('metaDropHint'), '正在读取文件') : null;
  try {
    const up = await fetch('/api/upload', {
      method: 'POST',
      headers: { 'X-Filename': encodeURIComponent(file.name) },
      body: file,
    }).then((x) => x.json());
    if (!up.ok || !up.path) throw new Error(up.error || '上传失败');
    $('metaDropHint').textContent = '正在解析渲染参数…';
    const r = await fetch('/api/read-meta', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: up.path }),
    }).then((x) => x.json());
    if (!r.ok || !r.found || !r.meta) {
      showMetaMsg('该文件里没有渲染参数（可能不是本软件输出的）', true);
      return;
    }
    applyRenderMeta(r.meta);
    const parts = Object.entries(r.meta)
      .filter(([k]) => META_TO_UI[k] || k === 'frameGuidance')
      .map(([k, v]) => (META_LABEL[k] || k) + '=' + v);
    showMetaMsg('已恢复：' + parts.join('  '), false);
    if (window.uiOk) window.uiOk('已恢复渲染参数（共 ' + parts.length + ' 项），可用 Ctrl+Z 撤销', { force: true });
  } catch (e) {
    showMetaMsg('恢复失败：' + e.message, true);
    if (window.uiErr) window.uiErr('恢复参数失败：' + e.message);
  } finally {
    if (stopTick) stopTick();
    $('metaDropHint').textContent = '拖入成品文件 · 恢复参数';
    if (zone) zone.classList.remove('drop-active');
  }
}

const metaDrop = $('metaDrop');
['dragenter', 'dragover'].forEach((ev) => metaDrop.addEventListener(ev, (e) => {
  e.preventDefault();
  e.stopPropagation();
  metaDrop.classList.add('drop-active');
}));
['dragleave', 'drop'].forEach((ev) => metaDrop.addEventListener(ev, (e) => {
  e.preventDefault();
  e.stopPropagation();
  metaDrop.classList.remove('drop-active');
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
metaDrop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); metaDrop.click(); }
});

// ---------------------------------------------------------------- named presets
// 命名预设只保存「参数」这一类（编码器属于输出设置，不进预设）。与上面的"记住上次
// 调参"分开存，两者互不干扰。
const LS_PRESETS_KEY = 'dlss5nr.presets.v1';
const PRESET_IDS = PARAM_IDS.filter((id) => id !== 'encoder' && id !== 'gpuSel');
let presetCurrent = '';

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
  catch (e) { logError('无法保存预设：' + e.message); }
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

function setPresetMenuOpen(open) {
  $('presetListMenu').classList.toggle('open', !!open);
  $('presetListBtn').setAttribute('aria-expanded', open ? 'true' : 'false');
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
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', it.n === presetCurrent ? 'true' : 'false');
    if (it.n === presetCurrent) li.classList.add('active');
    li.addEventListener('click', () => {
      presetCurrent = it.n;
      setPresetMenuOpen(false);
      refreshPresetList();
    });
    menu.appendChild(li);
  }
}

$('presetSaveBtn').addEventListener('click', () => {
  const typed = $('presetName').value.trim();
  const name = typed || presetCurrent;   // 名字留空且已选中某项 = 覆盖那一项
  if (!name) {
    logError('保存预设需要先输入名称，或先在列表中选择要覆盖的预设');
    $('presetName').focus();
    return;
  }
  const list = presetLoadAll();
  const params = presetCollect();
  const i = list.findIndex((x) => x.n === name);
  const existed = i >= 0;
  if (existed) list[i].p = params; else list.push({ n: name, p: params });
  presetStoreAll(list);
  $('presetName').value = '';
  presetCurrent = name;
  refreshPresetList();
  if (window.uiOk) window.uiOk(existed ? '已覆盖预设：' + name : '已保存预设：' + name);
});

$('presetLoadBtn').addEventListener('click', () => {
  const it = presetLoadAll().find((x) => x.n === presetCurrent);
  if (!it) return;
  for (const id of PRESET_IDS) if (id in it.p) applyParamTo(id, it.p[id]);
  persistParams();
  // 加载预设也要进撤销栈，否则同一张卡片上的「撤销」对它无效
  pushHistory();
  if (window.uiOk) window.uiOk('已加载预设：' + presetCurrent + '（可用 Ctrl+Z 撤销）');
});

$('presetDelBtn').addEventListener('click', async () => {
  const name = presetCurrent;
  if (!name) return;
  const ok = window.uiConfirm
    ? await window.uiConfirm('删除预设？', '将删除预设「' + name + '」，此操作无法撤销。', '删除')
    : window.confirm('确定删除预设「' + name + '」吗？');
  if (!ok) return;
  presetStoreAll(presetLoadAll().filter((x) => x.n !== name));
  $('presetName').value = name;   // 方便用户想用同名重建
  presetCurrent = '';
  refreshPresetList();
  if (window.uiWarn) window.uiWarn('已删除预设：' + name);
});

$('presetListBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  setPresetMenuOpen(!$('presetListMenu').classList.contains('open'));
});
// 点击别处收起预设菜单。Esc 关闭菜单由 app-shell.js 的统一键盘入口处理
// （这里再挂一个 keydown 会和它抢事件，重新制造优先级不明的问题）。
document.addEventListener('click', (e) => {
  if (!$('presetListWrap').contains(e.target)) setPresetMenuOpen(false);
});
refreshPresetList();
