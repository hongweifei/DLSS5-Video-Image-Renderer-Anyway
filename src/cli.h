#pragma once

// Command-line surface: the option struct, the help text, parsing, and the encoder policy.
//
// Kept out of main.cpp so the render loop there stays orchestration-only. Two entry points
// matter to the rest of the engine:
//   * parseCommandLine()      fills Options from argv (wmain)
//   * applyEncoderPolicy()    resolves encoder aliases and degrades NVENC on non-NVIDIA boxes
//
// The daemon mode (--daemon) reuses Options through parseRenderLine() in main.cpp: server.js
// sends one tab-separated render line per job.

#include <string>

#include "dlssnr.h"   // DlssNrSettings

namespace dlss5nr {

struct Options {
    std::string input;
    std::string output;
    std::string snippet = "nvngx_dlssnr.dll";
    std::string forwarder = "nvngx.dll_dlssnr.dll";
    std::string encoder = "h264_nvenc";
    std::string extraArgs;
    std::string pixFmt = "yuv420p";  // output pixel format; yuv444p (+lossless encoder) for preview
    std::string dumpFrame;       // optional: write raw first decoded frame as PPM (preview)
    double startTime = 0.0;      // decode window start, seconds
    double endTime = 0.0;        // decode window end, seconds; 0 = end of file
    bool keepAudio = true;
    bool daemon = false;         // resident mode: keep loaded resources, serve jobs from stdin
    int frameGuidance = 3;     // 0 = Force Zero (no motion), 3 = NV-OF hardware optical flow,
                               // 4 = vendor-neutral optical flow (GPU compute / CPU fallback)
    int mvecQuality = 2;       // flow engine tier: 0 FAST / 1 MEDIUM / 2 SLOW (default best)
    int depthInterval = 0;     // Update depth-from-color every N frames; 0 = Force Zero
    bool hwDecode = false;     // --hw-decode: NVDEC. Measured no faster than software decode in
                               // this pipeline (data still round-trips to system memory) and it
                               // has shown mid-stream stalls, so software is the default.
    float residualMult = 1.0f; // 1.0 = pure model output; >1 amplifies detail residual like Magpie
    bool frameReset = false;   // Per-frame reset: treat every frame independently (like a
                               // real-time filter over a video window, no cross-frame history)
    bool perf = false;         // --perf: print per-stage ms/frame breakdown at the end
    int  gpuIdx = -1;          // --gpu-idx <N>: user-chosen DXGI adapter; -1 = auto
    bool listGpus = false;     // --list-gpus: print every adapter and exit
    bool warp = false;         // --warp: force the WARP software D3D12 device (CPU rendering)
    bool bypassNr = false;     // --bypass-nr: skip DLSS NR inference (diagnostic passthrough)
    bool onnxNr = false;       // --onnx-nr: force the ONNX DLSS5 reconstruction backend
    std::string onnxModel;     // --onnx-model <path>: explicit .onnx path for the backend
    std::string png16;         // --png16 <path>: write first frame as a 16-bit PNG (no banding)
    DlssNrSettings nr;
};

void usage();

// Compact JSON of the render-affecting parameters (whitelist shared with server.js): the UI
// restores exactly these when a stamped file is dragged in. Paths/encoder/hardware knobs are
// deliberately excluded.
std::string serializeRenderMeta(const Options& o);

// Parses argv into `opt` plus the standalone modes. Returns:
//   0 = continue to render (opt is filled)
//   1 = a mode already completed and the process should exit with `exitCode`
// `exitCode` carries the status for that case (e.g. --help -> 0, bad usage -> 2).
// Handles the flag-only scan, --meta-inject, and --help internally.
int parseCommandLine(int argc, wchar_t** argv, Options& opt, int& exitCode);

// Resolves *_10bit / *_master aliases and degrades NVENC to libx264/libx265 when the render
// adapter is not NVIDIA (or the ffmpeg build lacks NVENC). Must run after the GPU is selected
// (d3dSetAdapter/d3dUseWarp) and after --list-gpus has had its chance to exit.
void applyEncoderPolicy(Options& opt);

// Default output path: <stem>_nr<ext>, then _nr_1, _nr_2, ... until the name is free.
std::string makeUniqueOutput(const std::string& inputUtf8);

}  // namespace dlss5nr
