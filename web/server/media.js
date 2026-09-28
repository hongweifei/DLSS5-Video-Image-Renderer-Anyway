// Thin wrappers around the portable ffmpeg/ffprobe pair. Every media fact the service needs
// (resolution, frame rate, duration, dimensions) comes from ffprobe here, and every purely
// mechanical video/audio operation goes through ffmpeg here -- the DLSS model is never involved.
const { spawn, execFile } = require('child_process');

// Single-shot ffmpeg wrapper. "-y -v error" are always added.
function runFfmpeg(args) {
    return new Promise((ok, bad) => {
        const p = spawn('ffmpeg', ['-y', '-v', 'error', ...args], { windowsHide: true });
        let err = '';
        p.stderr.on('data', (c) => { err += c.toString('utf8'); });
        p.on('close', (code) => code === 0 ? ok() : bad(new Error('ffmpeg exit ' + code + ' ' + err.trim())));
        p.on('error', bad);
    });
}

// Runs ffprobe to fill in the resolution, frame rate and frame count before anything is started.
function probe(input) {
    return new Promise((resolve) => {
        execFile(
            'ffprobe',
            [
                '-v', 'error',
                '-select_streams', 'v:0',
                '-show_entries', 'stream=width,height,r_frame_rate,duration',
                '-of', 'default=noprint_wrappers=1',
                input,
            ],
            { windowsHide: true },
            (err, stdout) => {
                if (err && !stdout) return resolve({ ok: false, error: 'ffprobe failed' });
                const info = { width: 0, height: 0, fps: 0, frames: 0 };
                for (const line of stdout.split('\n')) {
                    const [k, v] = line.split('=');
                    if (k === 'width') info.width = parseInt(v, 10);
                    else if (k === 'height') info.height = parseInt(v, 10);
                    else if (k === 'r_frame_rate') {
                        if (v.includes('/')) {
                            const [a, b] = v.split('/');
                            info.fps = parseFloat(a) / parseFloat(b);
                        } else info.fps = parseFloat(v);
                    } else if (k === 'duration') {
                        if (info.fps > 0) info.frames = Math.round(parseFloat(v) * info.fps);
                    }
                }
                resolve({ ok: info.width > 0, info });
            }
        );
    });
}

function probeDurationSec(file) {
    return new Promise((resolve) => {
        execFile('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
            'format=duration', '-of', 'csv=p=0', file], { windowsHide: true }, (e, out) => {
            const t = parseFloat((out || '').trim());
            resolve(isFinite(t) && t > 0 ? t : 0);
        });
    });
}

// Pixel dimensions of a still (PNG/PPM). Returns {0,0} rather than throwing: the compare view
// degrades to "size unknown" instead of failing the whole render it just paid for.
function probeDimensions(file) {
    return new Promise((resolve) => {
        execFile('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
            '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file],
            { windowsHide: true }, (e, out) => {
                if (e) return resolve({ width: 0, height: 0 });
                const [w, h] = (out || '').split(',');
                resolve({ width: parseInt(w, 10) || 0, height: parseInt(h, 10) || 0 });
            });
    });
}

module.exports = { runFfmpeg, probe, probeDurationSec, probeDimensions };
