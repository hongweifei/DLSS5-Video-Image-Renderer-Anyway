@echo off
cd /d "%~dp0"

REM Put the bundled runtime (node/ffmpeg/ffprobe) on PATH FIRST, so a source checkout that
REM carries tools\ but no system-wide Node still starts (the release package always relies on
REM this). The previous order tested `where node` before adding tools\, which made the check
REM fail on machines whose only node is the bundled one.
set "PATH=%~dp0tools;%PATH%"

where node >nul 2>&1
if errorlevel 1 goto noNode

REM ---- NVIDIA GPU preference (hybrid-GPU laptops) ----
REM Tell Windows to run the engine on the high-performance (NVIDIA) GPU so hardware
REM optical flow (NV-OF) is created on the real GPU, not the iGPU/virtual display.
REM On machines without NVIDIA the engine now degrades gracefully: vendor-neutral
REM optical flow + software encoding, so this preference stays harmless.
set "ENGINE_EXE=%~dp0core\dlss5nr_engine.exe"
if exist "%ENGINE_EXE%" (
    reg add "HKCU\SOFTWARE\Microsoft\DirectX\UserGpuPreferences" /v "%ENGINE_EXE%" /t REG_SZ /d "GpuPreference=2;" /f >nul 2>&1
    if not errorlevel 1 echo  [gpu] engine set to high-performance GPU
) else (
    echo  [warn] engine not found: %ENGINE_EXE%
    echo         Build it first:  powershell -File core\build.ps1
)

REM If port 8777 is already held, the service itself steps to the next free port
REM (web/server.js bindServer) and prints the actual address - we never kill an old instance.

echo.
echo ============================================================
echo  DLSS5NR service starting... browser will open automatically.
echo  This window is the service terminal.
echo  Closing this window stops the service and cleans temp files.
echo ============================================================
echo.

REM server_guard.exe hosts node web\server.js --open and cleans the disposable temp
REM dirs on console close. In a plain source checkout the compiled guard is absent,
REM so fall back to launching node directly (dev mode, no close-time cleanup).
if exist "%~dp0server_guard.exe" (
    "%~dp0server_guard.exe"
) else (
    echo  [dev mode] server_guard.exe not found - starting node directly.
    echo  Closing this window stops the service, but temp files are only cleaned
    echo  by the server itself or the next launch.
    node "%~dp0web\server.js" --open
)

echo.
echo Service stopped. Press any key to close this window.
pause >nul
exit /b 0

:noNode
echo.
echo [ERROR] node.exe not found.
echo   Expected a bundled tools\node.exe or node.exe on PATH.
echo   Either place node.exe into the tools\ folder (portable release layout)
echo   or install Node.js from https://nodejs.org and re-run this file.
echo.
pause >nul
exit /b 1