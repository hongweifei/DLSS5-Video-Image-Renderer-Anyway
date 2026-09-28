// app-shell.js — 交互外壳：主题、模式切换、提示、忙碌态、统一键盘、拖放
//
// 这一层是"应用级交互"，与具体业务（渲染/批量/对比）分开：
//   · 主题切换与持久化
//   · 顶部模式切换（一次只呈现一个任务）
//   · 底部操作栏：把当前模式的主操作固定在同一位置
//   · 键盘：**唯一**的全局快捷键入口（原来有 4 个 document keydown 互相抢事件）
//   · 拖放：唯一的实现 + 全屏提示，按文件类型自动切到对应模式
//   · 提示条（toast）、确认框、按钮忙碌态
//
// 为什么要收口键盘：
//   原实现里 Esc 被 3 处监听（关图片弹层 / 退出视频放大 / 停止渲染），且
//   app-shortcuts.js 最后加载 —— 等它检查"有没有浮层打开"时，前两个监听已经把
//   浮层关掉了，于是 overlayOpen() 返回 false，Esc 在关闭浮层的同时**把正在跑的
//   渲染也取消了**。现在改为单一入口 + 明确的优先级，并在消费事件时
//   stopImmediatePropagation，杜绝重复触发。
//
// 全部包在 IIFE 内：这些脚本共享同一个全局作用域，顶层 const/let 重名会直接
// 变成 SyntaxError，包起来最省心。
(function () {
  'use strict';

  const $id = (id) => document.getElementById(id);
  const root = document.documentElement;

  // ================================================================ toast
  const TOAST_TITLE = { info: '提示', ok: '完成', warn: '注意', error: '出错了' };
  const TOAST_MS = { info: 5000, ok: 4000, warn: 7000, error: 9000 };
  const MAX_TOASTS = 4;

  function uiToast(msg, kind, opts) {
    opts = opts || {};
    kind = TOAST_TITLE[kind] ? kind : 'info';
    const wrap = $id('toasts');
    if (!wrap) return null;

    // 同一条消息不重复堆叠（轮询类错误很容易连发）
    if (!opts.force) {
      for (const t of wrap.children) {
        if (t.dataset.msg === msg && t.dataset.kind === kind) {
          t.dataset.expire = String(Date.now() + (opts.ms || TOAST_MS[kind]));
          return t;
        }
      }
    }
    while (wrap.children.length >= MAX_TOASTS) wrap.removeChild(wrap.firstChild);

    const el = document.createElement('div');
    el.className = 'toast k-' + kind;
    el.dataset.msg = msg;
    el.dataset.kind = kind;
    el.dataset.expire = String(Date.now() + (opts.ms || TOAST_MS[kind]));
    el.setAttribute('role', kind === 'error' ? 'alert' : 'status');

    const body = document.createElement('div');
    body.className = 't-body';
    const title = document.createElement('div');
    title.className = 't-title';
    title.textContent = opts.title || TOAST_TITLE[kind];
    const text = document.createElement('div');
    text.className = 't-msg';
    text.textContent = String(msg == null ? '' : msg);   // textContent：不解析 HTML
    body.appendChild(title);
    if (msg) body.appendChild(text);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 't-close';
    close.setAttribute('aria-label', '关闭提示');
    close.textContent = '\u00d7';
    close.addEventListener('click', () => removeToast(el));

    el.appendChild(body);
    el.appendChild(close);
    wrap.appendChild(el);
    return el;
  }

  function removeToast(el) {
    if (!el || !el.parentNode) return;
    el.classList.add('is-leaving');
    setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 200);
  }

  // 单一回收定时器：不用每条 toast 一个 setTimeout，页面长时间开着也不会堆积
  setInterval(() => {
    const wrap = $id('toasts');
    if (!wrap) return;
    const now = Date.now();
    for (const t of Array.from(wrap.children)) {
      if (Number(t.dataset.expire) <= now) removeToast(t);
    }
  }, 500);

  const uiOk = (m, o) => uiToast(m, 'ok', o);
  const uiErr = (m, o) => uiToast(m, 'error', o);
  const uiWarn = (m, o) => uiToast(m, 'warn', o);

  // ================================================================ 忙碌态
  // 按钮进入忙碌：禁用 + aria-busy + 内联转圈。转圈元素绝对定位在按钮内部，
  // 不改变按钮尺寸，所以不会引起布局跳动。
  function uiBusy(btn, on) {
    if (!btn) return;
    if (on) {
      btn.dataset.idleDisabled = btn.disabled ? '1' : '0';
      btn.disabled = true;
      btn.setAttribute('aria-busy', 'true');
      if (!btn.querySelector('.spinner')) {
        const sp = document.createElement('span');
        sp.className = 'spinner';
        sp.setAttribute('aria-hidden', 'true');
        btn.insertBefore(sp, btn.firstChild);
      }
    } else {
      btn.removeAttribute('aria-busy');
      const sp = btn.querySelector('.spinner');
      if (sp) sp.parentNode.removeChild(sp);
      if (btn.dataset.idleDisabled !== '1') btn.disabled = false;
      delete btn.dataset.idleDisabled;
    }
  }

  // 包住一个异步处理器，保证忙碌标志无论如何都会复位。
  // 原实现里 vbBusy / imgBatchBusy 只在成功路径复位，一次网络抖动就会让按钮
  // 永久禁用，只能刷新页面。
  function uiGuard(btn, fn) {
    return async function (...args) {
      if (btn && btn.getAttribute('aria-busy') === 'true') return;   // 防重复点击
      uiBusy(btn, true);
      try {
        return await fn.apply(this, args);
      } catch (e) {
        uiErr('操作失败：' + (e && e.message ? e.message : e));
      } finally {
        uiBusy(btn, false);
      }
    };
  }

  // ================================================================ 计时反馈
  // 单帧渲染要 10–40 秒。原实现只写一句固定文字，40 秒里一个字都不变，
  // 用户无法区分"在跑"和"卡死了"。这里给出秒表：数字在动就说明还活着。
  function uiElapsed(el, label) {
    const t0 = Date.now();
    const paint = () => {
      if (!el) return;
      const s = Math.round((Date.now() - t0) / 1000);
      el.textContent = label + ' · 已用 ' + s + 's' + (s >= 8 ? '（首次推理含引擎冷启动）' : '');
    };
    paint();
    const h = setInterval(paint, 1000);
    return () => clearInterval(h);
  }

  // ================================================================ 对比分界线
  // 原实现只监听 mousemove，并且 mouseleave 时把分界线弹回 50% —— 于是"只想看看
  // 左边"这件事做不到（一移开就复位），触屏也完全没法用。现在：
  //   · 指针按住拖动（pointer 事件同时覆盖鼠标/触屏/触控笔）
  //   · 鼠标悬停仍然跟随（保留原来的顺手手感）
  //   · 键盘 ← → 可调，Home/End 到两端，并同步 aria-valuenow
  function uiBindSplit(stage, setter) {
    if (!stage) return;
    let dragging = false;
    const clamp01 = (v) => Math.min(1, Math.max(0, v));
    const pctFromX = (clientX) => {
      const r = stage.getBoundingClientRect();
      if (r.width <= 0) return null;
      return clamp01((clientX - r.left) / r.width);
    };
    const syncAria = (p) => stage.setAttribute('aria-valuenow', String(Math.round(p * 100)));
    const applyAt = (clientX) => {
      const p = pctFromX(clientX);
      if (p === null) return;
      setter(p);
      syncAria(p);
    };

    stage.addEventListener('pointerdown', (e) => {
      dragging = true;
      try { stage.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      applyAt(e.clientX);
    });
    stage.addEventListener('pointermove', (e) => {
      if (dragging || e.pointerType === 'mouse') applyAt(e.clientX);
    });
    const stop = (e) => {
      dragging = false;
      try { if (e.pointerId != null) stage.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    };
    stage.addEventListener('pointerup', stop);
    stage.addEventListener('pointercancel', stop);

    stage.addEventListener('keydown', (e) => {
      const cur = parseFloat(stage.getAttribute('aria-valuenow')) || 50;
      if (e.key === 'Home') { setter(0); syncAria(0); e.preventDefault(); return; }
      if (e.key === 'End') { setter(1); syncAria(1); e.preventDefault(); return; }
      let d = 0;
      if (e.key === 'ArrowLeft') d = -2;
      else if (e.key === 'ArrowRight') d = 2;
      if (!d) return;
      e.preventDefault();
      const p = clamp01((cur + d) / 100);
      setter(p);
      syncAria(p);
    });

    setter(0.5);
    syncAria(0.5);
  }

  // ================================================================ 确认框
  let confirmResolve = null;

  function uiConfirm(title, msg, okLabel) {
    const modal = $id('confirmModal');
    if (!modal) return Promise.resolve(window.confirm(msg || title || ''));
    $id('confirmTitle').textContent = title || '确认';
    $id('confirmMsg').textContent = msg || '';
    $id('confirmOk').textContent = okLabel || '确定';
    modal.classList.add('show');
    confirmResolve = null;
    return new Promise((resolve) => {
      confirmResolve = resolve;
      const ok = $id('confirmOk');
      const prev = document.activeElement;
      setTimeout(() => ok.focus(), 0);
      modal.dataset.prevFocus = prev && prev.id ? prev.id : '';
    });
  }

  function finishConfirm(value) {
    const modal = $id('confirmModal');
    if (!modal || !modal.classList.contains('show')) return;
    modal.classList.remove('show');
    const prev = $id(modal.dataset.prevFocus || '');
    if (prev && prev.focus) prev.focus();
    if (confirmResolve) { const r = confirmResolve; confirmResolve = null; r(value); }
  }

  const confirmOpen = () => {
    const m = $id('confirmModal');
    return !!(m && m.classList.contains('show'));
  };

  // ================================================================ 主题
  function currentTheme() {
    return root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  }
  function setTheme(t) {
    root.setAttribute('data-theme', t === 'dark' ? 'dark' : 'light');
    try { localStorage.setItem('dlss5nr.theme', t); } catch (e) { /* ignore */ }
    const b = $id('themeToggle');
    if (b) b.setAttribute('aria-pressed', t === 'dark' ? 'true' : 'false');
  }
  function toggleTheme() {
    setTheme(currentTheme() === 'dark' ? 'light' : 'dark');
  }
  setTheme(currentTheme());

  // ================================================================ 模式切换
  const TABS = ['video', 'image', 'batch'];
  let activeTab = 'video';
  const actionsOf = {};      // tab -> [actions 节点…]（原位置留一个占位锚点）
  const parkOf = {};         // tab -> [占位锚点…]

  function showTab(name, opts) {
    if (TABS.indexOf(name) < 0) name = 'video';
    opts = opts || {};
    activeTab = name;

    for (const t of TABS) {
      const tab = $id('tab' + t.charAt(0).toUpperCase() + t.slice(1));
      const panel = $id('panel' + t.charAt(0).toUpperCase() + t.slice(1));
      const on = t === name;
      if (tab) {
        tab.setAttribute('aria-selected', on ? 'true' : 'false');
        tab.tabIndex = on ? 0 : -1;
      }
      if (panel) panel.hidden = !on;
    }
    moveActions(name);
    try { localStorage.setItem('dlss5nr.tab', name); } catch (e) { /* ignore */ }
    if (opts.focus) {
      const panel = $id('panel' + name.charAt(0).toUpperCase() + name.slice(1));
      if (panel) panel.focus();
    }
  }

  // 把当前模式的操作按钮移进底部操作栏。移动 DOM 节点会保留事件监听，
  // 所以不需要重新绑定；切走时再放回原占位锚点。
  function moveActions(name) {
    const slot = $id('actionSlot');
    if (!slot) return;
    for (const t of TABS) {
      const anchors = parkOf[t] || [];
      const nodes = actionsOf[t] || [];
      nodes.forEach((n, i) => { if (anchors[i] && n.parentNode !== anchors[i]) anchors[i].appendChild(n); });
    }
    (actionsOf[name] || []).forEach((n) => slot.appendChild(n));
  }

  function initTabs() {
    TABS.forEach((t) => {
      const key = t.charAt(0).toUpperCase() + t.slice(1);
      const actions = document.querySelector('.actions[data-actions="' + t + '"]');
      if (actions) {
        // 在原位置留一个锚点，切回来时按钮回到它该在的地方
        const anchor = document.createElement('div');
        anchor.hidden = true;
        actions.parentNode.insertBefore(anchor, actions);
        actionsOf[t] = [actions];
        parkOf[t] = [anchor];
      }
      const tab = $id('tab' + key);
      if (tab) {
        tab.addEventListener('click', () => showTab(t));
        // ARIA tabs 键盘约定：左右箭头在标签间移动，Home/End 到首尾
        tab.addEventListener('keydown', (e) => {
          const i = TABS.indexOf(t);
          let n = -1;
          if (e.key === 'ArrowRight') n = (i + 1) % TABS.length;
          else if (e.key === 'ArrowLeft') n = (i - 1 + TABS.length) % TABS.length;
          else if (e.key === 'Home') n = 0;
          else if (e.key === 'End') n = TABS.length - 1;
          if (n < 0) return;
          e.preventDefault();
          showTab(TABS[n]);
          const nt = $id('tab' + TABS[n].charAt(0).toUpperCase() + TABS[n].slice(1));
          if (nt) nt.focus();
        });
      }
    });

    let saved = null;
    try { saved = localStorage.getItem('dlss5nr.tab'); } catch (e) { saved = null; }
    showTab(TABS.indexOf(saved) >= 0 ? saved : 'video');
  }

  // ================================================================ 拖放
  // 全窗口拖放，带全屏提示（原来只有两个卡片轮廓高亮，用户不知道松手会发生什么）。
  // 用 relatedTarget 判断是否真的离开了窗口，而不是靠 dragenter/dragleave 计数 ——
  // 计数法在 dragleave 不带 dataTransfer.types 时会卡住，让高亮永久留在页面上。
  let dropVisible = false;

  function hasFiles(e) {
    const dt = e.dataTransfer;
    if (!dt) return false;
    if (dt.types) {
      for (const t of Array.from(dt.types)) if (t === 'Files') return true;
    }
    return false;
  }

  function firstFileName(e) {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    return f ? f.name : '';
  }

  function showDropOverlay(name) {
    const ov = $id('dropOverlay');
    if (!ov) return;
    const title = $id('dropTitle');
    const sub = $id('dropSub');
    if (/\.(png|jpe?g|bmp|webp|tif?f)$/i.test(name)) {
      title.textContent = '松手 → 作为输入图片';
      sub.textContent = '会切到「图片」模式';
    } else if (/\.(mp4|mov|mkv|avi|webm|m4v)$/i.test(name)) {
      title.textContent = '松手 → 作为输入视频';
      sub.textContent = '会切到「视频」模式';
    } else {
      title.textContent = '松手即可导入';
      sub.textContent = '视频放到「视频」，图片放到「图片」，输出的成品文件会用来恢复参数';
    }
    ov.classList.add('active');
    dropVisible = true;
  }

  function hideDropOverlay() {
    const ov = $id('dropOverlay');
    if (ov) ov.classList.remove('active');
    dropVisible = false;
  }

  document.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    showDropOverlay(firstFileName(e));
  }, true);

  document.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();                       // 不阻止默认行为就收不到 drop
    if (dropVisible) showDropOverlay(firstFileName(e));
  }, true);

  document.addEventListener('dragleave', (e) => {
    if (!dropVisible) return;
    // 只有真正离开窗口才收起：relatedTarget 为 null 或已不在文档内
    const to = e.relatedTarget;
    if (to === null || !document.documentElement.contains(to)) hideDropOverlay();
  }, true);

  document.addEventListener('drop', (e) => {
    hideDropOverlay();
    if (!hasFiles(e)) return;
    e.preventDefault();
    const target = e.target;
    const onMetaZone = target && target.closest && target.closest('#metaDrop');
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    if (onMetaZone) return;                   // 参数恢复区自己处理（app-params.js）
    routeDroppedFile(f);
  }, true);

  function routeDroppedFile(f) {
    const image = typeof isImageFile === 'function' ? isImageFile(f.name) : false;
    const video = typeof isVideoFile === 'function' ? isVideoFile(f.name) : false;
    if (image) {
      showTab('image');
      if (typeof handleDroppedImage === 'function') { handleDroppedImage(f); return; }
    } else if (video) {
      showTab('video');
      if (typeof handleDroppedFile === 'function') { handleDroppedFile(f); return; }
    }
    uiErr('不支持的文件类型：' + f.name + '（视频 mp4/mov/mkv/avi/webm/m4v；图片 png/jpg/jpeg/bmp/webp/tif/tiff）');
  }

  // ================================================================ 键盘（唯一入口）
  function isTyping(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  }

  function overlayOpen() {
    if (confirmOpen()) return true;
    if (typeof imgModalOpen !== 'undefined' && imgModalOpen) return true;
    if (document.querySelector('.vd-zoom')) return true;
    const pm = $id('presetListMenu');
    if (pm && pm.classList.contains('open')) return true;
    return false;
  }

  function closeTopOverlay() {
    // 优先级：确认框 > 图片弹层 > 视频放大 > 预设下拉
    if (confirmOpen()) { finishConfirm(false); return true; }
    if (typeof imgModalOpen !== 'undefined' && imgModalOpen) {
      if (typeof closeImgModal === 'function') closeImgModal();
      return true;
    }
    if (document.querySelector('.vd-zoom')) {
      if (window.vdCompare && window.vdCompare.setZoom) window.vdCompare.setZoom(false);
      return true;
    }
    const pm = $id('presetListMenu');
    const pb = $id('presetListBtn');
    if (pm && pm.classList.contains('open')) {
      pm.classList.remove('open');
      if (pb) pb.setAttribute('aria-expanded', 'false');
      return true;
    }
    return false;
  }

  // 采集阶段（capture）：先于所有气泡阶段的旧监听执行；一旦消费就
  // stopImmediatePropagation，保证 Esc 只做一件事。
  document.addEventListener('keydown', (e) => {
    // ---- Esc：关闭最上层浮层；没有浮层时才停止渲染 ----
    if (e.key === 'Escape') {
      if (closeTopOverlay()) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      const cancelBtn = $id('cancelBtn');
      if (cancelBtn && !cancelBtn.disabled) {
        e.preventDefault();
        e.stopImmediatePropagation();
        cancelBtn.click();
      } else {
        // 焦点在输入框里时，Esc 只做"取消编辑"，不做别的
        if (isTyping(e.target) && e.target.blur) e.target.blur();
      }
      return;
    }

    // ---- Ctrl/Cmd + Enter：开始处理 ----
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      if (overlayOpen()) return;
      const primary = primaryButton();
      if (primary && !primary.disabled) {
        e.preventDefault();
        e.stopImmediatePropagation();
        primary.click();
      }
      return;
    }

    // ---- Ctrl/Cmd + Z / Y：参数撤销重做（输入框内让给浏览器自己的撤销） ----
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z' || e.key === 'y' || e.key === 'Y')) {
      if (isTyping(e.target)) return;
      const redo = e.key === 'y' || e.key === 'Y' || e.shiftKey;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (redo) { if (typeof redoParams === 'function') redoParams(); }
      else { if (typeof undoParams === 'function') undoParams(); }
      return;
    }

    // ---- Ctrl/Cmd + Shift + L：切换主题 ----
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'l' || e.key === 'L')) {
      e.preventDefault();
      e.stopImmediatePropagation();
      toggleTheme();
    }
  }, true);

  // 当前模式下真正的主操作按钮：底部栏里第一个可用的 .primary。
  // 批量模式有两个主按钮（视频/图片），这里挑第一个「没被禁用」的，
  // 避免 Ctrl+Enter 恰好落到一个灰掉的按钮上什么也不发生。
  function primaryButton() {
    const slot = $id('actionSlot');
    if (!slot) return null;
    const list = Array.from(slot.querySelectorAll('.btn.primary'));
    return list.find((b) => !b.disabled) || null;
  }

  // ================================================================ 全局状态
  // renderStatus 每秒调用一次，这里把"任何模式都该看到"的信息同步到
  // 顶栏胶囊 + 底部操作栏。渲染是后台任务，切到"图片"页也必须能看见它还在跑。
  let lastRunning = null;
  let lastDoneId = null;

  function uiStatus(s) {
    const pil = $id('globalStatus');
    const pilTxt = $id('globalStatusTxt');
    const barSt = $id('barStatus');
    const barPct = $id('barPct');
    const barMini = $id('barMini');
    const barWrap = barMini && barMini.parentNode;
    if (!s) return;

    const total = s.overallTotal || 0;
    const done = s.overallDone || 0;
    const pct = total > 0 ? Math.min(100, (done / total) * 100) : (s.finished ? 100 : 0);

    let cls = '';
    let text = '空闲';
    let detail = '';

    if (s.running) {
      cls = 'is-running';
      const round = (s.passes || 1) > 1 ? `第 ${s.pass || 1}/${s.passes} 轮 · ` : '';
      const frames = total > 0 ? `${done}/${total} 帧` : `${done} 帧`;
      const eta = s.etaSec > 0 ? ` · 剩余约 ${fmtClock(s.etaSec)}` : '';
      text = '渲染中';
      detail = `${round}${frames}${eta}`;
    } else if (s.finished) {
      const okJob = s.code === 0;
      cls = okJob ? 'is-done' : 'is-error';
      text = okJob ? '已完成' : `失败（结束码 ${s.code}）`;
      detail = okJob && s.output ? String(s.output).split(/[\\/]/).pop() : '见日志';
    } else if (s.queue && s.queue.count) {
      cls = 'is-running';
      text = `队列 ${s.queue.count} 个`;
      detail = '等待开始';
    }

    if (pil) {
      pil.className = 'status-pill ' + cls;
      const d = pil.querySelector('.dot');
      if (d) d.setAttribute('aria-hidden', 'true');
    }
    if (pilTxt) pilTxt.textContent = text;
    if (barSt) {
      barSt.className = 'status ' + cls;
      barSt.textContent = detail ? text + ' · ' + detail : text;
    }
    if (barPct) barPct.textContent = Math.round(pct) + '%';
    if (barMini) barMini.style.setProperty('--p', (pct / 100).toFixed(4));
    if (barWrap) barWrap.setAttribute('aria-valuenow', String(Math.round(pct)));

    // 主进度条（#bar 由 app-status.js 写 --p，这里只同步 aria）
    const bar = $id('bar');
    if (bar) {
      const wrap = bar.parentNode;
      if (wrap) wrap.setAttribute('aria-valuenow', String(Math.round(pct)));
    }

    // 任务结束的一次性提示：只在"运行 -> 结束"这个跳变上发一次
    if (lastRunning === true && s.running === false && s.finished) {
      if (s.code === 0) uiOk('渲染完成' + (s.output ? '：' + s.output : ''), { force: true });
      else uiErr('渲染失败（结束码 ' + s.code + '）。详情见右下角日志。', { force: true });
    }
    lastRunning = !!s.running;

    // 队列里新完成的任务也可以提示，但只在同一会话内跟踪
    if (s.lastDone && s.lastDone.id !== lastDoneId) {
      if (lastDoneId !== null && s.lastDone.code === 0) uiOk('队列任务完成：' + (s.lastDone.output || ''), { force: true });
      lastDoneId = s.lastDone.id;
    }
  }

  function fmtClock(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    const m = Math.floor(sec / 60), s = sec % 60;
    const h = Math.floor(m / 60);
    return h > 0
      ? `${h}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      : `${m}:${String(s).padStart(2, '0')}`;
  }

  // ================================================================ 顶栏按钮 / 日志
  function initChrome() {
    const themeBtn = $id('themeToggle');
    if (themeBtn) themeBtn.addEventListener('click', toggleTheme);

    const logBtn = $id('logToggleTop');
    if (logBtn) {
      logBtn.addEventListener('click', () => {
        if (typeof setLogFolded === 'function') setLogFolded(!logPanelFolded);
      });
    }

    const confirmOk = $id('confirmOk');
    const confirmCancel = $id('confirmCancel');
    if (confirmOk) confirmOk.addEventListener('click', () => finishConfirm(true));
    if (confirmCancel) confirmCancel.addEventListener('click', () => finishConfirm(false));
    const cm = $id('confirmModal');
    if (cm) {
      cm.addEventListener('click', (e) => { if (e.target === cm) finishConfirm(false); });
    }
  }

  // 日志面板折叠状态变化后同步 aria（setLogFolded 由 app-status.js 提供）
  function syncLogAria() {
    const panel = $id('logPanel');
    const head = $id('logHead');
    const top = $id('logToggleTop');
    if (!panel) return;
    const expanded = panel.classList.contains('expanded');
    if (head) head.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    if (top) top.setAttribute('aria-pressed', expanded ? 'true' : 'false');
  }
  const logObserver = new MutationObserver(syncLogAria);
  const logPanelEl = $id('logPanel');
  if (logPanelEl) logObserver.observe(logPanelEl, { attributes: true, attributeFilter: ['class'] });
  syncLogAria();

  // ================================================================ 对外接口
  window.uiToast = uiToast;
  window.uiOk = uiOk;
  window.uiErr = uiErr;
  window.uiWarn = uiWarn;
  window.uiBusy = uiBusy;
  window.uiGuard = uiGuard;
  window.uiElapsed = uiElapsed;
  window.uiBindSplit = uiBindSplit;
  window.uiConfirm = uiConfirm;
  window.uiStatus = uiStatus;
  window.uiShell = {
    showTab: showTab,
    activeTab: () => activeTab,
    setTheme: setTheme,
    toggleTheme: toggleTheme,
    theme: currentTheme,
    toast: uiToast,
    busy: uiBusy,
    guard: uiGuard,
    elapsed: uiElapsed,
    bindSplit: uiBindSplit,
    confirm: uiConfirm,
    status: uiStatus,
    syncLogAria: syncLogAria,
  };

  initTabs();
  initChrome();
  syncLogAria();
})();
