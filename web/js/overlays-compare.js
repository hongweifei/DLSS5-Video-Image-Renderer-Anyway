// 视频对比播放器（自包含 IIFE）
// 视频对比播放器（自包含 IIFE） — 见文件内注释
//
// 由 tools/split-web.js 从原 index.html 的内联 <script> 机械拆分而成：
// 分块连续且顺序不变，因此执行语义与拆分前完全一致。
// 全部文件共享同一全局作用域（非 ES module），互相可以直接引用。

// ----------------------------------------------------------------- video side-by-side compare
(function () {
  const $ = (id) => document.getElementById(id);
(function () {
  document.querySelectorAll('input, textarea').forEach((el) => {
    el.setAttribute('autocomplete', 'off');
    el.setAttribute('autocorrect', 'off');
    el.setAttribute('autocapitalize', 'off');
    el.setAttribute('spellcheck', 'false');
  });
})();
  const vB = $('vdBefore'), vA = $('vdAfter');       // vB = rendered-before (top-left), vA = after (base)
  const box = $('vdBox'), stage = $('vdStage'), topL = $('vdTop'), div = $('vdDivider');
  const playB = $('vdPlay'), seek = $('vdSeek'), timeT = $('vdTime');
  const vol = $('vdVol'), muteB = $('vdMute'), ctrl = $('vdCtrl'), st = $('vdStatus');
  let ready = { a: false, b: false };
  let dragging = false, syncing = false, curMuted = true, inited = false, autoNext = false;
  window.__vdManual = false;             // user picked videos manually -> don't auto-overwrite
  window.__vdAutoDone = false;
  let autoTries = 0;
  const muteAll = () => { vB.muted = true; vA.muted = true; curMuted = true; muteB.textContent = '🔇'; };
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
    vB.muted = true; vA.muted = true; curMuted = true; muteB.textContent = '🔇';
    applyLabels();
    box.classList.remove('empty');
    ctrl.hidden = true;
    playB.textContent = '▶';
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
    if (vM.ended) playB.textContent = '▶';
  }
  function setPlayIcon() { playB.textContent = (vM && !vM.paused) ? '⏸' : '▶'; }

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
    muteB.textContent = curMuted ? '🔇' : '🔊';
  });
  vol.addEventListener('input', () => { vA.volume = vol.value / 100; vA.muted = false; curMuted = false; muteB.textContent = '🔊'; });

  // mouse-driven split (hover & drag both work)
  const setSplit = (pct) => {
    const p = Math.min(1, Math.max(0, pct));
    // top layer = 原视频 must stay LEFT of the divider: clip away its RIGHT side
    topL.style.clipPath = 'inset(0 ' + ((1 - p) * 100) + '% 0 0)';
    div.style.left = (p * 100) + '%';
  };
  stage.addEventListener('mousemove', (e) => {
    const r = stage.getBoundingClientRect();
    if (r.width > 0) setSplit((e.clientX - r.left) / r.width);
  });
  stage.addEventListener('mouseleave', () => setSplit(0.5));
  setSplit(0.5);

  function srcOf(v) { const m = /path=([^&]*)/.exec(v.src || ''); return m ? decodeURIComponent(m[1]) : null; }
  $('vdPickA').addEventListener('click', async () => {
    const r = await fetch('/api/pick-video').then((x) => x.json());
    if (!r.ok) { if (!r.cancelled) { st.style.display=''; st.textContent = '选择失败: ' + (r.error || '?'); } return; }
    const other = srcOf(vA);
    load(r.path, other || r.path);
  });
  $('vdPickB').addEventListener('click', async () => {
    const r = await fetch('/api/pick-video').then((x) => x.json());
    if (!r.ok) { if (!r.cancelled) { st.style.display=''; st.textContent = '选择失败: ' + (r.error || '?'); } return; }
    const other = srcOf(vB);
    load(other || r.path, r.path);
  });
  $('vdSwap').addEventListener('click', () => {
    if (!roleA || !roleB) return;
    flipped = !flipped;
    applyLayout();
  });

  // Full-screen zoom compare: reuses the SAME dom/stage/scrubber/divider (no duplicated state).
  const vdCard = $('vdCard'), zoomB = $('vdZoom'), zoomX = $('vdZoomClose');
  const setZoom = (on) => {
    vdCard.classList.toggle('vd-zoom', on);
    zoomB.textContent = on ? '✕ 退出放大' : '放大对比';
  };
  zoomB.addEventListener('click', () => setZoom(!vdCard.classList.contains('vd-zoom')));
  zoomX.addEventListener('click', () => setZoom(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && vdCard.classList.contains('vd-zoom')) setZoom(false);
  });

  window.vdCompare = {
    load: load,
    autoload: (a, b, startS) => {
      // A freshly finished render always wins (also for later jobs in the queue): import the new
      // pair and autoplay. startS = render window start (0 = full clip), used to keep the FULL
      // original aligned with a windowed render (orig_time = t + startS).
      window.__vdManual = false;
      load(a, b, true, startS);
    },
  };
})();
