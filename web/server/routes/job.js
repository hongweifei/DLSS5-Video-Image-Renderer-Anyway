// The render queue's control surface: start a job, reorder/remove queued jobs, cancel, and shut
// the service down. All of these read or mutate the shared queue state in ../state.
const fs = require('fs');
const path = require('path');
const { sendJson, readBody } = require('../http');
const state = require('../state');
const { startJob, jobFinish, queueInfo } = require('../jobs');
const { walkVideos } = require('../batch');
const { cleanFrameDir, cleanUploadsDir } = require('../tempfiles');

module.exports = [
    ['POST', '/api/start', async (req, res) => {
        const body = await readBody(req);
        if (!body.input) {
            return sendJson(res, 400, { ok: false, error: 'input is required' });
        }
        const _st = parseFloat(body.startTime) || 0;
        const _et = parseFloat(body.endTime) || 0;
        if (_st < 0 || _et < 0) {
            return sendJson(res, 400, { ok: false, error: '开始/结束时间不能为负数' });
        }
        if (_et > 0 && _et <= _st) {
            return sendJson(res, 400, { ok: false, error: '结束时间必须大于开始时间 (' + _st + 's -> ' + _et + 's)' });
        }
        return sendJson(res, 200, startJob(body));
    }],

    ['POST', '/api/queue-order', async (req, res) => {
        const body = await readBody(req);
        const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
        const cur = state.jobQueue.map((j) => String(j.id));
        const same = ids.length === cur.length &&
            ids.every((x) => cur.includes(x)) && cur.every((x) => ids.includes(x));
        if (same) {
            state.jobQueue.sort((a, b) => ids.indexOf(String(a.id)) - ids.indexOf(String(b.id)));
            return sendJson(res, 200, { ok: true, queue: queueInfo() });
        }
        return sendJson(res, 200, { ok: false, error: 'id 列表与当前队列不一致' });
    }],

    ['POST', '/api/queue-remove', async (req, res) => {
        const body = await readBody(req);
        const idx = state.jobQueue.findIndex((j) => String(j.id) === String(body.id));
        if (idx >= 0) {
            state.jobQueue.splice(idx, 1);
            return sendJson(res, 200, { ok: true, queue: queueInfo() });
        }
        return sendJson(res, 200, { ok: false, error: 'job not in queue (running jobs need 停止)' });
    }],

    // Move ONE queued job one step up/down (fixed queue + per-row ▲/▼ reorder).
    ['POST', '/api/queue-move', async (req, res) => {
        const body = await readBody(req);
        const idx = state.jobQueue.findIndex((j) => String(j.id) === String(body.id));
        const dir = body.dir === 'up' ? -1 : 1;
        const to = idx + dir;
        if (idx >= 0 && to >= 0 && to < state.jobQueue.length) {
            const [j] = state.jobQueue.splice(idx, 1);
            state.jobQueue.splice(to, 0, j);
        }
        return sendJson(res, 200, { ok: true, queue: queueInfo() });
    }],

    // Formal "exit" button: stop any running render, release every disposable cache, then end
    // the process. The guard console notices the child exit and closes too.
    ['POST', '/api/exit', async (req, res) => {
        try {
            if (state.current && state.current.child) { state.current.child.kill(); }
        } catch (e) { /* ignore */ }
        state.current = null;
        state.jobQueue.length = 0;
        cleanFrameDir();
        cleanUploadsDir();
        setTimeout(() => process.exit(0), 300);
        return sendJson(res, 200, { ok: true });
    }],

    ['POST', '/api/cancel', async (req, res) => {
        if (state.current && !state.current.finished) {
            state.current.cancelled = true;
            if (state.current.child) {
                try { state.current.child.kill(); } catch (e) { /* ignore */ }
            } else {
                // Between passes no engine process is alive: close the job right away. (The child
                // close callback handles the running-pass case via onPassDone -> jobFinish.)
                jobFinish(state.current, true);
            }
        }
        return sendJson(res, 200, { ok: true });
    }],

    // Video batch: recursively find videos under the chosen folder and push EACH one into the
    // normal render queue with a snapshot of the current render parameters (same progress bar).
    ['POST', '/api/video-batch', async (req, res) => {
        const body = await readBody(req);
        const inputDir = (body.inputDir || '').trim();
        if (!fs.existsSync(inputDir) || !fs.statSync(inputDir).isDirectory()) {
            return sendJson(res, 400, { ok: false, error: '输入文件夹不存在' });
        }
        const files = walkVideos(inputDir);
        if (!files.length) return sendJson(res, 400, { ok: false, error: '该文件夹下未找到视频' });
        const wantOut = String(body.outDir || '').trim();
        const outDir = wantOut || path.join(inputDir, 'nr_' + path.basename(inputDir));
        try { fs.mkdirSync(outDir, { recursive: true }); } catch (e) { /* ignore */ }
        const baseCfg = (body.jobCfg && typeof body.jobCfg === 'object') ? body.jobCfg : {};
        let pushed = 0;
        const errs = [];
        for (const file of files) {
            const jobCfg = Object.assign({}, baseCfg, {
                input: file,
                output: outDir,
                fileName: '',
                startTime: 0,
                endTime: 0,
            });
            const r = startJob(jobCfg);
            if (r && r.ok) pushed++;
            else errs.push(path.basename(file) + ':' + ((r && r.error) || '?'));
        }
        return sendJson(res, 200, { ok: true, total: files.length, pushed, outDir, failed: errs.slice(0, 6) });
    }],
];
