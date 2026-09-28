#pragma once

// Small shared helpers used across the engine translation units.
//
// These exist because the same few lines were previously copy-pasted into six files:
//   * UTF-8 <-> UTF-16 conversion (every Win32 wide API call needs it, and the engine works in
//     UTF-8 internally so paths with Chinese characters survive),
//   * the 8-bit -> 16-bit channel expansion used by the deep-output and PNG16 paths.
//
// Keep this header dependency-light: it is included by the D3D12, ONNX, flow and ffmpeg units.

#include <windows.h>

#include <cstdint>
#include <string>
#include <vector>

namespace dlss5nr {

// UTF-8 -> UTF-16. Returns an empty string for empty input. `s` is treated as UTF-8; invalid
// byte sequences are replaced rather than throwing (paths must never abort a render).
inline std::wstring widen(const std::string& s) {
    if (s.empty()) return {};
    int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), nullptr, 0);
    if (n <= 0) return {};
    std::wstring ws((size_t)n, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), &ws[0], n);
    return ws;
}

// UTF-16 -> UTF-8 (no trailing NUL). Used for logging adapter names and converting Win32 paths
// back to the UTF-8 strings the rest of the engine passes around.
inline std::string narrow(const wchar_t* ws) {
    if (!ws) return {};
    int n = WideCharToMultiByte(CP_UTF8, 0, ws, -1, nullptr, 0, nullptr, nullptr);
    if (n <= 1) return {};
    std::string s((size_t)(n - 1), '\0');
    WideCharToMultiByte(CP_UTF8, 0, ws, -1, &s[0], n, nullptr, nullptr);
    return s;
}

inline std::string narrow(const std::wstring& ws) { return narrow(ws.c_str()); }

// Absolute form of a path. LoadLibraryExW(..., LOAD_WITH_ALTERED_SEARCH_PATH) only honours the
// altered search path for ABSOLUTE dll paths - passing a cwd-relative "models/onnx/x.dll" makes
// the loader look in the wrong directory and fail with ERROR_MOD_NOT_FOUND (126). Every
// LoadLibraryExW call site therefore normalises first.
inline std::wstring absolutePath(const std::wstring& p) {
    wchar_t buf[MAX_PATH];
    if (GetFullPathNameW(p.c_str(), MAX_PATH, buf, nullptr) > 0) return buf;
    return p;
}

// 8-bit channel -> 16-bit, preserving full range (255 -> 65535).
inline uint16_t to16(uint8_t v) { return (uint16_t)(v * 257u); }

// Expands an 8-bit RGBA buffer to 16-bit RGBA (rgba64le) so a 10/12-bit encoder receives the
// correctly sized, correctly scaled input. Alpha is forced opaque.
inline void expandRgba8ToRgba16(const uint8_t* src, uint16_t* dst, size_t pixels) {
    for (size_t i = 0, j = 0; i < pixels; ++i, j += 4) {
        dst[j + 0] = to16(src[j + 0]);
        dst[j + 1] = to16(src[j + 1]);
        dst[j + 2] = to16(src[j + 2]);
        dst[j + 3] = 65535;
    }
}

}  // namespace dlss5nr
