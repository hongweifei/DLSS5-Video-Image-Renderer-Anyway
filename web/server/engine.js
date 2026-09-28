// The C++ engine: locating the executable, resolving which model pair a job wants, translating a
// job config into argv, and running a one-shot invocation.
//
// The engine is a plain command line tool that reports progress on stdout as "PROGRESS d/t"
// lines; the long-running queue path owns its own spawn loop (see jobs.js) and only borrows
// engineArgs/findEngine from here.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { ROOT, MODELS_DIR } = require('./paths');

// Resolves the engine executable at job-start time (not module load) so a rebuild is picked
// up automatically. Search order matches start_ui.bat:
//   1. <root>/build/    - developer build produced by src/build.ps1
//   2. <root>/          - release package (engine beside the launcher)
//   3. <root>/core/     - legacy layout predating the build/ directory
// Within each directory the canonical name wins, then any dlss5nr*.exe, so a one-off rename
// used to dodge a locked-by-zombie exe never breaks the UI.
function findEngine() {
    const dirs = [
        path.join(ROOT, 'build'),
        ROOT,
        path.join(ROOT, 'core'),
    ];
    const candidates = ['dlss5nr_engine.exe', 'dlss5nr_run.exe', 'dlss5nr_app.exe', 'dlss5nr_core.exe', 'dlss5nr.exe'];
    for (const dir of dirs) {
        for (const c of candidates) {
            const p = path.join(dir, c);
            if (fs.existsSync(p)) return p;
        }
        try {
            const files = fs.readdirSync(dir).filter((f) => /^dlss5nr.*\.exe$/i.test(f));
            if (files.length) return path.join(dir, files[0]);
        } catch (e) { /* ignore */ }
    }
    // Reported only if it truly does not exist; keeps the error message concrete.
    return path.join(ROOT, 'build', 'dlss5nr_engine.exe');
}

// Resolves the NR model dll + forwarder pair for a job. cfg.model selects the precision
// ('fp16' | 'fp8' | 'auto'); an explicit cfg.snippet / cfg.forwarder (absolute or ROOT-relative)
// overrides the auto-selection. Throws with a clear message when the requested model is missing
// so the caller can surface it in the UI instead of failing deep inside the engine.
function resolveModelFiles(cfg) {
    const exist = (p) => fs.existsSync(p);
    // Bare filenames resolve against models/ (the current layout); anything containing a path
    // separator stays ROOT-relative / absolute for backward compatibility with explicit configs.
    const abs = (p) => {
        if (path.isAbsolute(p)) return p;
        if (!p.includes('/') && !p.includes('\\')) return path.join(MODELS_DIR, p);
        return path.join(ROOT, p);
    };
    if (cfg.snippet) {
        const snippet = abs(cfg.snippet);
        const forwarder = cfg.forwarder
            ? abs(cfg.forwarder)
            : path.join(path.dirname(snippet), 'nvngx.dll' + path.basename(snippet).slice(6));
        if (!exist(snippet)) throw new Error('模型文件不存在: ' + snippet);
        if (!exist(forwarder)) throw new Error('模型配套 forwarder 不存在: ' + forwarder);
        return { snippet, forwarder };
    }
    const want = String(cfg.model || 'auto').toLowerCase();
    const pairs = want === 'fp16'
        ? [['nvngx_dlssnr_fp16.dll', 'nvngx.dll_dlssnr_fp16.dll'],
           ['nvngx_dlssnr.dll', 'nvngx.dll_dlssnr.dll']]
        : want === 'fp8'
            ? [['nvngx_dlssnr_fp8.dll', 'nvngx.dll_dlssnr_fp8.dll']]
            : [['nvngx_dlssnr.dll', 'nvngx.dll_dlssnr.dll'],
               ['nvngx_dlssnr_fp16.dll', 'nvngx.dll_dlssnr_fp16.dll'],
               ['nvngx_dlssnr_fp8.dll', 'nvngx.dll_dlssnr_fp8.dll']];
    for (const [s, f] of pairs) {
        const sn = path.join(MODELS_DIR, s), fw = path.join(MODELS_DIR, f);
        if (exist(sn) && exist(fw)) return { snippet: sn, forwarder: fw };
    }
    throw new Error('未找到 ' + (want === 'auto' ? '任何' : want.toUpperCase() + ' 精度') +
        ' 模型。请在 models/ 目录放置 nvngx_dlssnr*.dll 及其配套 nvngx.dll_dlssnr*.dll');
}

// Builds the engine argv for one pass. `master` selects the lossless 10-bit master encoder
// instead of the user's choice; `useWindow` gates the crop window (later multi-pass steps
// re-render the previous pass in full, so they must not re-apply it).
function engineArgs(cfg, input, output, useWindow, master) {
    const { snippet, forwarder } = resolveModelFiles(cfg);
    const args = [
        '--input', input,
        '--output', output,
        '--snippet', snippet,
        '--forwarder', forwarder,
        '--encoder', master ? 'hevc10_lossless' : (cfg.encoder || 'h264_nvenc'),
        '--preset', String(cfg.preset ?? 0),
        '--intensity', String(cfg.intensity ?? 1.0),
        '--style', String(cfg.style ?? 0),
        '--local-tone', String(cfg.localTone ?? 1.0),
        '--local-structure', String(cfg.localStructure ?? 1.0),
        '--skin-structure', String(cfg.skinStructure ?? 0.5),
        '--auto-mask', String(cfg.autoMask ?? 1),
        '--ui-correction', String(cfg.uiCorrection ?? 0),
    ];
    if (useWindow) {
        if (cfg.startTime > 0) args.push('--start-time', String(cfg.startTime));
        if (cfg.endTime > 0) args.push('--end-time', String(cfg.endTime));
    }
    if (!master && cfg.codecArgs) args.push('--codec-args', cfg.codecArgs);
    if (!master && cfg.pixFmt) args.push('--pix-fmt', cfg.pixFmt);
    args.push('--residual-mult', String(cfg.residualMult ?? 1.0));
    args.push('--frame-guidance', String(cfg.frameGuidance ?? 3));
    if (cfg.frameGuidance !== 0 && cfg.mvecQuality !== undefined && cfg.mvecQuality !== 2)
        args.push('--mvec-quality', String(cfg.mvecQuality));
    const _gi = parseInt(cfg.gpuIdx, 10);
    if (!isNaN(_gi) && _gi >= 0) args.push('--gpu-idx', String(_gi));
    args.push('--depth-interval', String(cfg.depthInterval ?? 0));
    return args;
}

// Single-shot engine wrapper for the instant-render helpers (compare-frame & export-image).
// The engine prints diagnostics to STDOUT (printf "ERROR ..."), so a non-zero exit surfaces the
// tail of its stdout -- otherwise the UI would only ever show a bare "engine exit <code>".
function runEngine(exe, args) {
    return new Promise((ok, bad) => {
        const p = spawn(exe, args, { cwd: ROOT, windowsHide: true });
        let out = '', err = '';
        // Guard against an engine that hangs (GPU/driver stall, e.g. a device that never
        // completes a fence). Without this the UI would spin on "渲染中/引擎冷启动" forever.
        // 10 minutes of total silence is far beyond any real first-frame latency; treat it as
        // a hang, kill the child and surface a clear error instead of waiting indefinitely.
        const HANG_MS = 10 * 60 * 1000;
        const killTimer = setTimeout(() => {
            try { p.kill(); } catch (e) { /* ignore */ }
            const tail = [...out.split(/\r?\n/), ...err.split(/\r?\n/)]
                .map((s) => s.trim()).filter((s) => s).slice(-4).join(' | ');
            bad(new Error('engine hung (no output for 10 min) — GPU/driver may be stalled'
                + (tail ? '. Last lines: ' + tail : '')));
        }, HANG_MS);
        // First-output watchdog: if the engine produces NOTHING within 45s of launch it is
        // almost certainly stuck during startup (D3D device / driver init) — the classic
        // "一直提示正在渲染, 然后完全没反应" symptom. Kill it and say so instead of hanging.
        let gotAny = false;
        const firstTimer = setTimeout(() => {
            if (gotAny) return;
            try { p.kill(); } catch (e) { /* ignore */ }
            bad(new Error('engine produced no output within 45s — likely stuck during GPU/driver '
                + 'initialisation. Check the graphics driver, or try a different 渲染显卡 / model. '
                + (err ? 'stderr: ' + err.trim().slice(-200) : '')));
        }, 45000);
        // Any progress output resets the watchdog: a render that is producing frames is alive.
        p.stdout.on('data', (c) => { gotAny = true; clearTimeout(firstTimer); killTimer.refresh(); out += c.toString('utf8'); if (out.length > 65536) out = out.slice(-65536); });
        p.stderr.on('data', (c) => { err += c.toString('utf8'); if (err.length > 65536) err = err.slice(-65536); });
        p.on('close', (code) => {
            clearTimeout(killTimer); clearTimeout(firstTimer);
            if (code === 0) return ok();
            const detail = [...out.split(/\r?\n/), ...err.split(/\r?\n/)]
                .map((s) => s.trim())
                .filter((s) => s && /error|failed|exit|unable|cannot|not found|no |refused|abort/i.test(s))
                .slice(-8)
                .join(' | ');
            bad(new Error('engine exit ' + (code === null ? -1 : code) + (detail ? ' — ' + detail : '')));
        });
        p.on('error', (e) => { clearTimeout(killTimer); clearTimeout(firstTimer); bad(e); });
    });
}

module.exports = { findEngine, resolveModelFiles, engineArgs, runEngine };
