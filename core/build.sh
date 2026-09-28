#!/usr/bin/env bash
# Build dlss5nr_engine.exe (x64) with MSVC.
#
# Works from Git-Bash AND WSL. Notes on why both are handled explicitly:
#   * Under WSL the Windows drives appear as /mnt/c/..., so "C:/Program Files" does not exist.
#   * Under Git-Bash they appear as /c/... and "C:/Program Files" usually works.
#   * cl.exe always speaks native Windows paths, so every path handed to it is converted back.
#
# The toolchain is AUTO-DETECTED (earlier revisions hard-coded one exact MSVC/SDK build number,
# which breaks on any other machine). Overrides if needed:
#   MSVCVER=14.44.35207 SDKVER=10.0.26100.0 bash build.sh
#   VSROOT="C:/Program Files/Microsoft Visual Studio/2022/Community" bash build.sh
set -e

# ---------------------------------------------------------------- host flavour
case "$(uname -s)" in
    Linux*)   HOSTFLAVOUR=wsl ;;
    MINGW*|MSYS*|CYGWIN*) HOSTFLAVOUR=gitbash ;;
    *)        HOSTFLAVOUR=other ;;
esac
echo "  host    : $HOSTFLAVOUR"

# Turn a native Windows path into one this shell can test with `[ -d ]` / `ls`.
shellpath() {
    case "$HOSTFLAVOUR" in
        wsl) printf '%s' "$1" | sed -e 's|^\([A-Za-z]\):|/mnt/\L\1|' ;;
        *)   printf '%s' "$1" ;;
    esac
}
# Turn a shell path back into a native Windows path for MSVC environment variables / cl.exe.
winpath() {
    case "$HOSTFLAVOUR" in
        wsl) printf '%s' "$1" | sed -e 's|^/mnt/\([a-z]\)|\U\1:|' ;;
        *)   printf '%s' "$1" ;;
    esac
}

PF86_WIN="C:/Program Files (x86)"
PF_WIN="C:/Program Files"

# ---------------------------------------------------------------- locate Visual Studio
if [ -z "$VSROOT" ]; then
    VSW_WIN="$PF86_WIN/Microsoft Visual Studio/Installer/vswhere.exe"
    VSW="$(shellpath "$VSW_WIN")"
    if [ -x "$VSW" ] || [ -f "$VSW" ]; then
        VSROOT="$("$VSW" -latest -products '*' \
            -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 \
            -property installationPath 2>/dev/null | tr -d '\r')"
    fi
fi
if [ -z "$VSROOT" ]; then
    for cand in \
        "$PF_WIN/Microsoft Visual Studio/2022/Community" \
        "$PF_WIN/Microsoft Visual Studio/2022/Professional" \
        "$PF_WIN/Microsoft Visual Studio/2022/Enterprise" \
        "$PF_WIN/Microsoft Visual Studio/2022/BuildTools" \
        "$PF86_WIN/Microsoft Visual Studio/2022/BuildTools"; do
        if [ -d "$(shellpath "$cand")" ]; then VSROOT="$cand"; break; fi
    done
fi
if [ -z "$VSROOT" ] || [ ! -d "$(shellpath "$VSROOT")" ]; then
    echo "ERROR: Visual Studio 2022 with the C++ toolset was not found." >&2
    echo "       Install the 'Desktop development with C++' workload in the Visual Studio" >&2
    echo "       Installer, or pass VSROOT=\"C:/path/to/VS2022\"." >&2
    echo "       (Detected from: $HOSTFLAVOUR)" >&2
    exit 1
fi

# ---------------------------------------------------------------- locate the MSVC toolset
MSVCBASE="$VSROOT/VC/Tools/MSVC"
if [ -z "$MSVCVER" ]; then
    MSVCVER="$(ls -1 "$(shellpath "$MSVCBASE")" 2>/dev/null | sort -V | tail -1)"
fi
MSVCROOT="$MSVCBASE/$MSVCVER"
if [ ! -d "$(shellpath "$MSVCROOT")" ]; then
    echo "ERROR: MSVC toolset not found under $MSVCBASE" >&2
    exit 1
fi

# ---------------------------------------------------------------- locate the Windows SDK
WINKIT="${WINKIT:-$PF86_WIN/Windows Kits/10}"
if [ -z "$SDKVER" ]; then
    for v in $(ls -1 "$(shellpath "$WINKIT/Include")" 2>/dev/null | grep -E '^10\.' | sort -Vr); do
        if [ -d "$(shellpath "$WINKIT/Include/$v/um")" ]; then SDKVER="$v"; break; fi
    done
fi
if [ ! -d "$(shellpath "$WINKIT/Include/$SDKVER/um")" ]; then
    echo "ERROR: Windows SDK 10 not found under $WINKIT/Include" >&2
    echo "       Install it via the VS Installer, or pass SDKVER=10.0.xxxxx.0." >&2
    exit 1
fi

# ---------------------------------------------------------------- cl.exe must be reachable
# Under WSL the Windows exe is callable, but the MSVC env vars must hold NATIVE paths.
CLDIR="$(shellpath "$MSVCROOT/bin/Hostx64/x64")"
if [ ! -f "$CLDIR/cl.exe" ]; then
    echo "ERROR: cl.exe not found in $CLDIR" >&2
    exit 1
fi
export PATH="$CLDIR:$PATH"

# WSL1/WSL2 without binfmt interop cannot execute cl.exe at all ("cannot execute binary file:
# Exec format error"). Detect it here and point at the native PowerShell script instead of
# failing with a confusing message later.
if [ "$HOSTFLAVOUR" = "wsl" ]; then
    if ! "$CLDIR/cl.exe" /? >/dev/null 2>&1; then
        echo "ERROR: WSL cannot execute Windows binaries (interop is disabled)." >&2
        echo "       Build from Windows instead:" >&2
        echo "         powershell -File core\\build.ps1" >&2
        echo "       Or enable interop: add to /etc/wsl.conf" >&2
        echo "         [interop]" >&2
        echo "         enabled = true" >&2
        echo "       then run 'wsl --shutdown' and reopen." >&2
        exit 1
    fi
fi

export INCLUDE="$(winpath "$MSVCROOT/include");$(winpath "$WINKIT/Include/$SDKVER/shared");$(winpath "$WINKIT/Include/$SDKVER/ucrt");$(winpath "$WINKIT/Include/$SDKVER/um");$(winpath "$WINKIT/Include/$SDKVER/winrt")"
export LIB="$(winpath "$MSVCROOT/lib/x64");$(winpath "$WINKIT/Lib/$SDKVER/um/x64");$(winpath "$WINKIT/Lib/$SDKVER/ucrt/x64")"

cd "$(dirname "$0")"

echo "=== building dlss5nr_engine ==="
echo "  VS      : $VSROOT"
echo "  MSVC    : $MSVCVER"
echo "  SDK     : $SDKVER"

# Under WSL the linker needs the /Fe: output to land on the Windows side; run from the source
# directory (which is on /mnt/...) and let cl.exe see the relative source names, as before.
#
# Sources are globbed so a newly added translation unit builds without editing this script;
# server_guard.c lives at the repository root and is built separately (it is a plain C file).
SOURCES=$(ls -1 *.cpp | tr '\n' ' ')
echo "  sources : $SOURCES"

# shellcheck disable=SC2086
cl.exe /nologo /O2 /MD /EHa /std:c++17 /W3 \
    $SOURCES \
    /Fe:dlss5nr_engine.exe \
    /link d3d12.lib dxgi.lib d3d11.lib d3dcompiler.lib

echo "=== BUILD OK -> core/dlss5nr_engine.exe ==="
