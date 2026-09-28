// Byte-streaming and probe routes: moving media between the disk and the browser.
//
// The server is bound to 127.0.0.1 only, which is what makes serving arbitrary absolute paths
// acceptable here; the checks that remain are about honesty, not isolation:
//   /api/download, /api/video  - the output/input file can live anywhere, so the only guard is
//                                that the path is absolute and exists.
//   /api/image                 - extension whitelist, so it cannot be used as a file-read oracle
//                                for arbitrary types. (/api/frame-img, which must stay inside the
//                                private frame cache, lives with the other frame routes in
//                                render.js.)
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { sendJson, readBody, mimeFor } = require('../http');
const { findEngine } = require('../engine');
const { probe } = require('../media');

module.exports = [
    ['POST', '/api/probe', async (req, res) => {
        const body = await readBody(req);
        if (!body.input) return sendJson(res, 400, { ok: false, error: 'input is required' });
        return sendJson(res, 200, await probe(body.input));
    }],

    // Streams a result file back to the browser as a download.
    ['GET', '/api/download', async (req, res, url) => {
        const p = url.searchParams.get('path');
        if (!p) return sendJson(res, 400, { ok: false, error: 'path required' });
        const abs = path.resolve(p);
        if (!path.isAbsolute(p)) return sendJson(res, 400, { ok: false, error: 'absolute path required' });
        if (!fs.existsSync(abs)) return sendJson(res, 404, { ok: false, error: 'not found' });
        const size = fs.statSync(abs).size;
        res.writeHead(200, {
            'Content-Type': mimeFor(abs),
            'Content-Length': size,
            'Content-Disposition': 'attachment; filename="' + encodeURIComponent(path.basename(abs)) + '"',
            'Cache-Control': 'no-store',
        });
        fs.createReadStream(abs).pipe(res);
        return;
    }],

    // Streams the input video for the browser's <video> preview element. The HTML5 player needs
    // HTTP Range support to seek, so this implements bytes= parsing instead of a plain file dump.
    ['GET', '/api/video', async (req, res, url) => {
        const p = url.searchParams.get('path');
        if (!p) return sendJson(res, 400, { ok: false, error: 'path required' });
        const abs = path.resolve(p);
        if (!path.isAbsolute(p)) return sendJson(res, 400, { ok: false, error: 'absolute path required' });
        let stat;
        try { stat = fs.statSync(abs); } catch (e) { return sendJson(res, 404, { ok: false, error: 'not found' }); }
        const total = stat.size;
        const type = mimeFor(abs);
        const range = req.headers.range;
        if (range) {
            const m = /^bytes=(\d*)-(\d*)$/.exec(range);
            if (!m) return sendJson(res, 416, { ok: false, error: 'bad range' });
            let start = m[1] ? parseInt(m[1], 10) : 0;
            let end = m[2] ? parseInt(m[2], 10) : total - 1;
            if (isNaN(start) || start < 0) start = 0;
            if (isNaN(end) || end < start) end = total - 1;
            if (start >= total) {
                res.writeHead(416, { 'Content-Range': 'bytes */' + total });
                return res.end();
            }
            res.writeHead(206, {
                'Content-Type': type,
                'Accept-Ranges': 'bytes',
                'Content-Range': `bytes ${start}-${end}/${total}`,
                'Content-Length': end - start + 1,
                'Cache-Control': 'no-store',
            });
            fs.createReadStream(abs, { start, end }).pipe(res);
        } else {
            res.writeHead(200, {
                'Content-Type': type,
                'Accept-Ranges': 'bytes',
                'Content-Length': total,
                'Cache-Control': 'no-store',
            });
            fs.createReadStream(abs).pipe(res);
        }
        return;
    }],

    // Streams an arbitrary still image (png/jpg/bmp/webp/...) to the browser.
    ['GET', '/api/image', async (req, res, url) => {
        const p = url.searchParams.get('path') || '';
        if (!path.isAbsolute(p) || !/\.(png|jpe?g|bmp|webp|tif?f)$/i.test(p)) {
            return sendJson(res, 400, { ok: false, error: 'image path required' });
        }
        if (!fs.existsSync(p)) return sendJson(res, 404, { ok: false, error: 'image missing' });
        res.writeHead(200, {
            'Content-Type': mimeFor(p),
            'Content-Length': fs.statSync(p).size,
            'Cache-Control': 'no-store',
        });
        fs.createReadStream(p).pipe(res);
        return;
    }],

    // Enumerate GPUs by invoking the engine's --list-gpus; used to populate the UI selector.
    ['GET', '/api/gpus', async (req, res) => {
        const exe = findEngine();
        if (!fs.existsSync(exe)) return sendJson(res, 200, { ok: true, gpus: [] });
        execFile(exe, ['--list-gpus'], { windowsHide: true, encoding: 'utf8', timeout: 20000 },
            (err, stdout) => {
                const gpus = [];
                if (stdout) {
                    for (const line of stdout.split(/\r?\n/)) {
                        const m = /^\[gpu\] (\d+): (.+?)\s*\(vendor/.exec(line);
                        if (m) gpus.push({ idx: parseInt(m[1], 10), name: m[2].trim() });
                    }
                }
                sendJson(res, 200, { ok: true, gpus });
            });
        return;
    }],
];
