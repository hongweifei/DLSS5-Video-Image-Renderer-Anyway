// Native Windows dialogs and browser launching.
//
// The service runs on 127.0.0.1 and the page is served by it, so "pick a file" is answered by a
// real dialog on the server machine: the chosen path is the ORIGINAL file, so nothing is copied
// and the output can default to the source folder.
const { execFile } = require('child_process');

// Opens the given URL in the default browser. rundll32 url.dll,FileProtocolHandler is the most
// reliable Windows way to hand a URL to the OS; explorer.exe is a fallback if that ever fails.
function openBrowser(url) {
    if (process.platform === 'win32') {
        execFile('rundll32.exe', ['url.dll,FileProtocolHandler', url], { windowsHide: true }, (e) => {
            if (e) execFile('explorer.exe', [url], { windowsHide: true }, () => {});
        });
    } else if (process.platform === 'darwin') {
        execFile('open', [url], () => {});
    } else {
        execFile('xdg-open', [url], () => {});
    }
}

// Runs a PowerShell file-dialog snippet and resolves with the chosen path.
//
// Three things are required to make a dialog actually appear in front of the browser window:
//   1. -STA (file dialogs need a single-threaded apartment).
//   2. A real, shown TopMost owner Form -- otherwise the z-order relationship never gets set
//      up and the dialog sits behind whatever window has focus.
//   3. A timer that calls SetForegroundWindow repeatedly while the dialog is open. The PowerShell
//      process is NOT the foreground process, so a one-shot call would be silently dropped by
//      Windows' foreground lock; repeating the call is the standard workaround.
//
// scriptBody should construct and configure $dlg only; this wrapper owns the owner form, the
// timer, ShowDialog, and stdout output.
function runFileDialog(scriptBody, valueExpr) {
    if (valueExpr === undefined) valueExpr = '$($dlg.FileName)';
    return new Promise((resolve) => {
        const ps =
            "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; " +
            // DPI awareness first: without it WinForms dialogs render small/blurry on scaled displays
            "try { if (-not ('PInvoke.Dpi' -as [type])) { Add-Type -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware();' -Name Dpi -Namespace PInvoke } } catch { }; " +
            "try { [PInvoke.Dpi]::SetProcessDPIAware() | Out-Null } catch { }; " +
            "try { if (-not ('PInvoke.Mui' -as [type])) { Add-Type -MemberDefinition '[DllImport(\"kernel32.dll\", CharSet = CharSet.Unicode)] public static extern bool SetProcessPreferredUILanguages(uint dwFlags, string pwszLanguagesBuffer, ref uint pulNumLanguages);' -Name Mui -Namespace PInvoke } } catch { }; " +
            "try { $n = [uint32]0; [PInvoke.Mui]::SetProcessPreferredUILanguages(8, \"zh-CN`0\", [ref]$n) | Out-Null } catch { }; " +
            "try { if (-not ('PInvoke.Mui2' -as [type])) { Add-Type -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern ushort SetThreadUILanguage(ushort LangId);' -Name Mui2 -Namespace PInvoke } } catch { }; " +
            "try { [PInvoke.Mui2]::SetThreadUILanguage(2052) | Out-Null } catch { }; " +
            // force Chinese UI strings for the managed dialog parts (buttons/labels of FolderBrowserDialog etc.)
            "try { $c = New-Object System.Globalization.CultureInfo('zh-CN'); " +
            "[System.Threading.Thread]::CurrentThread.CurrentUICulture = $c; " +
            "[System.Threading.Thread]::CurrentThread.CurrentCulture = $c } catch { }; " +
            "Add-Type -AssemblyName System.Windows.Forms; " +
            "try { [System.Windows.Forms.Application]::EnableVisualStyles() } catch { }; " +
            "if (-not ('PInvoke.Win32' -as [type])) { " +
            "Add-Type -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd);' " +
            "-Name Win32 -Namespace PInvoke " +
            "}; " +
            "$owner = New-Object System.Windows.Forms.Form; " +
            "$owner.TopMost = $true; $owner.WindowState = 'Minimized'; $owner.ShowInTaskbar = $false; " +
            "$owner.Show(); " +
            scriptBody + " " +
            "$timer = New-Object System.Windows.Forms.Timer; $timer.Interval = 80; " +
            "$timer.Add_Tick({ if ($dlg.Handle -ne [IntPtr]::Zero) { [PInvoke.Win32]::SetForegroundWindow($dlg.Handle) | Out-Null } }); " +
            "$timer.Start(); " +
            "$result = $dlg.ShowDialog($owner); " +
            "$timer.Stop(); $owner.Close(); " +
            "if ($result -eq [System.Windows.Forms.DialogResult]::OK) { Write-Host -NoNewline \"__PATH__" + valueExpr + "\" } else { Write-Host -NoNewline '__CANCELLED__' }";
        execFile(
            'powershell.exe',
            ['-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-Command', ps],
            { windowsHide: true, encoding: 'utf8', timeout: 180000 },
            (err, stdout) => {
                if (err) return resolve({ error: err.message });
                const out = (stdout || '').trim();
                if (out === '__CANCELLED__' || out === '') return resolve({ cancelled: true });
                if (!out.startsWith('__PATH__')) return resolve({ error: 'unexpected dialog output: ' + out });
                resolve({ path: out.slice('__PATH__'.length) });
            }
        );
    });
}

module.exports = { openBrowser, runFileDialog };
