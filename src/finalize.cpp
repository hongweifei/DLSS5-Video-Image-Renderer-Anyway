// Frame finalisation (see finalize.h).

#include "finalize.h"

#include "util.h"

#include <cstdio>
#include <cstring>
#include <string>

#ifdef _WIN32
#include <io.h>
#endif

namespace dlss5nr {

float halfToFloat(uint16_t h) {
    uint32_t s = (uint32_t)(h & 0x8000u) << 16;
    uint32_t e = (h >> 10) & 0x1fu;
    uint32_t m = h & 0x3ffu;
    uint32_t bits;
    if (e == 0) {
        if (m == 0) {
            bits = s;
        } else {
            int ex = 127 - 24;   // subnormal half: value = m * 2^-24
            while ((m & 0x400u) == 0) { m <<= 1; --ex; }
            m &= 0x3ffu;
            bits = s | ((uint32_t)ex << 23) | (m << 13);
        }
    } else if (e == 31) {
        bits = s | 0x7f800000u;  // inf/nan -> clamps to 1 downstream
    } else {
        bits = s | ((e + 112u) << 23) | (m << 13);
    }
    float f;
    memcpy(&f, &bits, 4);
    return f;
}

namespace {

// Shared per-pixel blend: model (16F) against source (8-bit) in float, clamped to 0..1.
// `residualMult` 1.0 selects the pure model output; >1 keeps more of the source.
struct Blender {
    float m;
    float inW;
    explicit Blender(float residualMult) {
        m = residualMult < 0.f ? 0.f : (residualMult > 2.f ? 2.f : residualMult);
        inW = 1.f - m;
    }
    // r/g/b are the model output in 0..1; inP points at the source pixel's RGBA8.
    void apply(const uint8_t* inP, float& r, float& g, float& b) const {
        if (inW != 0.f) {
            const float inv = 1.f / 255.f;
            r = inW * (float)inP[0] * inv + m * r;
            g = inW * (float)inP[1] * inv + m * g;
            b = inW * (float)inP[2] * inv + m * b;
        }
        if (r < 0.f) r = 0.f; else if (r > 1.f) r = 1.f;
        if (g < 0.f) g = 0.f; else if (g > 1.f) g = 1.f;
        if (b < 0.f) b = 0.f; else if (b > 1.f) b = 1.f;
    }
};

}  // namespace

void finalizeToRgba8(const uint8_t* inRGBA, const uint8_t* outF16, uint8_t* dst,
                     uint32_t width, uint32_t height, float residualMult) {
    static const uint8_t bayer[4][4] = {{0, 8, 2, 10}, {12, 4, 14, 6},
                                        {3, 11, 1, 9}, {15, 7, 13, 5}};
    const Blender blend(residualMult);
    for (uint32_t y = 0; y < height; ++y) {
        const uint8_t* bayRow = bayer[y & 3];
        for (uint32_t x = 0; x < width; ++x) {
            const size_t px = (size_t)y * width + x;
            const uint8_t* in = inRGBA + px * 4;
            const uint16_t* h = (const uint16_t*)(outF16 + px * 8);
            float r = halfToFloat(h[0]);
            float g = halfToFloat(h[1]);
            float b = halfToFloat(h[2]);
            blend.apply(in, r, g, b);
            const float d = ((float)bayRow[x & 3] + 0.5f) / 16.f - 0.5f;
            uint8_t* o = dst + px * 4;
            o[0] = (uint8_t)(int)(r * 255.f + d + 0.5f);
            o[1] = (uint8_t)(int)(g * 255.f + d + 0.5f);
            o[2] = (uint8_t)(int)(b * 255.f + d + 0.5f);
            o[3] = 255;
        }
    }
}

void finalize16(const uint8_t* inRGBA, const uint8_t* outF16, uint16_t* dst, uint32_t width,
                uint32_t height, float residualMult) {
    const Blender blend(residualMult);
    for (uint32_t y = 0; y < height; ++y) {
        const uint8_t* in = inRGBA + (size_t)y * width * 4;
        const uint16_t* h = (const uint16_t*)(outF16 + (size_t)y * width * 8);
        uint16_t* o = dst + (size_t)y * width * 4;
        for (uint32_t x = 0; x < width; ++x, in += 4, h += 4, o += 4) {
            float r = halfToFloat(h[0]);
            float g = halfToFloat(h[1]);
            float b = halfToFloat(h[2]);
            blend.apply(in, r, g, b);
            o[0] = (uint16_t)(int)(r * 65535.f + 0.5f);
            o[1] = (uint16_t)(int)(g * 65535.f + 0.5f);
            o[2] = (uint16_t)(int)(b * 65535.f + 0.5f);
            o[3] = 65535;
        }
    }
}

bool writePng16(const std::string& pathUtf8, uint32_t width, uint32_t height,
                const uint16_t* rgba16) {
    std::wstring cmd = L"ffmpeg -y -loglevel error -f rawvideo -pix_fmt rgba64le -s " +
                       std::to_wstring(width) + L"x" + std::to_wstring(height) +
                       L" -i - -frames:v 1 -pix_fmt rgb48be \"" + widen(pathUtf8) + L"\"";
    FILE* p = _wpopen(cmd.c_str(), L"wb");
    if (!p) return false;
    const size_t row = (size_t)width * 4 * 2;
    const char* src = (const char*)rgba16;
    for (uint32_t y = 0; y < height; ++y) {
        if (fwrite(src + (size_t)y * row, 1, row, p) != row) {
            _pclose(p);
            return false;
        }
    }
    return _pclose(p) == 0;
}

}  // namespace dlss5nr
