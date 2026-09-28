// Every filesystem location the local service touches, resolved once from this file's own
// location. This module is the ONLY place that knows the on-disk layout; the entry point and the
// route modules stay layout-agnostic, so moving a directory is a one-line change here instead of
// a hunt for `path.join(__dirname, ...)` across the tree.
//
//   <ROOT>/                       project root (= the release-package root)
//     web/                        WEB_DIR   (= this file's parent)
//       server.js                 entry point (launched by start_ui.bat / server_guard.exe)
//       server/                   this module tree
//     models/                     MODELS_DIR
//     outputs/                    OUTPUTS_DIR  (created on boot)
//     .tmp_uploads/               UPLOADS_DIR  (disposable: dropped/pasted copies)
//     .frame_previews/            FRAME_DIR    (disposable: preview PNGs)
//
// WEB_DIR must be computed HERE, not in a route module: `__dirname` inside web/server/routes/
// would point at the route folder, which would break both the static-file root and its
// directory-traversal guard.
const fs = require('fs');
const path = require('path');

// web/server/ -> web/
const WEB_DIR = path.resolve(__dirname, '..');
const ROOT = path.resolve(WEB_DIR, '..');

const MODELS_DIR = path.join(ROOT, 'models');

// Default output directory for all renders. Created on boot so the first run never errors.
// The user may still override per-job via the output path field / folder picker.
const OUTPUTS_DIR = path.join(ROOT, 'outputs');

const PORT = process.env.PORT || 8777;

// Drag-and-drop copies land here (the browser cannot hand us a local path, only file content).
// Everything under it is disposable: swept at service shutdown by server_guard.exe, and stale
// entries are purged whenever a new file is dropped or picked. A source copy is NOT deleted when
// its job finishes, so the compare/preview player can keep using it afterwards. The startup sweep
// is only a fallback for leftovers from an abrupt kill that bypassed the guard. Output files are
// never written here.
const UPLOADS_DIR = path.join(ROOT, '.tmp_uploads');

// Single-frame preview (compare) PNGs live here. Same disposable policy: swept at shutdown by
// server_guard.exe (the startup sweep is the abrupt-kill fallback).
const FRAME_DIR = path.join(ROOT, '.frame_previews');

// Returns a path under dir that does not yet exist, appending _1, _2, ... to the stem.
function uniquePath(dir, name) {
    let cand = path.join(dir, name);
    if (!fs.existsSync(cand)) return cand;
    const ext = path.extname(name);
    const stem = path.basename(name, ext);
    let n = 1;
    do {
        cand = path.join(dir, stem + '_' + n + ext);
        n++;
    } while (fs.existsSync(cand));
    return cand;
}

// Resolves where an export should land: blank -> <ROOT>/outputs/<defaultName>; an existing dir or
// a trailing slash -> that directory + <defaultName>; otherwise treated as an explicit file path.
function resolveExportPath(requested, defaultName) {
    if (!requested || !requested.trim()) return uniquePath(OUTPUTS_DIR, defaultName);
    let p = requested.trim();
    let isDir = false;
    try { isDir = fs.statSync(p).isDirectory(); } catch (e) { isDir = /[\\/]$/.test(p); }
    if (isDir) return uniquePath(p, defaultName);
    const ext = path.extname(p);
    if (!ext) return uniquePath(p, defaultName); // looks like a bare dir that doesn't exist yet
    fs.mkdirSync(path.dirname(p), { recursive: true });
    return uniquePath(path.dirname(p), path.basename(p));
}

module.exports = {
    WEB_DIR,
    ROOT,
    MODELS_DIR,
    OUTPUTS_DIR,
    UPLOADS_DIR,
    FRAME_DIR,
    PORT,
    uniquePath,
    resolveExportPath,
};
