// /api/status and /api/info -- what the page polls to stay alive and to learn the project root.
const fs = require('fs');
const { ROOT, OUTPUTS_DIR } = require('../paths');
const { sendJson } = require('../http');
const state = require('../state');
const { exporter } = require('../export');
const { queueInfo } = require('../jobs');

module.exports = [
    // The page polls this every ~500ms while open; that poll is also the UI-liveness signal used
    // by the idle sweep in server.js, so it is recorded before anything else can fail.
    ['GET', '/api/status', async (req, res, url) => {
        state.uiLastPoll = Date.now();
        const j = state.current;
        if (!j) {
            return sendJson(res, 200, {
                running: false, lines: [], lineCount: 0, lineFrom: 0, lineSeq: 0,
                queue: queueInfo(), lastDone: state.lastDone,
            });
        }
        let outputSize = null;
        if (j.output && fs.existsSync(j.output)) {
            try { outputSize = fs.statSync(j.output).size; } catch (e) {}
        }
        // Whole-video multi-pass overall progress. Every pass renders the same frame count, so
        // cumulative frames = finished passes * framesPerPass + current pass progress. A
        // successfully finished job is exactly 100% (passIndex already points past the last pass,
        // which would otherwise double-count its progress).
        const fp = j.framesPerPass || 0;
        const overallTotal = fp * j.steps.length;
        const overallDone = (j.finished && j.code === 0)
            ? overallTotal
            : (fp > 0 ? j.passIndex * fp + j.done : j.done);
        // Throughput + ETA. t0 is the moment the engine produced its first frame (after cold
        // start / NVOF init), so the rate reflects actual render speed. t1 is lazily fixed the
        // first time a finished job is polled.
        const nowMs = Date.now();
        if (j.finished && !j.t1) j.t1 = nowMs;
        const endMs = j.finished ? (j.t1 || nowMs) : nowMs;
        const elapsedSec = Math.max(0, (endMs - (j.t0 || endMs)) / 1000);
        const avgFps = (elapsedSec >= 1 && overallDone > 0) ? overallDone / elapsedSec : 0;
        const etaSec = (!j.finished && avgFps > 0 && overallTotal > overallDone)
            ? Math.round((overallTotal - overallDone) / avgFps)
            : 0;
        // Incremental log lines. `since` is an ABSOLUTE line sequence number, not an index: the
        // job's lines[] is capped at 300, so an index would silently stop matching after a wrap.
        // lineFrom is the seq of lines[0]; anything the client asks for that falls outside the
        // buffer (first poll of a NEW job, or a client that fell more than 300 lines behind) gets
        // the whole buffer instead of an empty or wrong slice.
        const since = Math.max(0, parseInt(url.searchParams.get('since') || '0', 10));
        const lineFrom = j.lineSeq - j.lines.length;
        const inRange = since >= lineFrom && since <= j.lineSeq;
        const lines = inRange ? j.lines.slice(since - lineFrom) : j.lines.slice();
        return sendJson(res, 200, {
            running: !j.finished,
            id: j.id,
            done: j.done,
            total: j.total,
            pass: Math.min(j.passIndex + 1, j.steps.length),
            passes: j.steps.length,
            overallDone,
            overallTotal,
            avgFps: Math.round(avgFps * 10) / 10,
            etaSec,
            elapsedSec: Math.round(elapsedSec),
            finished: j.finished,
            code: j.code,
            output: j.output || null,
            master: j.master || null,
            preview: j.preview || null,
            export: {
                running: exporter.running,
                pct: exporter.pct,
                encoder: exporter.encoder,
                out: exporter.out,
                error: exporter.error,
            },
            outputSize,
            lines,
            lineCount: j.lines.length,
            lineFrom,
            lineSeq: j.lineSeq,
            queue: queueInfo(),
            lastDone: state.lastDone,
        });
    }],

    // Lightweight bootstrap endpoint: returns the project root so the page can compose default
    // output paths (<ROOT>/outputs/nr_<stem>.<ext>) without the user typing them.
    ['GET', '/api/info', async (req, res) => {
        return sendJson(res, 200, { ok: true, root: ROOT, outputs: OUTPUTS_DIR });
    }],
];
