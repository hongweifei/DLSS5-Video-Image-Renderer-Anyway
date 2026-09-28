// 视频对比播放器（自包含 IIFE）
//
// 放大视图、Esc 关闭等"应用级"交互交给 app-shell.js 统一处理；这里通过
// window.vdCompare 暴露 setZoom/setSplit 供它调用，不再自己挂 document 监听。

// ----------------------------------------------------------------- video side-by-side compare
(function () {
  const $ = (id) => document.getElementById(id);
  const vB = $('vdBefore'), vA = $('vdAfter');       // vB = rendered-before (top-left), vA = after (base)
  const box = $('vdBox'), stage = $('vdStage'), topL = $('vdTop'), div = $('vdDivider');
  const playB = $('vdPlay'), seek = $('vdSeek'), timeT = $('vdTime');
  const vol = $('vdVol'), muteB = $('vdMute'), ctrl = $('vdCtrl'), st = $('vdStatus');
  let ready = { a: false, b: false };
  let dragging = false, syncing = false, curMuted = true, inited = false, autoNext = false;
  window.__vdManual = false;             // 用户手动选过对比视频 -> 不再自动覆盖
  let autoTries = 0;

  // 图标用 SVG sprite 换 href，而不是写 emoji：emoji 由字体决定，跨机器不一致，
  // 也无法跟随主题色。
  function setIcon(btn, iconId, label) {
    if (!btn) return;
    const u = btn.querySelector('use');
    if (u) u.setAttribute('href', '#' + iconId);
    if (label) {
      btn.setAttribute('aria-label', label);
      btn.title = label;
    }
  }
  const setMuteIcon = () => setIcon(muteB, curMuted ? 'i-mute' : 'i-volume', curMuted ? '取消静音' : '静音');
  const muteAll = () => { vB.muted = true; vA.muted = true; curMuted = true; setMuteIcon(); };
  const kick = (v) => {
    try {
      const pr = v.play();
      if (pr && pr.catch) pr.catch(() => { setTimeout(() => { try { v.play(); } catch (e) { /* ignore */ } }, 400); });
    } catch (e) { /* ignore */ }
  };
  const softAlignStart = () => {
    [200, 700].forEach((ms) => setTimeout(() => {
      if (!inited || vM.paused || vO.paused) return;
      try {
        const expect = posOrig(vM.currentTime);
        if (Math.abs(vO.currentTime - expect) > 0.03) vO.currentTime = expect;
      } catch (e) { /* ignore */ }
    }, ms));
  };
  const autoPlay = () => {                 // muted autoplay is allowed; retry once if blocked
    if (!autoNext) return;
    muteAll();
    softAlignStart();
    kick(vA); kick(vB);
  };

  const vurl = (p) => '/api/video?path=' + encodeURIComponent(p);
  const fmt = (t) => {
    if (!isFinite(t) || t < 0) t = 0;
    const m = Math.floor(t / 60), s = Math.floor(t % 60);
    return m + ':' + String(s).padStart(2, '0');
  };
  // roles: a=原视频, b=渲染后. applyLayout decides which ELEMENT holds which role (swap flips
  // it), so all timing code goes through the dynamic master/slave pair instead of hard-coded
  // element names. The slave (原视频) is offset by the render start so a window render still
  // lines up with the FULL source: orig_time = render_time + start.
  let roleA = null, roleB = null, flipped = false, offsetS = 0;
  let vM = vA, vO = vB;          // vM = rendered master, vO = original slave (+start offset)
  const onReady = (side) => { ready[side] = true; if (ready.a && ready.b && !inited) {
      inited = true;
      zoomB.disabled = false;
      alignFromMaster();                        // park slave at start+offset before any play
      if (autoNext) { autoTries = 0; autoPlay(); }   // auto-imported after a render -> start playing
      ctrl.hidden = false;
      st.hidden = false;
      st.textContent = (autoNext ? '已自动载入渲染结果 · ' : '已就绪 · ')
        + '拖动分界线对比，或点「放大对比」全屏查看';
    } };
  function applyLabels() {
    const leftOrig = !flipped;
    $('vdLabL').textContent = leftOrig ? '原视频' : '渲染后';
    $('vdLabR').textContent = leftOrig ? '渲染后' : '原视频';
  }
  function applyLayout() {
    const topSrc = flipped ? roleB : roleA;      // top/left layer
    const baseSrc = flipped ? roleA : roleB;     // base/right layer
    ready = { a: false, b: false }; inited = false;
    zoomB.disabled = true;
    vB.src = vurl(topSrc); vA.src = vurl(baseSrc);
    vM = (flipped ? vB : vA);                   // element that now plays the RENDERED clip
    vO = (flipped ? vA : vB);                   // element that plays the ORIGINAL (slave+offset)
    // default muted on both; volume slider is the only way to unmute the rendered track
    vB.muted = true; vA.muted = true; curMuted = true; setMuteIcon();
    applyLabels();
    box.classList.remove('empty');
    ctrl.hidden = true;
    setPlayIcon(true);
  }
  function load(a, b, auto, startS) {
    if (!a || !b) return;
    if (!auto) window.__vdManual = true;
    roleA = a; roleB = b; flipped = false; autoNext = !!auto;
    offsetS = parseFloat(startS) || 0;
    applyLayout();
  }
  const posOrig = (masterT) => {                 // where the original should be for a given master time
    const p = (masterT || 0) + offsetS;
    const d = vO.duration;
    return (isFinite(d) && d > 0) ? Math.min(p, d) : p;
  };
  const alignFromMaster = () => {
    if (!inited) return;
    try { vO.currentTime = posOrig(vM.currentTime); } catch (e) { /* ignore */ }
  };
  function renderTime() {
    const d = vM.duration || 0, t = vM.currentTime || 0;
    timeT.textContent = fmt(t) + ' / ' + fmt(d);
    if (!dragging && d > 0) seek.value = Math.round((t / d) * 1000);
    if (vM.ended) setPlayIcon(true);
  }
  // force=true 表示"已知暂停/结束"，不依赖 vM.paused（换源瞬间它还是旧值）
  function setPlayIcon(force) {
    const playing = force === true ? false : (vM && !vM.paused);
    setIcon(playB, playing ? 'i-pause' : 'i-play', playing ? '暂停' : '播放');
  }

  // 解码失败要说话：原来两个 <video> 都没有 error 监听，一个损坏/不可解码的文件
  // 只会留下一个黑框，放大按钮永远禁用，也不给任何解释。
  const onMediaError = (which) => {
    st.hidden = false;
    st.textContent = (which === 'b' ? '渲染后' : '原视频') + ' 无法播放（文件损坏或浏览器不支持该编码）';
    if (window.uiErr) window.uiErr('视频对比：' + (which === 'b' ? '渲染后' : '原视频') + ' 无法播放');
  };
  vA.addEventListener('error', () => onMediaError('a'));
  vB.addEventListener('error', () => onMediaError('b'));

  vA.addEventListener('loadedmetadata', () => onReady('a'));
  vB.addEventListener('loadedmetadata', () => onReady('b'));
  vA.addEventListener('canplay', () => { if (autoNext && vA.paused && autoTries < 6) { autoTries++; autoPlay(); } });
  vB.addEventListener('canplay', () => { if (autoNext && vB.paused && autoTries < 6) { autoTries++; autoPlay(); } });
  vA.addEventListener('playing', () => { autoNext = false; autoTries = 0; });
  vA.addEventListener('timeupdate', renderTime);
  vA.addEventListener('play', () => { setPlayIcon(); try { if (vB.paused) vB.play().catch(() => { }); } catch (e) { /* ignore */ } });
  vB.addEventListener('play', () => { if (!vA.paused) { /* both playing */ } });
  vA.addEventListener('pause', () => { setPlayIcon(); try { if (!vB.paused) vB.pause(); } catch (e) { /* ignore */ } });
  vB.addEventListener('pause', () => { try { if (!vA.paused) vA.pause(); } catch (e) { /* ignore */ } });
  let restarting = false;
  const playBoth = () => { kick(vM); if (vO.paused) kick(vO); };
  // NO mid-play auto realign (it stutters the picture). Alignment only at discrete moments:
  // play press, scrub, or loop restart -- and the original is always put at master_time + offset.
  const alignOnce = () => alignFromMaster();
  const restartAll = () => {
    if (restarting) return;
    restarting = true;
    try { vM.pause(); vO.pause(); } catch (e) { /* ignore */ }
    try { vM.currentTime = 0; vO.currentTime = posOrig(0); } catch (e) { /* ignore */ }
    setTimeout(() => { restarting = false; }, 150);
    playBoth();
    softAlignStart();
  };
  const maybeRestart = () => {
    const d = vM.duration;
    if (!restarting && inited && d > 0 && vM.currentTime >= d - 0.08) restartAll();
  };
  const onTick = (el) => { if (el !== vM) return; renderTime(); maybeRestart(); };
  vA.addEventListener('timeupdate', () => onTick(vA));
  vB.addEventListener('timeupdate', () => onTick(vB));
  vA.addEventListener('play', () => { setPlayIcon(); try { if (vA === vM && vO.paused) vO.play().catch(() => { }); } catch (e) { /* ignore */ } });
  vB.addEventListener('play', () => { try { if (vB === vM && vO.paused) vO.play().catch(() => { }); } catch (e) { /* ignore */ } });
  vA.addEventListener('ended', () => { if (vA === vM) restartAll(); });
  vB.addEventListener('ended', () => { if (vB === vM) restartAll(); });
  // original (slave) hitting its own tail = the compare window ended -> replay together
  vO.addEventListener('ended', () => { if (!restarting) restartAll(); });

  playB.addEventListener('click', async () => {
    if (!vA.src) return;
    if (vA.paused) {
      alignOnce();
      softAlignStart();
      playB.textContent = '…';
      try { await vM.play(); } catch (e) { /* ignore */ }
      try { if (vO.paused) await vO.play(); } catch (e) { /* ignore */ }
      setPlayIcon();
    } else { vA.pause(); vB.pause(); setPlayIcon(); }
  });
  seek.addEventListener('input', () => {
    if (!inited) return;
    dragging = true;
    const d = vM.duration || 0;
    const t = (seek.value / 1000) * d;
    try { vM.currentTime = Math.min(t, d); } catch (e) { /* ignore */ }
    try { vO.currentTime = posOrig(t); } catch (e) { /* ignore */ }
    renderTime();
  });
  seek.addEventListener('change', () => { dragging = false; });
  muteB.addEventListener('click', () => {
    curMuted = !curMuted;
    vA.muted = curMuted;
    setMuteIcon();
  });
  vol.addEventListener('input', () => { vA.volume = vol.value / 100; vA.muted = false; curMuted = false; setMuteIcon(); });

  // 分隔线：指针按住拖动 / 鼠标悬停跟随 / 键盘 ← → 可调。
  // 原来只有 mousemove，而且 mouseleave 会把分界线弹回 50% —— 想定住看左边都做不到。
  const setSplit = (pct) => {
    const p = Math.min(1, Math.max(0, pct));
    // 上层 = 原视频，必须留在分界线左边：把它的右侧裁掉
    topL.style.clipPath = 'inset(0 ' + ((1 - p) * 100) + '% 0 0)';
    div.style.left = (p * 100) + '%';
  };
  if (window.uiBindSplit) window.uiBindSplit(stage, setSplit);
  else setSplit(0.5);

  function srcOf(v) { const m = /path=([^&]*)/.exec(v.src || ''); return m ? decodeURIComponent(m[1]) : null; }
  $('vdPickA').addEventListener('click', async () => {
    const r = await fetch('/api/pick-video').then((x) => x.json());
    if (!r.ok) { if (!r.cancelled) { status('选择失败：' + (r.error || '未知原因')); } return; }
    const other = srcOf(vA);
    load(r.path, other || r.path);
    status('原视频已载入：' + (r.path.split(/[\\/]/).pop()));
  });
  $('vdPickB').addEventListener('click', async () => {
    const r = await fetch('/api/pick-video').then((x) => x.json());
    if (!r.ok) { if (!r.cancelled) { status('选择失败：' + (r.error || '未知原因')); } return; }
    const other = srcOf(vB);
    load(other || r.path, r.path);
    status('渲染后视频已载入：' + (r.path.split(/[\\/]/).pop()));
  });
  $('vdSwap').addEventListener('click', () => {
    if (!roleA || !roleB) return;
    flipped = !flipped;
    applyLayout();
  });

  // 全屏放大：复用同一套 DOM / stage / 进度条 / 分界线（不复制状态），
  // Esc 由 app-shell.js 的统一入口调用 setZoom(false)。
  const vdCard = $('vdCard'), zoomB = $('vdZoom'), zoomX = $('vdZoomClose');
  const setZoom = (on) => {
    vdCard.classList.toggle('vd-zoom', on);
    zoomB.setAttribute('aria-pressed', on ? 'true' : 'false');
    if (on) zoomX.focus();
  };
  const isZoomed = () => vdCard.classList.contains('vd-zoom');
  zoomB.addEventListener('click', () => setZoom(!isZoomed()));
  zoomX.addEventListener('click', () => setZoom(false));

  // 手动选片时给出反馈（原来 #vdStatus 永远停在"渲染完成后自动导入…"）
  function status(text) {
    st.hidden = false;
    st.textContent = text;
  }

  window.vdCompare = {
    load: load,
    setZoom: setZoom,
    isZoomed: isZoomed,
    setSplit: setSplit,
    autoload: (a, b, startS) => {
      // 新渲染完成的结果总是优先导入（队列后面的任务也一样）并自动播放。
      // startS = 渲染窗口起点（0 = 整段），用来把"完整的原视频"对齐到窗口渲染结果：
      // orig_time = t + startS。
      load(a, b, true, startS);
      status('已载入最新渲染结果 · 拖动分界线或放大对比');
    },
  };
})();
