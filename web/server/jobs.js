// The render queue: one active engine process at a time, FIFO behind it, with whole-video
// multi-pass support (「渲染次数」) and progress/log reporting for /api/status.
//
// Lifecycle of a job:
//   startJob()   -> validate, plan the passes with buildSteps(), enqueue, maybeRunNext()
//   runNextPass()-> spawn the engine for steps[passIndex]; stdout lines go to handleLine()
//   onPassDone() -> advance to the next pass, or jobFinish()
//   jobFinish()  -> drop intermediate pass outputs, record lastDone, start the next queued job
//
// Multi-pass detail: pass 1 decodes the original file (honouring the crop window); every later
// pass re-renders the FULL previous pass output as if it were a new video, so the final file is
// the N-th generation. Intermediate outputs are temp files removed when the job finishes. Each
// pass is a fresh engine process -- exactly what running the CLI N times by hand would do.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { ROOT, uniquePath, resolveExportPath } = require('./paths');
const state = require('./state');
const { findEngine, engineArgs } = require('./engine');

// Whole-video multi-pass plan. The last step is the user-visible output; earlier steps are temp
// files named <stem>.passN.tmp<ext> next to it.
function buildSteps(cfg, finalOut) {
    const passes = Math.max(1, parseInt(cfg.renderPasses, 10) || 1);
    if (passes === 1) {
        return [{ input: cfg.input, output: finalOut, window: true }];
    }
    const dir = path.dirname(finalOut);
    const ext = path.extname(finalOut) || '.mp4';
    const stem = path.basename(finalOut, ext);
    const steps = [];
    let prevOut = cfg.input;
    for (let i = 1; i <= passes; ++i) {
        const isLast = i === passes;
        const out = isLast ? finalOut : uniquePath(dir, stem + '.pass' + i + '.tmp' + ext);
        steps.push({ input: prevOut, output: out, window: i === 1 });
        prevOut = out;
    }
    return steps;
}

// Display name for a queued job: the dedicated file-name field wins, then the input basename.
function jobLabel(job) {
    const c = job.cfg || {};
    const n = (c.fileName || '').trim();
    return n ? (/\.[A-Za-z0-9]{1,5}$/.test(n) ? n : n + '.mp4') : path.basename(c.input || 'clip');
}

function queueInfo() {
    return {
        count: state.jobQueue.length,
        items: state.jobQueue.map((j) => ({
            id: j.id,
            label: jobLabel(j),
            out: j.output,
            encoder: (j.cfg && j.cfg.encoder) || '',
            passes: j.steps.length,
        })),
    };
}

function maybeRunNext() {
    if (state.current && !state.current.finished) return;      // still busy
    const nx = state.jobQueue.shift();
    if (!nx) return;
    state.current = nx;
    if (nx.steps.length > 1) {
        nx.lines.push(`whole-video multi-pass: ${nx.steps.length} full renders in series (final = ${nx.output})`);
    }
    runNextPass(nx);
}

function startJob(cfg) {
    if (!fs.existsSync(findEngine())) {
        return { ok: false, error: 'engine not found: ' + findEngine() };
    }
    // v1.3-style single-stage render: the chosen encoder writes the FINAL file directly (no
    // lossless master, no browser preview step). File name honours the dedicated file-name
    // field (or defaults to nr_<input>.mp4); the output field is a folder (or blank = outputs/).
    const inputStem = path.basename(cfg.input).replace(/\.[^.]+$/, '');
    const name = (cfg.fileName || '').trim();
    const defaultName = name
        ? (/\.[A-Za-z0-9]{1,5}$/.test(name) ? name : name + '.mp4')
        : 'nr_' + inputStem + '.mp4';
    const finalOut = resolveExportPath(cfg.output, defaultName);

    const job = {
        id: state.nextId++,
        steps: buildSteps(cfg, finalOut),
        passIndex: 0,            // which step is running (0-based)
        done: 0,
        total: 0,
        framesPerPass: 0,        // frame count of one pass, learned from the first PROGRESS line
        lines: [],
        t0: 0,                   // wall-clock ms when the engine delivered its first PROGRESS line
        t1: 0,                   // wall-clock ms when the job finished (lazily set on first status)
        finished: false,
        cancelled: false,
        code: null,
        cfg,
        output: finalOut,
        master: null,
        preview: null,
        export: null,
    };
    state.jobQueue.push(job);                        // enqueue: runs when the queue reaches it
    maybeRunNext();                                  // start now if nothing is running
    const runningNow = state.current === job && !job.finished;
    return {
        ok: true,
        id: job.id,
        output: finalOut,
        passes: job.steps.length,
        state: runningNow ? 'running' : 'queued',
        queueLen: state.jobQueue.length,
    };
}

function jobFinish(job, cancelled) {
    cleanupTemps(job);
    state.lastDone = {
        id: job.id,
        input: (job.cfg && job.cfg.input) || null,
        start: parseFloat((job.cfg && job.cfg.startTime)) || 0,
        output: job.output || null,
        code: cancelled ? null : 0,
        at: Date.now(),
    };
    if (cancelled) {
        job.lines.push('cancelled by user');
        job.cancelled = true;
        job.finished = true;
        job.code = null;
    } else {
        job.lines.push('DONE after ' + job.steps.length + ' pass(es): ' + job.output);
        job.finished = true;
        job.code = 0;
    }
    maybeRunNext();                                  // let the next queued job start
}

function runNextPass(job) {
    if (job.cancelled || job.finished || !job.steps[job.passIndex]) return;
    const step = job.steps[job.passIndex];
    const cfg = job.cfg;
    job.done = 0;
    job.total = 0;
    job.lines.push(`=== pass ${job.passIndex + 1}/${job.steps.length} ===`);

    // Whole-video multi-pass: only the first pass (from the original file) honours the crop
    // window; later passes re-render the previous pass's complete output. Each pass is a fresh
    // engine process -- exactly what running the CLI N times by hand would do.
    const exe = findEngine();
    if (!fs.existsSync(exe)) {
        cleanupTemps(job);
        job.lines.push('ERROR: engine not found: ' + exe);
        job.finished = true;
        job.code = -1;
        maybeRunNext();
        return;
    }
    let args;
    try {
        // The final step of the plan is the lossless master; all passes render to it as such.
        args = engineArgs(cfg, step.input, step.output, step.window, step.output === job.master);
    } catch (e) {
        cleanupTemps(job);
        job.lines.push('ERROR: ' + e.message);
        job.finished = true;
        job.code = -1;
        maybeRunNext();
        return;
    }
    const child = spawn(exe, args, { cwd: ROOT, windowsHide: true });
    job.child = child;
    let outBuf = '';
    child.stdout.on('data', (c) => {
        outBuf += c.toString('utf8');
        let nl;
        while ((nl = outBuf.indexOf('\n')) >= 0) {
            const line = outBuf.slice(0, nl).replace(/\r$/, '');
            outBuf = outBuf.slice(nl + 1);
            handleLine(job, line);
        }
    });
    let errBuf = '';
    child.stderr.on('data', (c) => {
        errBuf += c.toString('utf8');
        if (errBuf.length > 8000) errBuf = errBuf.slice(-8000);
    });
    child.on('error', (e) => {
        if (job.child !== child) return;
        job.child = null;
        if (!job.cancelled && !job.finished) {
            cleanupTemps(job);
            job.lines.push('ERROR: engine failed to start: ' + e.message);
            job.finished = true;
            job.code = -1;
            maybeRunNext();
        }
    });
    child.on('close', (code) => {
        if (job.child === child) job.child = null;
        onPassDone(job, code);
    });
}

function onPassDone(job, code) {
    if (job !== state.current || job.finished) return;
    if (job.cancelled) {
        jobFinish(job, true);
        return;
    }
    if (code === 0) {
        job.passIndex++;
        if (job.passIndex < job.steps.length) {
            runNextPass(job);
        } else {
            jobFinish(job, false);
        }
    } else {
        cleanupTemps(job);
        job.lines.push('ERROR: engine exit code ' + (code === null ? -1 : code) + ' (see log above)');
        job.finished = true;
        job.code = code === null ? -1 : code;
        maybeRunNext();
    }
}

// Removes every intermediate (non-final) step output. Best effort.
// NOTE: the drag-and-drop source upload is intentionally NOT deleted here. Previously it was
// removed once its job finished, which broke the compare/preview player (the preview streams the
// same temp file, so it died right after a render). Now uploads are only purged at server start
// and when the user drops/picks a *different* file (see tempfiles.purgeUploads).
function cleanupTemps(job) {
    for (let i = 0; i < job.steps.length - 1; ++i) {
        const p = job.steps[i].output;
        try {
            if (fs.existsSync(p)) fs.unlinkSync(p);
        } catch (e) { /* ignore */ }
    }
}

function handleLine(job, line) {
    if (!line) return;

    // Progress lines drive the bar/percent and must not accumulate in the log as frame spam.
    const m = /^PROGRESS\s+(\d+)\/(\d+)/.exec(line);
    if (m) {
        job.done = parseInt(m[1], 10);
        job.total = parseInt(m[2], 10);
        if (job.total > 0) job.framesPerPass = job.total;
        if (!job.t0) job.t0 = Date.now();   // first decoded/rendered frame: cold start excluded
        return;
    }

    job.lines.push(line);
    if (job.lines.length > 300) job.lines.shift();
}

module.exports = { startJob, jobFinish, queueInfo };
