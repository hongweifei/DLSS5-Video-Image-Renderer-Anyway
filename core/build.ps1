# build.ps1 - build dlss5nr_engine.exe (x64) with MSVC on Windows.
#
# This is the NATIVE Windows build entry point. Use it instead of build.sh when your shell is
# PowerShell/CMD, or when WSL interop is disabled (WSL cannot run cl.exe without it).
#
# Usage:
#   pwsh -File core\build.ps1
#   pwsh -File core\build.ps1 -MsvcVer 14.44.35207 -SdkVer 10.0.26100.0
#
# The toolchain is auto-detected via vswhere (any VS2022 edition, incl. Build Tools), so a
# Visual Studio update does not break the build.
[CmdletBinding()]
param(
    [string]$VsRoot,
    [string]$MsvcVer,
    [string]$SdkVer,
    [string]$WinKit = "C:\Program Files (x86)\Windows Kits\10",
    [switch]$Clean
)

$ErrorActionPreference = 'Stop'
$coreDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $coreDir
try {
    if ($Clean) {
        Get-ChildItem -Path $coreDir -Include *.obj, *.exe -File -ErrorAction SilentlyContinue |
            Remove-Item -Force -ErrorAction SilentlyContinue
        Write-Host "  cleaned build artifacts"
    }

    # ------------------------------------------------------------ Visual Studio
    if (-not $VsRoot) {
        $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
        if (Test-Path $vswhere) {
            $VsRoot = & $vswhere -latest -products * `
                -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
                -property installationPath 2>$null
            if ($VsRoot) { $VsRoot = $VsRoot.Trim() }
        }
    }
    if (-not $VsRoot) {
        $cands = @(
            "C:\Program Files\Microsoft Visual Studio\2022\Community",
            "C:\Program Files\Microsoft Visual Studio\2022\Professional",
            "C:\Program Files\Microsoft Visual Studio\2022\Enterprise",
            "C:\Program Files\Microsoft Visual Studio\2022\BuildTools",
            "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools"
        )
        $VsRoot = $cands | Where-Object { Test-Path $_ } | Select-Object -First 1
    }
    if (-not $VsRoot -or -not (Test-Path $VsRoot)) {
        throw @"
Visual Studio 2022 with the C++ toolset was not found.
  Install the 'Desktop development with C++' workload in the Visual Studio Installer,
  or pass -VsRoot "C:\path\to\VS2022".
"@
    }

    # ------------------------------------------------------------ MSVC toolset
    $msvcBase = Join-Path $VsRoot "VC\Tools\MSVC"
    if (-not (Test-Path $msvcBase)) { throw "MSVC tools not found under $msvcBase" }
    if (-not $MsvcVer) {
        $MsvcVer = Get-ChildItem $msvcBase -Directory |
            Sort-Object { [version]($_.Name -replace '[^0-9.]', '') } |
            Select-Object -Last 1 -ExpandProperty Name
    }
    $msvcRoot = Join-Path $msvcBase $MsvcVer
    $clDir = Join-Path $msvcRoot "bin\Hostx64\x64"
    if (-not (Test-Path (Join-Path $clDir "cl.exe"))) { throw "cl.exe not found in $clDir" }

    # ------------------------------------------------------------ Windows SDK
    if (-not $SdkVer) {
        $sdkRoot = Join-Path $WinKit "Include"
        if (-not (Test-Path $sdkRoot)) { throw "Windows SDK not found under $sdkRoot" }
        $SdkVer = Get-ChildItem $sdkRoot -Directory |
            Where-Object { $_.Name -like '10.*' -and (Test-Path (Join-Path $_.FullName 'um')) } |
            Sort-Object { [version]($_.Name -replace '[^0-9.]', '') } |
            Select-Object -Last 1 -ExpandProperty Name
    }
    if (-not (Test-Path (Join-Path $WinKit "Include\$SdkVer\um"))) {
        throw "Windows SDK $SdkVer not found under $WinKit\Include"
    }

    # ------------------------------------------------------------ environment
    $env:PATH    = "$clDir;$env:PATH"
    $env:INCLUDE = "$msvcRoot\include;$WinKit\Include\$SdkVer\shared;$WinKit\Include\$SdkVer\ucrt;$WinKit\Include\$SdkVer\um;$WinKit\Include\$SdkVer\winrt"
    $env:LIB     = "$msvcRoot\lib\x64;$WinKit\Lib\$SdkVer\um\x64;$WinKit\Lib\$SdkVer\ucrt\x64"

    Write-Host "=== building dlss5nr_engine ==="
    Write-Host "  VS      : $VsRoot"
    Write-Host "  MSVC    : $MsvcVer"
    Write-Host "  SDK     : $SdkVer"

    # Glob the translation units so a newly added .cpp builds without editing this script.
    # server_guard.c lives at the repository root and is built separately (plain C, /MT).
    $sources = Get-ChildItem -Path $coreDir -Filter *.cpp -File |
        Sort-Object Name | Select-Object -ExpandProperty Name
    if (-not $sources) { throw "no .cpp sources found in $coreDir" }
    Write-Host "  sources : $($sources -join ' ')"

    & cl.exe /nologo /O2 /MD /EHa /std:c++17 /W3 @sources `
        /Fe:dlss5nr_engine.exe `
        /link d3d12.lib dxgi.lib d3d11.lib d3dcompiler.lib
    if ($LASTEXITCODE -ne 0) { throw "cl.exe failed with exit code $LASTEXITCODE" }

    $exe = Join-Path $coreDir 'dlss5nr_engine.exe'
    if (-not (Test-Path $exe)) { throw "build reported success but $exe is missing" }
    Write-Host "=== BUILD OK -> core\dlss5nr_engine.exe ($((Get-Item $exe).Length) bytes) ==="
}
finally {
    Pop-Location
}
