// Render-parameter metadata: the engine stamps every output with the settings that produced it,
// so a finished file can restore the exact configuration in the UI ("拖入媒体恢复参数").
//
// Three carriers, one payload format (base64url JSON prefixed with "render_cfg="):
//   mp4/mkv/mov -> container comment tag (read back with ffprobe)
//   png         -> tEXt chunk with keyword render_cfg (ffprobe cannot read PNG tEXt)
//   jpg         -> COM (FF FE) marker segment
//
// Server-side transcodes (any ffmpeg re-encode, e.g. png -> jpg or the master -> final export)
// drop the metadata, so stampRenderMeta() re-injects it afterwards.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { findEngine } = require('./engine');

const META_KEY = 'render_cfg=';

function b64urlDecode(s) {
    if (s.length % 4 === 1) s += '=';
    return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

// PNG: parse chunk stream, find tEXt with keyword render_cfg.
function metaFromPng(buf) {
    if (buf.length < 24 || buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47)
        return null;
    let pos = 8;
    while (pos + 12 <= buf.length) {
        const len = buf.readUInt32BE(pos);
        const type = buf.toString('latin1', pos + 4, pos + 8);
        if (type === 'IEND') break;
        if (pos + 12 + len > buf.length) return null;
        if (type === 'tEXt') {
            const data = buf.slice(pos + 8, pos + 8 + len);   // keyword\0text
            const nul = data.indexOf(0);
            if (nul > 0 && nul < data.length - 1) {
                const key = data.toString('latin1', 0, nul);
                const text = data.toString('latin1', nul + 1);
                if (key === 'render_cfg' && text.startsWith(META_KEY))
                    return b64urlDecode(text.slice(META_KEY.length));
            }
        }
        pos += 12 + len;
    }
    return null;
}

// JPG: scan markers, read COM (FF FE) segments for the render_cfg payload.
function metaFromJpg(buf) {
    let pos = 2;   // skip SOI
    while (pos + 4 <= buf.length) {
        if (buf[pos] !== 0xff) return null;
        const m = buf[pos + 1];
        if (m === 0xd8) { pos += 2; continue; }             // stray SOI
        if (m >= 0xd0 && m <= 0xd7) { pos += 2; continue; } // standalone
        if (m === 0xd9 || m === 0xda) return null;          // EOI / SOS: no more COM after scan
        if (pos + 4 > buf.length) return null;
        const segLen = buf.readUInt16BE(pos + 2);           // includes the 2 length bytes
        if (m === 0xfe) {
            const payload = buf.toString('latin1', pos + 4, pos + 2 + segLen);
            if (payload.startsWith(META_KEY))
                return b64urlDecode(payload.slice(META_KEY.length));
        }
        pos += 2 + segLen;
    }
    return null;
}

// Read render-parameter JSON from any of the formats the engine writes. Returns null when the
// file carries no render metadata.
function readRenderMeta(file) {
    return new Promise((resolve) => {
        const ext = path.extname(file).toLowerCase();
        if (ext === '.mp4' || ext === '.mkv' || ext === '.mov' || ext === '.m4v') {
            execFile('ffprobe',
                ['-v', 'error', '-show_entries', 'format_tags=comment',
                 '-of', 'default=noprint_wrappers=1:nokey=1', file],
                { windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
                (err, stdout) => {
                    const text = (stdout || '').trim();
                    if (err || !text.startsWith(META_KEY)) return resolve(null);
                    try { resolve(JSON.parse(b64urlDecode(text.slice(META_KEY.length)))); }
                    catch (e) { resolve(null); }
                });
            return;
        }
        if (ext === '.png' || ext === '.jpg' || ext === '.jpeg') {
            fs.readFile(file, (err, buf) => {
                if (err) return resolve(null);
                const json = ext === '.png' ? metaFromPng(buf) : metaFromJpg(buf);
                if (!json) return resolve(null);
                try { resolve(JSON.parse(json)); } catch (e) { resolve(null); }
            });
            return;
        }
        resolve(null);
    });
}

// Stamp render params onto a png/jpg via the engine's standalone subcommand (server-side
// transcodes drop the metadata, so re-inject after any ffmpeg re-encode).
function stampRenderMeta(file, jsonObj) {
    const exe = findEngine();
    const json = JSON.stringify(jsonObj || {});
    return new Promise((resolve) => {
        execFile(exe, ['--meta-inject', file, '--meta-json', json],
            { windowsHide: true, timeout: 20000 }, (err) => resolve(!err));
    });
}

module.exports = { b64urlDecode, metaFromPng, metaFromJpg, readRenderMeta, stampRenderMeta };
