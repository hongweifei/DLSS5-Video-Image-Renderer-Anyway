// Still-image rendering and the two folder walkers.
//
// renderStillOnce() is the shared still-image primitive: the engine's NR pipeline is a video
// pipeline (it needs a video reader + encoder even for one frame), so a still is looped into a
// tiny lossless 3-frame clip, rendered, and the first frame is exported back to PNG. It is used
// both by the single-image compare view and by the whole-folder batch.
const fs = require('fs');
const path = require('path');
const { FRAME_DIR } = require('./paths');
const { IMAGE_EXT, VIDEO_EXT } = require('./tempfiles');
const { findEngine, engineArgs, runEngine } = require('./engine');
const { runFfmpeg } = require('./media');
const { readRenderMeta, stampRenderMeta } = require('./meta');

const BATCH_FMT_EXT = { png: '.png', jpg: '.jpg' };

// Recursively collects still images under a folder (skipping anything that looks like one of our
// own nr_* output folders). Existing outputs are skipped by the batch so an interrupted run can
// be re-run to continue where it left off.
function walkImages(dir) {
    let list = [];
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return list; }
    for (const ent of entries) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) {
            const bn = ent.name.toLowerCase();
            if (bn.startsWith('nr_') || bn.endsWith('_nr')) continue;   // our output folders
            list = list.concat(walkImages(p));
        } else if (IMAGE_EXT.includes(path.extname(ent.name).toLowerCase())) {
            list.push(p);
        }
    }
    return list;
}

// Recursively collect video files under a folder (skipping our own nr_* output dirs).
function walkVideos(dir) {
    let list = [];
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return list; }
    for (const ent of entries) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) {
            const bn = ent.name.toLowerCase();
            if (bn.startsWith('nr_') || bn.endsWith('_nr')) continue;
            list = list.concat(walkVideos(p));
        } else if (VIDEO_EXT.includes(path.extname(ent.name).toLowerCase())) {
            list.push(p);
        }
    }
    return list;
}

// Render one still image (or one canvas frame) through the engine, optionally repeated
// renderPasses times in a generative loop: pass 1 renders the input image, every later pass
// renders the previous pass's output PNG as if it were a brand-new still, so the result is the
// N-th generation of model enhancement — the still-image analogue of the whole-video 渲染次数.
// Each pass is a fresh engine process; the returned path is the final pass's PNG.
async function renderStillOnce(inputImg, cfg) {
    fs.mkdirSync(FRAME_DIR, { recursive: true });
    const passes = Math.max(1, parseInt((cfg || {}).renderPasses, 10) || 1);
    const ts = Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    let curInput = inputImg;
    let prevOutput = null;   // intermediate pass output, removed once the next pass copied it
    let finalPng = null;
    for (let pass = 1; pass <= passes; ++pass) {
        const safeImg = path.join(FRAME_DIR, `safeimg_${ts}_p${pass}` +
            (path.extname(curInput).toLowerCase() || '.png'));
        const srcMp4 = path.join(FRAME_DIR, `src_${ts}_p${pass}.mp4`);
        const outMp4 = path.join(FRAME_DIR, `out_${ts}_p${pass}.mp4`);
        const png16 = path.join(FRAME_DIR, `rendered_${ts}_p${pass}_16.png`);
        const png8 = path.join(FRAME_DIR, `rendered_${ts}_p${pass}.png`);
        let passOut = null;
        try {
            await new Promise((ok, bad) => fs.copyFile(curInput, safeImg,
                (e) => (e ? bad(new Error('复制输入失败: ' + e.message)) : ok())));
            // The previous pass's output was only needed as this pass's input; free it now.
            if (prevOutput && fs.existsSync(prevOutput)) {
                try { fs.unlinkSync(prevOutput); } catch (e) { /* ignore */ }
                prevOutput = null;
            }
            // Windows 上刚写完的文件立刻交给另一个进程打开，偶尔会撞上共享冲突，
            // ffmpeg 把它报成 "No such file or directory"。这一步很便宜（<1s），
            // 重试几次就能避开；实测单张图片渲染偶发失败即源于此。
            let loopErr = null;
            for (let attempt = 1; attempt <= 3; ++attempt) {
                try {
                    await runFfmpeg(['-loop', '1', '-framerate', '30', '-i', safeImg,
                        '-frames:v', '3', '-pix_fmt', 'yuv444p', '-c:v', 'libx264', '-qp', '0',
                        '-preset', 'ultrafast', srcMp4]);
                    loopErr = null;
                    break;
                } catch (e) {
                    loopErr = e;
                    await new Promise((r) => setTimeout(r, 250 * attempt));
                }
            }
            if (loopErr) throw loopErr;
            const exe = findEngine();
            if (!fs.existsSync(exe)) throw new Error('engine not found');
            const imgCfg = Object.assign({}, cfg || {}, {
                frameGuidance: 0, startTime: 0, endTime: 0.1,
                encoder: 'libx264', pixFmt: 'yuv444p', codecArgs: '-qp 0 -preset ultrafast',
            });
            const args = engineArgs(imgCfg, srcMp4, outMp4, true);
            args.push('--png16', png16);
            await runEngine(exe, args);
            if (fs.existsSync(png16)) passOut = png16;
            else {
                await runFfmpeg(['-i', outMp4, '-frames:v', '1', '-f', 'image2', png8]);
                passOut = png8;
            }
            if (pass === passes) {
                finalPng = passOut;                 // survive: this is the returned result
            } else {
                prevOutput = passOut;               // consumed by the next pass
            }
        } finally {
            try { fs.unlinkSync(safeImg); } catch (e) { /* ignore */ }
            try { fs.unlinkSync(srcMp4); } catch (e) { /* ignore */ }
            try { fs.unlinkSync(outMp4); } catch (e) { /* ignore */ }
        }
        curInput = passOut;
    }
    return finalPng;
}

// Live state of the whole-folder image batch. Module-private: the routes start/cancel/poll it
// through the accessors below, so there is exactly one reader/writer of the field.
// { running, cancel, done, dir, outDir, fmt, files, total, idx, current, ok, skip, failed[] }
let imgBatch = null;

const getBatch = () => imgBatch;
const setBatch = (b) => { imgBatch = b; };

async function runImageBatch() {
    const b = imgBatch;
    b.ok = 0; b.skip = 0; b.failed = []; b.idx = 0; b.done = false;
    try { fs.mkdirSync(b.outDir, { recursive: true }); } catch (e) { /* ignore */ }
    for (const file of b.files) {
        if (b.cancel) break;
        b.current = path.basename(file);
        b.idx++;
        const base = path.basename(file).replace(/\.[^.]+$/, '');
        const dst = path.join(b.outDir, 'nr_' + base + BATCH_FMT_EXT[b.fmt]);
        if (fs.existsSync(dst)) { b.skip++; continue; }           // resume support
        let lastErr = null;
        for (let attempt = 1; attempt <= 2; ++attempt) {   // one retry masks transient engine hiccups
            try {
                const png = await renderStillOnce(file, b.cfg);
                if (b.fmt === 'png') {
                    fs.copyFileSync(png, dst);
                } else {
                    await runFfmpeg(['-i', png, '-q:v', '2', '-f', 'image2', dst]);
                    // ffmpeg drops the tEXt chunk on transcode: re-stamp the jpg with the
                    // render params read back from the source png.
                    const meta = await readRenderMeta(png);
                    if (meta) await stampRenderMeta(dst, meta);
                }
                try { fs.unlinkSync(png); } catch (e) { /* ignore */ }
                b.ok++;
                lastErr = null;
                break;
            } catch (e) {
                lastErr = e;
                await new Promise((r) => setTimeout(r, 400));
            }
        }
        if (lastErr) {
            b.failed.push(path.basename(file) + ':' + (lastErr.message || '?').slice(0, 90));
        }
        b.current = null;
    }
    b.running = false;
    b.done = true;
    b.finishedAt = Date.now();
}

module.exports = { BATCH_FMT_EXT, walkImages, walkVideos, renderStillOnce, runImageBatch, getBatch, setBatch };
