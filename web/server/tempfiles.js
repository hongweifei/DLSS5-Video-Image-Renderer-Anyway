// Lifecycle of the two disposable temp directories (uploads + frame previews).
//
// Both are wiped at shutdown by server_guard.exe; the sweeps here are the fallback for a kill
// that bypassed the guard, plus the per-drop purge that keeps the dirs from growing while the
// service runs. Nothing here ever touches an output file.
const fs = require('fs');
const path = require('path');
const { UPLOADS_DIR, FRAME_DIR } = require('./paths');
const state = require('./state');

// Dropped/pasted files are classified video vs image by extension. Video and image inputs are
// independent features that may be open at the same time, so temp-upload purges only sweep the
// same kind (a new video drop must not destroy a still image being edited, and vice versa).
const VIDEO_EXT = ['.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v'];
const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.bmp', '.webp', '.tif', '.tiff'];

function uploadKind(p) {
    const ext = path.extname(p).toLowerCase();
    if (IMAGE_EXT.includes(ext)) return 'img';
    if (VIDEO_EXT.includes(ext)) return 'video';
    return null;
}

function isTempUpload(p) {
    if (!p) return false;
    const dir = path.normalize(UPLOADS_DIR) + path.sep;
    return path.normalize(p).startsWith(dir);
}

function isFramePath(p) {
    if (!p) return false;
    const dir = path.normalize(FRAME_DIR) + path.sep;
    return path.normalize(p).startsWith(dir);
}

function cleanUploadsDir() {
    try {
        for (const f of fs.readdirSync(UPLOADS_DIR)) {
            fs.unlinkSync(path.join(UPLOADS_DIR, f));
        }
    } catch (e) { /* ignore */ }
}

function cleanFrameDir() {
    try {
        for (const f of fs.readdirSync(FRAME_DIR)) {
            fs.unlinkSync(path.join(FRAME_DIR, f));
        }
    } catch (e) { /* ignore */ }
}

// Idle path: only drop entries OLDER than `ageMs`. A still-image render that the user is still
// looking at must survive (save-after-zoom >1 min used to fail because the whole dir was swept).
function cleanFrameDirOlder(ageMs) {
    const now = Date.now();
    let entries = [];
    try { entries = fs.readdirSync(FRAME_DIR); } catch (e) { return; }
    for (const f of entries) {
        const p = path.join(FRAME_DIR, f);
        try {
            const st = fs.statSync(p);
            if (now - st.mtimeMs >= ageMs) {
                if (st.isDirectory()) fs.rmSync(p, { recursive: true, force: true });
                else fs.unlinkSync(p);
            }
        } catch (e) { /* ignore */ }
    }
}

// Deletes stale drag-and-drop uploads of ONE kind (video vs image), keeping only the file the
// user is currently working on (so the preview players keep working until the user replaces the
// input) and any upload still being read by a running or queued job. The kind is inferred from
// `keep` when given; pass it explicitly (e.g. 'video' after picking a disk video file) when there
// is no keep, so only stale uploads of that kind get swept.
function purgeUploads(keep, kind) {
    const keepSet = new Set();
    if (keep) {
        keepSet.add(path.resolve(keep));
        kind = kind || uploadKind(keep) || null;
    }
    // Running AND queued whole-video jobs may still need their source upload: never purge those.
    for (const j of [state.current].concat(state.jobQueue)) {
        if (j && j.steps && j.steps[0] && isTempUpload(j.steps[0].input)) {
            keepSet.add(path.resolve(j.steps[0].input));
        }
    }
    try {
        for (const f of fs.readdirSync(UPLOADS_DIR)) {
            const p = path.join(UPLOADS_DIR, f);
            if (keepSet.has(path.resolve(p))) continue;
            if (kind && uploadKind(p) !== kind) continue;
            try {
                if (fs.existsSync(p)) fs.unlinkSync(p);
            } catch (e) { /* ignore */ }
        }
    } catch (e) { /* ignore */ }
}

module.exports = {
    VIDEO_EXT,
    IMAGE_EXT,
    uploadKind,
    isTempUpload,
    isFramePath,
    cleanUploadsDir,
    cleanFrameDir,
    cleanFrameDirOlder,
    purgeUploads,
};
