#pragma once

// Frame finalisation: turn the model's 16-bit float output into the encoder's pixel format.
//
// Two output shapes exist and both are produced here so the render loop does not carry the
// quantisation math inline:
//   * 8-bit RGBA with a 4x4 Bayer ordered dither (the normal video path),
//   * 16-bit RGBA without dither (10/12-bit output and the --png16 still-image path).
//
// The dither matters: the NR model denoises the grain that used to hide 8-bit rounding, so
// plain rounding produces hard posterisation bands. One Bayer offset is added before the single
// 8-bit quantisation.

#include <cstdint>
#include <string>

namespace dlss5nr {

// Half-float (R16G16B16A16_FLOAT readback) -> float. Values read are in 0..1.
float halfToFloat(uint16_t h);

// Residual blend of the 16F model result against the 8-bit source, quantised to 8-bit exactly
// once with a Bayer dither. `inRGBA` is width*height*4 bytes, `outF16` width*height*8.
void finalizeToRgba8(const uint8_t* inRGBA, const uint8_t* outF16, uint8_t* dst,
                     uint32_t width, uint32_t height, float residualMult);

// Same blend, kept at 16-bit per channel (0..65535) with no dither: 65536 levels make banding
// impossible. `dst` is width*height*4 uint16 samples.
void finalize16(const uint8_t* inRGBA, const uint8_t* outF16, uint16_t* dst, uint32_t width,
                uint32_t height, float residualMult);

// Writes a 16-bit RGB PNG through ffmpeg (raw rgba64le -> rgb48be). Returns false when ffmpeg
// is missing or fails.
bool writePng16(const std::string& pathUtf8, uint32_t width, uint32_t height,
                const uint16_t* rgba16);

}  // namespace dlss5nr
