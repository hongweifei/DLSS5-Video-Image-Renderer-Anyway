// /api/export (transcode a finished render) and /api/upload (receive a dropped/pasted file).
//
// These two share a file only because both are "write a media file to disk on the user's behalf";
// they are otherwise independent (one reads an existing master, the other writes a temp copy).
const fs = require('fs');
const path = require('path');
const { UPLOADS_DIR, uniquePath, resolveExportPath } = require('../paths');
const { sendJson, readBody } = require('../http');
const state = require('../state');
const { EXPORT_ENCODERS, exporter, runExport } = require('../export');
const { VIDEO_EXT, IMAGE_EXT, purgeUploads } = require('../tempfiles');

module.exports = [
    // Exports a finished render to a final file using the chosen encoder. Runs as an async job so
    // the UI can show per-second progress (/api/status -> export.*). A pure ffmpeg transcode --
    // never re-runs the model -- so re-exporting with another encoder is cheap.
    ['POST', '/api/export', async (req, res) => {
        const body = await readBody(req);
        const master = (body.master || '').trim();
        const encoder = (body.encoder || '').trim();
        if (!master || !fs.existsSync(master)) {
            return sendJson(res, 400, { ok: false, error: 'master not found' });
        }
        if (!EXPORT_ENCODERS[encoder]) {
            return sendJson(res, 400, { ok: false, error: 'unknown encoder: ' + encoder });
        }
        if (exporter.running) {
            return sendJson(res, 409, { ok: false, error: 'another export is already running' });
        }
        // Output path + optional custom file name: blank file name keeps the default
        // (nr_<orig>_<encoder>.mp4); a typed name is honoured (auto .mp4 if no extension).
        const stem = path.basename(master).replace(/^master_/, 'nr_').replace(/\.[^.]+$/, '');
        // When a custom file name is given, 「保存的文件名」owns the basename and the output
        // field is a folder only -- even if the user pasted something that looks like a file
        // path (its parent dir is used), so the two controls never fight.
        // Default file name is just `nr_<original>.mp4` (no encoder suffix). If the user exports
        // multiple encoders into the same folder, uniquePath() appends (1)/(2)/... so nothing
        // is silently overwritten.
        const customName = (body.fileName || '').trim();
        let outputRaw = (body.output || '').trim();
        if (customName && outputRaw && /\.[A-Za-z0-9]{1,5}$/.test(path.basename(outputRaw))) {
            outputRaw = path.dirname(outputRaw);
        }
        const defaultName = customName
            ? (/\.[A-Za-z0-9]{1,5}$/.test(customName) ? customName : customName + '.mp4')
            : `${stem}.mp4`;
        const finalOut = resolveExportPath(outputRaw, defaultName);
        fs.mkdirSync(path.dirname(finalOut), { recursive: true });

        exporter.running = true;
        exporter.pct = 0;
        exporter.encoder = encoder;
        exporter.out = finalOut;
        exporter.error = null;
        runExport(master, encoder, finalOut).then(() => {
            exporter.running = false;
            exporter.pct = 100;
            const info = {
                ok: true,
                encoder,
                output: finalOut,
                url: '/api/video?path=' + encodeURIComponent(finalOut),
            };
            if (state.current && state.current.master === master) state.current.export = info;
        }).catch((e) => {
            exporter.running = false;
            exporter.error = e.message || String(e);
        });
        return sendJson(res, 200, { ok: true, started: true, encoder, output: finalOut });
    }],

    // Receives a dropped/pasted file's content (video or image) and stores it in the disposable
    // uploads dir. The temp copy keeps the user's ORIGINAL filename (sanitized for characters
    // Windows forbids, deduped with _1/_2 when a same-named file already exists). The UI only
    // ever sees this temporary path; it survives the job so previews keep working, and is purged
    // when the user replaces the input with another file of the same kind.
    ['POST', '/api/upload', async (req, res) => {
        try {
            fs.mkdirSync(UPLOADS_DIR, { recursive: true });
        } catch (e) {
            return sendJson(res, 500, { ok: false, error: 'cannot create uploads dir' });
        }
        const rawName = decodeURIComponent(req.headers['x-filename'] || 'video.mp4');
        const rawExt = path.extname(rawName).toLowerCase();
        const ext = [...VIDEO_EXT, ...IMAGE_EXT].includes(rawExt) ? rawExt : '.mp4';
        // Preserve the original name (minus extension); strip only what Windows cannot store.
        let stem = path.basename(rawName, rawExt);
        stem = stem.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '');
        if (!stem) stem = IMAGE_EXT.includes(ext) ? 'image' : 'video';
        if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) stem = '_' + stem;
        const tmpPath = uniquePath(UPLOADS_DIR, stem + ext);
        const ws = fs.createWriteStream(tmpPath);
        try {
            await new Promise((ok, bad) => {
                req.on('error', bad);
                ws.on('error', bad);
                req.pipe(ws);
                ws.on('finish', ok);
            });
        } catch (e) {
            try { fs.unlinkSync(tmpPath); } catch (e2) { /* ignore */ }
            return sendJson(res, 500, { ok: false, error: 'upload failed: ' + e.message });
        }
        let size = 0;
        try { size = fs.statSync(tmpPath).size; } catch (e) { /* ignore */ }
        if (size <= 0) {
            try { fs.unlinkSync(tmpPath); } catch (e) { /* ignore */ }
            return sendJson(res, 400, { ok: false, error: 'empty file received' });
        }
        // A fresh drop/paste replaces the previous one of the SAME kind (video or image): sweep
        // only that kind so the dir does not accumulate old copies while the other module's
        // current input (e.g. a video source next to an image being edited) is left untouched.
        purgeUploads(tmpPath);
        return sendJson(res, 200, { ok: true, path: tmpPath, name: path.basename(tmpPath), tmp: true });
    }],
];
