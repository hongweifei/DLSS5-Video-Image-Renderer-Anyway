// HTTP plumbing shared by every route: response/body helpers and the two extension->type maps.
//
// Two maps on purpose, because they answer different questions:
//   MIME     - the fixed set of static assets the page itself loads (html/js/css/png/svg/json).
//              A miss here means a broken page, so the route layer treats it as a packaging bug.
//   mimeFor  - an arbitrary file on disk the user asked us to stream (video/image). Unknown
//              extensions fall back to octet-stream so a download still works.
const path = require('path');

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.json': 'application/json; charset=utf-8',
};

function mimeFor(p) {
    const ext = path.extname(p).toLowerCase();
    return (
        {
            '.mp4': 'video/mp4',
            '.mov': 'video/quicktime',
            '.mkv': 'video/x-matroska',
            '.webm': 'video/webm',
            '.m4v': 'video/mp4',
            '.avi': 'video/x-msvideo',
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.bmp': 'image/bmp',
            '.webp': 'image/webp',
            '.tif': 'image/tiff',
            '.tiff': 'image/tiff',
        }[ext] || 'application/octet-stream'
    );
}

function sendJson(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
    });
    res.end(body);
}

// Reads and parses a JSON request body. A malformed or oversized body resolves to {} rather than
// rejecting: every caller validates its own required fields and answers 400 with a real message,
// which is far more useful to the page than a dropped connection.
function readBody(req) {
    return new Promise((resolve) => {
        let data = '';
        req.on('data', (c) => {
            data += c;
            if (data.length > 1e6) req.destroy();
        });
        req.on('end', () => {
            try {
                resolve(data ? JSON.parse(data) : {});
            } catch (e) {
                resolve({});
            }
        });
    });
}

module.exports = { MIME, mimeFor, sendJson, readBody };
