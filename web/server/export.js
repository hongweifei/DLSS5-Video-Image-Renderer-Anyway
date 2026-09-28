// Re-encoding a finished render into a distribution encoder (/api/export).
//
// This is a pure ffmpeg transcode of an already-rendered file -- it never re-runs the model, so
// re-exporting the same result with a different encoder is cheap. It runs as a background task so
// the page can show per-second progress via /api/status -> export.*.
const { spawn } = require('child_process');
const { probeDurationSec } = require('./media');

// ffmpeg encoding presets used by /api/export (a fast transcode of the lossless master). Keys
// match the UI encoder ids; *_10bit stay in 10-bit, the rest convert down to 8-bit yuv420p.
const EXPORT_ENCODERS = {
    h264_nvenc: ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '20', '-b:v', '0', '-pix_fmt', 'yuv420p'],
    hevc_nvenc: ['-c:v', 'hevc_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '22', '-b:v', '0', '-pix_fmt', 'yuv420p'],
    libx264: ['-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p'],
    libx265: ['-c:v', 'libx265', '-crf', '20', '-preset', 'medium', '-pix_fmt', 'yuv420p'],
    hevc_nvenc_10bit: ['-c:v', 'hevc_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '20', '-b:v', '0', '-vf', 'format=p010le', '-profile:v', 'main10'],
    libx265_10bit: ['-c:v', 'libx265', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p10le'],
};

// Live state of the most recent / most current export transcode (UI polls it once a second).
// Shared by reference and only ever mutated in place, so consumers may import the object itself.
const exporter = { running: false, pct: 0, encoder: null, out: null, error: null };

// Spawns ffmpeg with -progress on stdout; parses out_time_ms to update exporter.pct roughly
// once per second. Never touches the DLSS model -- it is a pure transcode of the master.
function runExport(master, encoder, finalOut) {
    return new Promise(async (resolve, reject) => {
        const dur = await probeDurationSec(master);
        const args = ['-y', '-nostats', '-i', master, '-map', '0', '-c:a', 'copy',
            ...EXPORT_ENCODERS[encoder], '-progress', 'pipe:1', '-movflags', '+faststart', finalOut];
        const child = spawn('ffmpeg', args, { windowsHide: true });
        let buf = '';
        child.stdout.on('data', (c) => {
            buf += c.toString('utf8');
            let nl;
            while ((nl = buf.indexOf('\n')) >= 0) {
                const l = buf.slice(0, nl);
                buf = buf.slice(nl + 1);
                if (l.startsWith('out_time_ms=')) {
                    const t = parseInt(l.split('=')[1] || '0', 10) / 1e6;
                    if (dur > 0) exporter.pct = Math.max(0, Math.min(99, Math.round((t / dur) * 100)));
                }
            }
        });
        child.on('error', reject);
        child.on('close', (code) => {
            exporter.pct = code === 0 ? 100 : exporter.pct;
            if (code === 0) resolve(); else reject(new Error('ffmpeg export exit code ' + code));
        });
    });
}

module.exports = { EXPORT_ENCODERS, exporter, runExport };
