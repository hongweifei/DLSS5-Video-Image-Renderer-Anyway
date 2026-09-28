// /api/render-frame, /api/frame-img, /api/render-image, /api/read-meta.
//
// The three render routes share a deliberate quirk: NR is a VIDEO pipeline (the engine needs a
// video reader + encoder even for a single frame), so a still is looped into a tiny lossless clip
// and the first rendered frame is what a still pass produces. Preview frames are compared
// pixel-to-pixel, so the intermediate clip is always lossless 4:4:4 (libx264 -qp 0) and the frame
// is taken from the engine's 16-bit PNG export -- never through the lossy NVENC/yuv420p path.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { FRAME_DIR } = require('../paths');
const { sendJson, readBody } = require('../http');
const { isFramePath } = require('../tempfiles');
const { findEngine, engineArgs, runEngine } = require('../engine');
const { runFfmpeg, probe, probeDimensions } = require('../media');
const { readRenderMeta } = require('../meta');
const { renderStillOnce } = require('../batch');

module.exports = [
    // Renders a single frame at the requested time using the same model parameters as a full job,
    // then extracts both the original frame and the rendered frame as PNGs so the UI can show a
    // side-by-side / split-comparison hover view.
    ['POST', '/api/render-frame', async (req, res) => {
        const body = await readBody(req);
        const input = (body.input || '').trim();
        const frameTime = parseFloat(body.frameTime);
        const cfg = body.cfg || {};
        if (!input) return sendJson(res, 400, { ok: false, error: 'input is required' });
        if (!isFinite(frameTime) || frameTime < 0) {
            return sendJson(res, 400, { ok: false, error: 'frameTime must be a non-negative number' });
        }
        if (!fs.existsSync(input)) {
            return sendJson(res, 400, { ok: false, error: 'input file does not exist' });
        }

        fs.mkdirSync(FRAME_DIR, { recursive: true });
        const ts = Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
        const origPath = path.join(FRAME_DIR, `orig_${ts}.png`);
        const tmpMp4 = path.join(FRAME_DIR, `src_${ts}.mp4`);

        // Frame rate of the source so the render window can be shrunk to ~2 frames (rendering
        // a whole 0.5s window just to extract one frame is what made previews slow).
        let fps = 0;
        try {
            const pi = await probe(input);
            if (pi.ok && pi.info.fps > 0) fps = pi.info.fps;
        } catch (e) { /* fall back below */ }
        const winDur = fps > 0 ? Math.max(0.05, 2.0 / fps) : 0.5;

        try {
            // 1) Render a tiny window (~2-3 frames) with the engine using the user's model
            //    params. --dump-frame makes the engine also write its raw decoded first frame
            //    as a PPM, which we convert to the "before" image -- an exact same-physical-frame
            //    match with zero extra video decoding (a separate frame-accurate ffmpeg grab
            //    would decode every frame up to frameTime all over again).
            const ppmPath = path.join(FRAME_DIR, `orig_${ts}.ppm`);
            // Preview frames are compared pixel-to-pixel, so the rendered window is encoded
            // losslessly in 4:4:4 -- never through the lossy NVENC/yuv420p path. That keeps
            // smooth gradients intact until the PNG extract, so banding can't creep in here.
            const prevCfg = Object.assign({}, cfg, {
                encoder: 'libx264',
                pixFmt: 'yuv444p',
                codecArgs: '-qp 0 -preset ultrafast',
            });
            const args = engineArgs(prevCfg, input, tmpMp4, true);
            args.push('--start-time', frameTime.toString());
            args.push('--end-time', (frameTime + winDur).toString());
            args.push('--dump-frame', ppmPath);
            // 16-bit first-frame export for the rendered preview: same trick as the image
            // module, so the compare view never shows the 8-bit Bayer dither grid.
            // NOTE: this must stay `let`. --png16 is always passed, so a working engine writes
            // rendered16 and the fallback branch below reassigns this variable. As `const` that
            // reassignment threw "Assignment to constant variable" on every success path.
            let renderedPath = path.join(FRAME_DIR, `rendered_${ts}.png`);
            const rendered16 = path.join(FRAME_DIR, `rendered_${ts}_16.png`);
            args.push('--png16', rendered16);
            const exe = findEngine();
            if (!fs.existsSync(exe)) {
                return sendJson(res, 500, { ok: false, error: 'engine not found' });
            }
            await runEngine(exe, args);

            if (fs.existsSync(ppmPath)) {
                // PPM -> PNG is a trivial conversion; no video decoding involved.
                await runFfmpeg(['-i', ppmPath, '-frames:v', '1', '-f', 'image2', origPath]);
                try { fs.unlinkSync(ppmPath); } catch (e) { /* ignore */ }
            } else {
                // Old engine without --dump-frame: fall back to a separate frame-accurate grab.
                await runFfmpeg([
                    '-i', input,
                    '-ss', frameTime.toString(),
                    '-frames:v', '1',
                    '-f', 'image2',
                    origPath,
                ]);
            }

            // 2) Extract the first frame of the rendered window (== the frame at frameTime).
            //    Prefer the engine's 16-bit PNG; fall back to decoding the 8-bit clip.
            if (fs.existsSync(rendered16)) {
                renderedPath = rendered16;
            } else {
                await runFfmpeg([
                    '-i', tmpMp4,
                    '-frames:v', '1',
                    '-f', 'image2',
                    renderedPath,
                ]);
            }

            try { fs.unlinkSync(tmpMp4); } catch (e) { /* ignore */ }

            // Probe PNG dimensions so the UI can render at native size.
            const dim = await probeDimensions(renderedPath);

            return sendJson(res, 200, {
                ok: true,
                orig: '/api/frame-img?path=' + encodeURIComponent(origPath),
                render: '/api/frame-img?path=' + encodeURIComponent(renderedPath),
                width: dim.width,
                height: dim.height,
                frameTime,
            });
        } catch (e) {
            try { fs.unlinkSync(tmpMp4); } catch (e2) { /* ignore */ }
            return sendJson(res, 500, { ok: false, error: e.message || 'render-frame failed' });
        }
    }],

    // Serves one of the disposable compare-frame PNGs. Path must be inside FRAME_DIR (no
    // arbitrary reads).
    ['GET', '/api/frame-img', async (req, res, url) => {
        const p = url.searchParams.get('path') || '';
        if (!isFramePath(p)) return sendJson(res, 400, { ok: false, error: 'frame path required' });
        if (!fs.existsSync(p)) return sendJson(res, 404, { ok: false, error: 'frame missing' });
        res.writeHead(200, {
            'Content-Type': 'image/png',
            'Content-Length': fs.statSync(p).size,
            'Cache-Control': 'no-store',
        });
        fs.createReadStream(p).pipe(res);
        return;
    }],

    // Renders a single still image through the DLSS NR engine and returns the "before"/"after"
    // as PNGs. Internally the image is looped into a tiny lossless clip (NR is a video pipeline:
    // it needs a video reader + encoder even for one frame); the first rendered frame is what a
    // still-image pass produces, equivalent to the engine's first-frame (reset) behaviour.
    ['POST', '/api/render-image', async (req, res) => {
        const body = await readBody(req);
        const input = (body.input || '').trim();
        const cfg = body.cfg || {};
        if (!input) return sendJson(res, 400, { ok: false, error: 'input is required' });
        if (!/\.(png|jpe?g|bmp|webp|tif?f)$/i.test(input)) {
            return sendJson(res, 400, { ok: false, error: 'not a supported image type' });
        }
        if (!fs.existsSync(input)) {
            return sendJson(res, 400, { ok: false, error: 'input file does not exist' });
        }

        fs.mkdirSync(FRAME_DIR, { recursive: true });
        const ts = Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);

        try {
            // 0) Snapshot the input into a PRIVATE copy before anything else runs. Consecutive
            //    frame previews upload under the same temp name, so a later preview (or the
            //    uploads purge) can delete/overwrite this file while the engine is still reading
            //    it -- that produced stale frames and "src_*.mp4: No such file" failures.
            const safeImg = path.join(FRAME_DIR, `safeimg_${ts}${path.extname(input).toLowerCase() || '.png'}`);
            await new Promise((ok, bad) =>
                fs.copyFile(input, safeImg, (e) => (e ? bad(new Error('复制输入失败: ' + e.message)) : ok())));

            // 1) Render through the engine. A still has no motion, so renderStillOnce forces
            //    frame guidance to 0 (force-zero) -- skips NV-OF init, correct for a static
            //    image. cfg.renderPasses repeats the still in a generative loop (each pass
            //    renders the previous pass's output), matching the whole-video 渲染次数.
            const exe = findEngine();
            if (!fs.existsSync(exe)) {
                return sendJson(res, 500, { ok: false, error: 'engine not found' });
            }
            const renderedPath = await renderStillOnce(safeImg, cfg);

            const dim = await probeDimensions(renderedPath);

            return sendJson(res, 200, {
                ok: true,
                orig: '/api/image?path=' + encodeURIComponent(safeImg),
                render: '/api/frame-img?path=' + encodeURIComponent(renderedPath),
                renderedAbs: renderedPath,
                width: dim.width,
                height: dim.height,
            });
        } catch (e) {
            return sendJson(res, 500, { ok: false, error: e.message || 'render-image failed' });
        }
    }],

    // Reads render-parameter metadata stamped on a finished mp4/png/jpg and returns the JSON
    // (whitelist only — the engine already stored only render-affecting keys). Used by the
    // "拖入媒体恢复参数" drop zone.
    ['POST', '/api/read-meta', async (req, res) => {
        const body = await readBody(req);
        const p = (body.path || '').trim();
        if (!p || !fs.existsSync(p)) return sendJson(res, 400, { ok: false, error: '文件不存在' });
        const meta = await readRenderMeta(p);
        if (!meta) return sendJson(res, 200, { ok: true, found: false });
        return sendJson(res, 200, { ok: true, found: true, meta });
    }],
];
