// Asset layout resolution (see paths.h).
//
// Everything here is deliberately filesystem-only and side-effect free: it answers "where is X"
// and nothing else, so the callers (model loading, ONNX backend, ffmpeg PATH setup) stay simple
// and a layout change has exactly one place to touch.

#include "paths.h"

#include "util.h"

#include <windows.h>

#include <filesystem>

namespace fs = std::filesystem;

namespace dlss5nr {

namespace {

std::string exeDirCached() {
    wchar_t buf[MAX_PATH] = {};
    if (GetModuleFileNameW(nullptr, buf, MAX_PATH) == 0) return ".";
    std::wstring dir(buf);
    size_t slash = dir.find_last_of(L"\\/");
    return narrow(slash == std::wstring::npos ? dir : dir.substr(0, slash));
}

bool isDir(const std::string& p) {
    if (p.empty()) return false;
    std::error_code ec;
    return fs::is_directory(widen(p), ec);
}

bool isFile(const std::string& p) {
    if (p.empty()) return false;
    std::error_code ec;
    return fs::is_regular_file(widen(p), ec);
}

std::string join(const std::string& a, const std::string& b) {
    if (a.empty()) return b;
    if (b.empty()) return a;
    if (a.back() == '/' || a.back() == '\\') return a + b;
    return a + "/" + b;
}

}  // namespace

std::string exeDir() {
    static const std::string cached = exeDirCached();
    return cached;
}

std::string rootDir() {
    static const std::string cached = [] {
        const std::string dir = exeDir();
        // A developer build puts the exe in build/, with models/ and runtime/ one level up.
        // A release package puts the exe directly beside them. Detect which by looking for a
        // sibling models/ or runtime/ directory.
        if (isDir(join(dir, "models")) || isDir(join(dir, "runtime"))) return dir;
        std::string parent = dir;
        size_t slash = parent.find_last_of("\\/");
        if (slash != std::string::npos) {
            parent = parent.substr(0, slash);
            if (isDir(join(parent, "models")) || isDir(join(parent, "runtime"))) return parent;
        }
        return dir;
    }();
    return cached;
}

std::vector<std::string> runtimeDirCandidates() {
    const std::string root = rootDir();
    return {
        join(root, "runtime"),        // current layout
        join(root, "src/runtime"),    // in case runtime/ is nested under src/
        join(exeDir(), "runtime"),    // exe-local runtime/
        join(root, "core/depth"),     // legacy (pre-2026-09) layout: ORT + DML next to sources
        join(root, "depth"),
        join(root, "models/onnx"),    // layout where the runtime sat beside the ONNX model
    };
}

std::string findRuntimeDir() {
    for (const auto& d : runtimeDirCandidates()) {
        if (isFile(join(d, "onnxruntime.dll"))) return d;
    }
    return {};
}

std::string findAsset(const std::vector<std::string>& relativePaths) {
    const std::string root = rootDir();
    const std::string exe = exeDir();
    for (const auto& rel : relativePaths) {
        // Absolute paths pass through untouched.
        if (rel.size() > 1 && (rel[1] == ':')) {
            if (isFile(rel)) return rel;
            continue;
        }
        const std::string a = join(root, rel);
        if (isFile(a)) return a;
        if (exe != root) {
            const std::string b = join(exe, rel);
            if (isFile(b)) return b;
        }
    }
    return {};
}

std::vector<std::string> modelDirCandidates() {
    const std::string root = rootDir();
    return {
        join(root, "models"),
        join(exeDir(), "models"),
        join(root, "src/models"),
        join(root, "../models"),   // a bare CLI run started from inside src/
    };
}

std::string findModelDir() {
    for (const auto& d : modelDirCandidates()) {
        if (isDir(d)) return d;
    }
    return {};
}

std::string findToolsDir() {
    for (const std::string& d : { join(rootDir(), "tools"), join(exeDir(), "tools") }) {
        if (isFile(join(d, "ffmpeg.exe"))) return d;
    }
    return {};
}

}  // namespace dlss5nr
