// Native-dialog routes. All of them open a real Windows dialog on the SERVER machine and return
// the chosen path, so the page never has to copy a file just to learn where it lives.
//
// Every dialog route answers 501 off Windows rather than silently returning nothing, and reports
// a user cancel as `{ok:false, cancelled:true}` (not an error) so the page can stay quiet.
const fs = require('fs');
const path = require('path');
const { sendJson } = require('../http');
const { runFileDialog } = require('../dialog');
const { purgeUploads, isFramePath } = require('../tempfiles');
const { runFfmpeg } = require('../media');
const { readRenderMeta, stampRenderMeta } = require('../meta');

const NOT_WINDOWS = 'file picker only supported on Windows';

// Every dialog route repeats the same three-outcome dance (error / cancel / path). Kept in one
// place so a new dialog cannot quietly forget the cancel case.
async function withDialog(res, body, valueExpr, pick) {
    const r = await runFileDialog(body, valueExpr);
    if (r.error) return sendJson(res, 500, { ok: false, error: r.error });
    if (r.cancelled) return sendJson(res, 200, { ok: false, cancelled: true });
    return sendJson(res, 200, pick(r.path));
}

module.exports = [
    // Opens a native file picker and returns the ORIGINAL file path. This avoids copying the
    // video into uploads/ and keeps the output next to the source file.
    ['GET', '/api/pick-file', async (req, res) => {
        if (process.platform !== 'win32') return sendJson(res, 501, { ok: false, error: NOT_WINDOWS });
        const filter = "视频文件 (*.mp4;*.mov;*.mkv;*.avi;*.webm)|*.mp4;*.mov;*.mkv;*.avi;*.webm|所有文件 (*.*)|*.*";
        const body =
            "$dlg = New-Object System.Windows.Forms.OpenFileDialog; " +
            "$dlg.Title = '选择视频文件'; $dlg.Filter = '" + filter + "'; ";
        // The user moved on to a different video: the previous drag-and-drop video copy (if any)
        // is no longer needed. Purge only stale video uploads -- an image being edited for the
        // still-image module may still be open and must survive.
        return withDialog(res, body, undefined, (p) => {
            purgeUploads(null, 'video');
            return { ok: true, path: p, name: path.basename(p) };
        });
    }],

    // Native open dialog restricted to still images (single-image render).
    ['GET', '/api/pick-image', async (req, res) => {
        if (process.platform !== 'win32') return sendJson(res, 501, { ok: false, error: NOT_WINDOWS });
        const filter = "图片文件 (*.png;*.jpg;*.jpeg;*.bmp;*.webp;*.tif;*.tiff)|*.png;*.jpg;*.jpeg;*.bmp;*.webp;*.tif;*.tiff|所有文件 (*.*)|*.*";
        const body =
            "$dlg = New-Object System.Windows.Forms.OpenFileDialog; " +
            "$dlg.Title = '选择图片'; $dlg.Filter = '" + filter + "'; ";
        // Switched to a disk image: drop any stale drag-in/paste image copy (video uploads are
        // independent and stay untouched -- see purgeUploads).
        return withDialog(res, body, undefined, (p) => {
            purgeUploads(null, 'img');
            return { ok: true, path: p, name: path.basename(p) };
        });
    }],

    // Opens a native file picker for a video to feed the side-by-side video compare module.
    ['GET', '/api/pick-video', async (req, res) => {
        if (process.platform !== 'win32') return sendJson(res, 501, { ok: false, error: NOT_WINDOWS });
        const filter = "视频文件 (*.mp4;*.mov;*.mkv;*.avi;*.webm;*.m4v)|*.mp4;*.mov;*.mkv;*.avi;*.webm;*.m4v|所有文件 (*.*)|*.*";
        const body =
            "$dlg = New-Object System.Windows.Forms.OpenFileDialog; " +
            "$dlg.Title = '选择视频'; $dlg.Filter = '" + filter + "'; ";
        return withDialog(res, body, undefined, (p) => ({ ok: true, path: p, name: path.basename(p) }));
    }],

    // Opens a native folder picker for the output directory, defaulting to the input's folder.
    // Returns the chosen directory; the page composes the final filename using the input stem
    // so the user only has to pick a folder, not a specific file.
    ['GET', '/api/save-file', async (req, res, url) => {
        if (process.platform !== 'win32') return sendJson(res, 501, { ok: false, error: NOT_WINDOWS });
        const input = url.searchParams.get('input') || '';
        const dir = input ? path.dirname(input) : '';
        const initial = dir ? "$dlg.InitialDirectory = '" + dir.replace(/'/g, "''") + "'; " : '';
        // Modern (Vista-style, resizable, DPI-aware) folder picker: an OpenFileDialog in
        // "pick a folder" mode. The old FolderBrowserDialog is a small legacy tree window.
        const body =
            "$dlg = New-Object System.Windows.Forms.OpenFileDialog; " +
            "$dlg.Title = '选择输出文件夹(进入目标文件夹后点“打开”)'; " +
            "$dlg.CheckFileExists = $false; $dlg.CheckPathExists = $true; " +
            "$dlg.ValidateNames = $false; " +
            "$dlg.Filter = '文件夹|*.folder'; " +
            "$dlg.FileName = '选择此文件夹'; " +
            initial;
        return withDialog(res, body,
            "$(if ([System.IO.Directory]::Exists($dlg.FileName)) { $dlg.FileName } else { Split-Path -Parent $dlg.FileName })",
            (p) => ({ ok: true, dir: p }));
    }],

    // Folder picker used by the image-batch feature (a whole folder of stills).
    ['GET', '/api/pick-folder', async (req, res) => {
        if (process.platform !== 'win32') return sendJson(res, 501, { ok: false, error: NOT_WINDOWS });
        const body =
            "$dlg = New-Object System.Windows.Forms.OpenFileDialog; " +
            "$dlg.Title = '选择要批量渲染的图片文件夹'; " +
            "$dlg.CheckFileExists = $false; $dlg.CheckPathExists = $true; " +
            "$dlg.ValidateNames = $false; $dlg.Filter = '文件夹|*.folder'; " +
            "$dlg.FileName = '选择此文件夹'; " +
            "$dlg.InitialDirectory = 'C:////'; ";
        return withDialog(res, body,
            "$(if ([System.IO.Directory]::Exists($dlg.FileName)) { $dlg.FileName } else { Split-Path -Parent $dlg.FileName })",
            (p) => ({ ok: true, dir: p }));
    }],

    // "Save the rendered PNG to a user-chosen location": native save dialog (png/jpg), then
    // copies or re-encodes the frame to the picked file.
    ['GET', '/api/save-image', async (req, res, url) => {
        const src = url.searchParams.get('src') || '';
        if (!isFramePath(src) || !fs.existsSync(src)) {
            return sendJson(res, 400, { ok: false, error: 'no rendered image available' });
        }
        const filter = "PNG 图片 (*.png)|*.png|JPG 图片 (*.jpg)|*.jpg|所有文件 (*.*)|*.*";
        const body =
            "$dlg = New-Object System.Windows.Forms.SaveFileDialog; " +
            "$dlg.Title = '保存渲染结果'; $dlg.Filter = '" + filter + "'; " +
            "$dlg.DefaultExt = 'png'; $dlg.AddExtension = $true; " +
            "$dlg.FileName = 'nr_render.png'; ";
        const r = await runFileDialog(body);
        if (r.error) return sendJson(res, 500, { ok: false, error: r.error });
        if (r.cancelled) return sendJson(res, 200, { ok: false, cancelled: true });
        const dst = r.path;
        try {
            if (/\.jpe?g$/i.test(dst)) {
                await runFfmpeg(['-i', src, '-q:v', '2', '-f', 'image2', dst]);
                const meta = await readRenderMeta(src);
                if (meta) await stampRenderMeta(dst, meta);
            } else {
                fs.copyFileSync(src, dst);   // png keeps its tEXt chunk intact
            }
        } catch (e) {
            return sendJson(res, 500, { ok: false, error: 'save failed: ' + e.message });
        }
        return sendJson(res, 200, { ok: true, path: dst });
    }],
];
