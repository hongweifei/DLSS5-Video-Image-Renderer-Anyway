// Static file serving for the page itself: index.html, css/, js/.
//
// This is the fallback for every request that does not match an API route, so it must not
// assume anything about the caller. The two guards that matter:
//   - the resolved path is normalised and stripped of leading ../ segments, so a request can
//     never climb out of the web root;
//   - the result is re-checked against WEB_DIR after resolution (belt and braces, since
//     path.join alone does not refuse a traversal).
//
// WEB_DIR is imported rather than taken from __dirname: this file lives in web/server/routes/,
// so its own __dirname is NOT the web root. Using __dirname here would silently serve from the
// wrong directory and weaken the traversal guard.
const fs = require('fs');
const path = require('path');
const { MIME } = require('../http');
const { WEB_DIR } = require('../paths');

function serveStatic(req, res, url) {
    const rel = url.pathname === '/' ? '/index.html' : url.pathname;
    const filePath = path.join(WEB_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    if (!filePath.startsWith(WEB_DIR)) {
        res.writeHead(403);
        return res.end('forbidden');
    }
    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404);
            return res.end('not found');
        }
        res.writeHead(200, {
            'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
            'Cache-Control': 'no-store',
        });
        res.end(data);
    });
}

module.exports = { serveStatic };
