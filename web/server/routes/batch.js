// /api/image-batch* -- rendering a whole folder of stills.
//
// This is a separate async task from the video queue (it renders stills through renderStillOnce,
// not through the video pipeline), so it owns its own progress object. Only one batch may run at
// a time, and it is resumable: a file whose output already exists is counted as "skip" rather
// than re-rendered.
const fs = require('fs');
const path = require('path');
const { sendJson, readBody } = require('../http');
const { BATCH_FMT_EXT, walkImages, runImageBatch, getBatch, setBatch } = require('../batch');

module.exports = [
    // Start an async whole-folder image render batch.
    ['POST', '/api/image-batch', async (req, res) => {
        const body = await readBody(req);
        const dir = (body.dir || '').trim();
        const format = String(body.format || 'png').toLowerCase();
        if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
            return sendJson(res, 400, { ok: false, error: '文件夹不存在' });
        }
        if (!BATCH_FMT_EXT[format]) return sendJson(res, 400, { ok: false, error: '不支持的输出格式' });
        const running = getBatch();
        if (running && running.running) {
            return sendJson(res, 409, { ok: false, error: '已有批量任务在运行' });
        }
        const files = walkImages(dir);
        if (!files.length) return sendJson(res, 400, { ok: false, error: '该文件夹下未找到图片' });
        const wantOut = String(body.outDir || '').trim();
        const outDir = wantOut ? wantOut : path.join(dir, 'nr_' + path.basename(dir));
        try { fs.mkdirSync(outDir, { recursive: true }); } catch (e) { /* ignore */ }
        setBatch({
            running: true, cancel: false, done: false, dir, outDir, fmt: format,
            files, total: files.length, idx: 0, ok: 0, skip: 0, failed: [],
            current: null, cfg: body.cfg || {},
        });
        runImageBatch();
        return sendJson(res, 200, { ok: true, total: files.length, outDir });
    }],

    // Poll progress of the current image batch.
    ['GET', '/api/image-batch', async (req, res) => {
        const b = getBatch();
        if (!b) return sendJson(res, 200, { running: false });
        return sendJson(res, 200, {
            running: b.running,
            done: b.done,
            cancelled: b.cancel && !b.running,
            total: b.total,
            idx: b.idx,
            current: b.current,
            ok: b.ok,
            skip: b.skip,
            failed: b.failed.slice(-8),
            outDir: b.outDir,
        });
    }],

    // Cancel a running image batch (current image finishes, rest skipped).
    ['POST', '/api/image-batch/cancel', async (req, res) => {
        const b = getBatch();
        if (b) b.cancel = true;
        return sendJson(res, 200, { ok: true });
    }],
];
