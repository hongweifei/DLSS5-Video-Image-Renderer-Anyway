// Local web service for the DLSS5 NR renderer.
//
// Zero third-party dependencies, no build step: this file is the process entry point launched by
// start_ui.bat / server_guard.exe (both also locate the project root by looking for exactly this
// path, so do not move or rename it). The C++ core is a plain command line tool that reports
// progress on stdout as "PROGRESS <done>/<total>" lines; the service wraps it with static file
// serving, a render-queue API, and a status endpoint the page polls.
//
// Everything lives under web/server/:
//   paths.js      every filesystem location + output-path helpers
//   state.js      the shared render-queue singletons
//   http.js       JSON responses, body parsing, MIME maps
//   tempfiles.js  disposable upload/frame directories
//   engine.js     locating + running the engine, job config -> argv
//   media.js      ffmpeg/ffprobe wrappers
//   export.js     re-encoding a finished render
//   meta.js       embedded render-parameter metadata
//   dialog.js     native Windows dialogs, browser launch
//   jobs.js       the render queue state machine
//   batch.js      still-image rendering + folder walkers
//   routes/       one module per group of API routes, plus the static fallback
//
// This file only does what has to happen once per process: pick a port, bind, report, and run the
// idle sweep.
const http = require('http');
const fs = require('fs');
const { PORT, OUTPUTS_DIR } = require('./server/paths');
const state = require('./server/state');
const { cleanUploadsDir, cleanFrameDir, cleanFrameDirOlder } = require('./server/tempfiles');
const { openBrowser } = require('./server/dialog');
const { handler } = require('./server/routes');

// Bind to localhost only: the download/open endpoints serve arbitrary absolute paths, and a
// LAN-reachable server must not be able to leak local files.
const BASE_PORT = Number(PORT) || 8777;

// Bind on the base port; if it cannot be taken, walk a candidate list instead of failing.
//
// Two distinct failure codes matter on Windows:
//   EADDRINUSE - a leftover instance still owns the port (very common: "网页打不开").
//   EACCES     - the port sits inside an OS-reserved dynamic range. Enabling WSL/Hyper-V makes
//                Windows reserve whole blocks (e.g. 8729-8828 covers the default 8777), and
//                nothing in the app can ever bind there. Stepping +1 is useless inside a
//                reserved block, so the candidate list JUMPS over the block.
//
// The candidates keep the familiar 8777 first (most machines are unaffected), then try a span
// well clear of the typical reserved ranges.
const PORT_CANDIDATES = (() => {
    const list = [];
    const add = (p) => { if (p > 0 && p < 65536 && !list.includes(p)) list.push(p); };
    add(BASE_PORT);
    for (let i = 1; i <= 20; i++) add(BASE_PORT + i);   // in case only neighbours are busy
    // Ports outside the ranges Windows commonly reserves for Hyper-V/WSL (see
    // `netsh interface ipv4 show excludedportrange protocol=tcp`).
    for (const p of [9788, 9888, 17999, 18555, 27999, 39876, 45123, 47777]) add(p);
    for (let p = 48000; p < 48100; p++) add(p);
    return list;
})();

// Try each candidate with a THROWAWAY server instance. Reusing one server object across failed
// listen() calls leaves stale 'error' listeners behind, warns with MaxListenersExceededWarning
// and lets a later successful bind race with the earlier callbacks - so each attempt gets a
// fresh instance and the first one that binds is kept.
function bindServer(attempt) {
    const idx = attempt || 0;
    if (idx >= PORT_CANDIDATES.length) {
        console.error('服务启动失败: 已尝试 ' + PORT_CANDIDATES.length + ' 个端口均不可用。' +
            '请检查残留进程，或用 PORT=其他端口 指定' +
            '（netsh interface ipv4 show excludedportrange protocol=tcp 可查看系统保留段）。');
        process.exit(1);
    }
    const port = PORT_CANDIDATES[idx];
    const probe = http.createServer(handler);
    probe.once('error', (err) => {
        const code = err && err.code;
        if ((code === 'EADDRINUSE' || code === 'EACCES') && idx + 1 < PORT_CANDIDATES.length) {
            const why = code === 'EACCES'
                ? '在系统保留的端口段内（启用 WSL/Hyper-V 后常见）'
                : '被占用（可能是上次没完全退出）';
            console.log('端口 ' + port + ' ' + why + '，尝试端口 ' + PORT_CANDIDATES[idx + 1]);
            probe.close(() => bindServer(idx + 1));
        } else {
            console.error('服务启动失败: ' + (err && err.message));
            process.exit(1);
        }
    });
    probe.listen(port, '127.0.0.1', () => {
        onListening(port);
    });
}

// Runs once the socket is live: report the URL, prepare the cache dirs and (for --open) launch
// the browser. Kept separate from bindServer so the retry loop stays readable.
function onListening(port) {
    const url = 'http://127.0.0.1:' + port + '/';
    console.log('DLSS5NR 视频渲染服务 v1.5 已启动 — Web 界面: ' + url);
    fs.mkdirSync(OUTPUTS_DIR, { recursive: true });
    cleanUploadsDir();   // fallback only: normal shutdown cleanup is done by server_guard.exe
    cleanFrameDir();     // fallback only: normal shutdown cleanup is done by server_guard.exe
    // When launched from start_ui.bat (--open), open the browser ourselves once the socket is
    // live. Doing it in-process removes the fragile "wait for port then start" dance
    // from the batch file, which was silently failing and leaving no browser open.
    if (process.argv.includes('--open')) {
        setTimeout(() => openBrowser(url), 500);
    }
    // Idle sweep: page gone (no polls) + no running/fresh job -> drop the disposable cache.
    setInterval(() => {
        const idleMs = Date.now() - state.uiLastPoll;
        const jobBusy = state.current && !state.current.finished;
        const jobFresh = state.current && (Date.now() - (state.current.t1 || 0)) < 30000;
        if (!jobBusy && !jobFresh && idleMs > state.uiIdleGraceMs) {
            // Browser-closed cleanup, but keep anything newer than 10 minutes: the user may
            // have just rendered an image and still be looking at it / about to save it.
            cleanFrameDirOlder(10 * 60 * 1000);
        }
    }, 15000);
}

bindServer(0);
