// Command-line surface (see cli.h).

#include "cli.h"

#include "paths.h"
#include "util.h"
#include "meta_io.h"

#include <cstdio>
#include <cstring>
#include <filesystem>
#include <string>

#include "d3d12_ctx.h"   // d3dIsWarp / d3dRenderVendor for the encoder policy

namespace dlss5nr {

namespace {

bool parseInt(const char* s, int& out) { return s && sscanf(s, "%d", &out) == 1; }
bool parseFloat(const char* s, float& out) { return s && sscanf(s, "%f", &out) == 1; }
bool parseDouble(const char* s, double& out) { return s && sscanf(s, "%lf", &out) == 1; }

// Directory holding the running executable (no trailing separator).
// Makes the bundled portable runtime (tools/ffmpeg.exe, ffprobe.exe, node.exe) reachable.
// findToolsDir() covers both the package layout (tools/ beside the exe) and the source layout
// (tools/ at the repository root, one level above build/). Doing this before any ffmpeg
// shell-out means the engine works on a machine with nothing on PATH.
void prependBundledToolsToPath() {
    const std::string tools = dlss5nr::findToolsDir();
    if (tools.empty()) return;
    const std::string cur = std::getenv("PATH") ? std::getenv("PATH") : "";
    SetEnvironmentVariableW(L"PATH", (widen(tools + ";" + cur)).c_str());
}

// True when `encoder` can actually run: it needs an NVIDIA render adapter, and (rare) an ffmpeg
// build compiled with NVENC support. `ffmpeg -encoders` alone cannot answer this - it lists
// nvenc even on machines without the driver, because ffmpeg loads nvcuda.dll lazily.
bool nvencUsable(const std::string& encoder) {
    if (d3dIsWarp() || d3dRenderVendor() != 0x10DE) return false;

    std::string list;
    FILE* p = _wpopen(L"ffmpeg -hide_banner -encoders 2>nul", L"r");
    if (p) {
        char buf[512];
        while (fgets(buf, sizeof(buf), p)) list += buf;
        _pclose(p);
    }
    // An empty list means the probe itself failed; trust the vendor check in that case.
    return list.empty() || list.find(encoder) != std::string::npos;
}

// Downgrades an NVENC request to the matching software encoder. The CRF values are parameters
// because the near-lossless master path wants a much higher quality floor than the normal path.
// Returns true when a downgrade happened.
bool degradeNvenc(Options& opt, const char* why, int crfH264, int crfX265) {
    if (opt.encoder.find("nvenc") == std::string::npos) return false;
    if (nvencUsable(opt.encoder)) return false;

    const bool hevc = opt.encoder.find("hevc") != std::string::npos;
    const std::string alt = hevc ? "libx265" : "libx264";
    printf("NOTE  : encoder %s %s; using %s instead\n", opt.encoder.c_str(), why, alt.c_str());
    opt.encoder = alt;

    // Only add rate control when the caller has not supplied its own.
    if (opt.extraArgs.find("-crf") == std::string::npos &&
        opt.extraArgs.find("-qp") == std::string::npos) {
        char buf[64];
        snprintf(buf, sizeof(buf), " -crf %d -preset medium", hevc ? crfX265 : crfH264);
        opt.extraArgs += buf;
    }
    return true;
}

}  // namespace

std::string serializeRenderMeta(const Options& o) {
    char buf[384];
    int n = snprintf(buf, sizeof(buf),
                     "{\"v\":1,\"preset\":%d,\"style\":%d,\"intensity\":%.4g,"
                     "\"localTone\":%.4g,\"localStructure\":%.4g,\"skinStructure\":%.4g,"
                     "\"autoMask\":%d,\"uiCorrection\":%d,\"residualMult\":%.4g,"
                     "\"frameGuidance\":%d,\"mvecQuality\":%d,\"depthInterval\":%d,"
                     "\"frameReset\":%s}",
                     o.nr.preset, o.nr.style, (double)o.nr.intensity, (double)o.nr.localTone,
                     (double)o.nr.localStructure, (double)o.nr.skinStructure, o.nr.useAutoMask,
                     o.nr.uiCorrection, (double)o.residualMult, o.frameGuidance, o.mvecQuality,
                     o.depthInterval, o.frameReset ? "true" : "false");
    return n > 0 ? std::string(buf, (size_t)n) : std::string();
}

std::string makeUniqueOutput(const std::string& inputUtf8) {
    namespace fs = std::filesystem;
    fs::path p(widen(inputUtf8));
    fs::path dir = p.parent_path();
    if (dir.empty()) dir = fs::path(L".");
    std::wstring stem = p.stem().wstring();
    std::wstring ext = p.extension().wstring();
    if (ext.empty()) ext = L".mp4";
    int n = 0;
    std::wstring cand;
    do {
        std::wstring suffix = (n == 0) ? L"_nr" : (L"_nr_" + std::to_wstring(n));
        cand = (dir / (stem + suffix + ext)).wstring();
        n++;
    } while (fs::exists(cand));
    return narrow(cand.c_str());
}

void usage() {
    printf(
        "dlss5nr - run DLSS 5 Neural Rendering over a video\n\n"
        "  dlss5nr --input in.mp4 --output out.mp4 [options]\n\n"
        "  --snippet <path>     nvngx_dlssnr.dll        (default: nvngx_dlssnr.dll)\n"
        "  --forwarder <path>   nvngx.dll_dlssnr.dll    (default: nvngx.dll_dlssnr.dll)\n"
        "  --encoder <name>     h264_nvenc | hevc_nvenc | libx264 | libx265\n"
        "  --start-time <s>     process from this time offset (seconds)\n"
        "  --end-time <s>       process up to this time (seconds); 0 = to the end\n"
        "  --dump-frame <p.ppm> save the raw (unmodified) first decoded frame as a PPM image,\n"
        "                       used by the single-frame preview so the UI gets an exact\n"
        "                       before/after pair without decoding the video twice\n"
        "  --no-audio           drop the source audio instead of copying it\n"
        "  --hw-decode          NVDEC decode (experimental; not faster here, can stall)\n"
        "  --codec-args <s>     extra arguments appended to the encoder\n"
        "  --pix-fmt <s>         output pixel format (default yuv420p; yuv444p keeps 4:4:4 chroma)\n"
        "  --frame-reset        process every frame independently (no cross-frame history),\n"
        "                       matching how a real-time filter over a video behaves\n"
        "  --bypass-nr          skip the DLSS NR inference (diagnostic: input -> colour/dither\n"
        "                       path only, lets you isolate model artifacts from banding/grid)\n"
        "  --png16 <png>        write the first rendered frame as a 16-bit RGB PNG (65536 levels,\n"
        "                       no 8-bit quantisation => no colour banding; used by the image path)\n"
        "  --gpu-idx <N>        pick the render GPU by index (see --list-gpus)\n"
        "  --list-gpus          list every render-capable adapter and exit\n"
        "  --warp               force the WARP software D3D12 device (CPU rendering; automatic\n"
        "                       fallback when no hardware GPU can be initialised)\n"
        "  --onnx-nr            force the ONNX DLSS5 reconstruction backend (community re-build\n"
        "                       with real extracted weights; runs on any GPU via WebGPU, or CPU)\n"
        "  --onnx-model <path>  explicit .onnx path (default: probe models/onnx/*.onnx)\n\n"
        "  Model controls (latched at feature creation):\n"
        "  --preset <0..3>            NR Preset\n"
        "  --intensity <f>            NR Intensity\n"
        "  --style <0..2>             NR Style: 0 default, 1 natural, 2 cinematic\n"
        "  --local-tone <f>           Local Tone Strength\n"
        "  --local-structure <f>      Local Structure Strength\n"
        "  --skin-structure <f>       Skin Structure Strength\n"
        "  --auto-mask <0|1>          Automatic Mask\n"
        "  --ui-correction <0|1>      NR UI Correction\n\n"
        "  Temporal guides:\n"
        "  --frame-guidance <0|3|4>  motion source: 0 Force Zero (no motion),\n"
        "                            3 NVIDIA hardware optical flow (NV-OF; on a non-NVIDIA\n"
        "                            device this automatically falls back to 4),\n"
        "                            4 vendor-neutral optical flow: D3D12 compute on any GPU\n"
        "                            (AMD/Intel/NVIDIA, incl. WARP) with a CPU matcher fallback.\n"
        "                            NV-OF (3) needs a supported NVIDIA GPU + driver; the\n"
        "                            generic flow (4) runs everywhere.\n"
        "  --mvec-quality <0|1|2>    flow engine tier: 0 FAST (fastest, noisier flow),\n"
        "                            1 MEDIUM, 2 SLOW (default: slowest, most accurate flow).\n"
        "                            Quality mainly shows as flow noise on low-texture areas\n"
        "  --depth-interval <N>       update depth from DepthAnything every N frames\n"
        "                            (0 = Force Zero depth)\n"
        "  --residual-mult <f>        residual reconstruction: out = in + (model-in)*f\n"
        "                              (1.0..2.0; 1.0 = pure model output, Magpie defaults ~1.1)\n\n"
        "  --perf                     print per-stage ms/frame breakdown (decode/NV-OF/depth/\n"
        "                              upload/evaluate/download/encode) at the end of the run\n\n"
        "Progress is written to stdout as: PROGRESS <done>/<total>\n");
}

int parseCommandLine(int argc, wchar_t** argv, Options& opt, int& exitCode) {
    // Flag-only options would be skipped by the value-consuming parse loop when nothing follows
    // them, so scan for them up front (e.g. "dlss5nr_engine --daemon").
    for (int i = 1; i < argc; ++i) {
        std::string flag = narrow(argv[i]);
        if (flag == "--daemon") opt.daemon = true;
        else if (flag == "--perf") opt.perf = true;
        else if (flag == "--list-gpus") opt.listGpus = true;
        else if (flag == "--warp") opt.warp = true;
        else if (flag == "--onnx-nr") opt.onnxNr = true;
    }

    // Standalone metadata stamping: dlss5nr_engine --meta-inject out.png --meta-json '{"v":1,...}'
    // Injects into PNG (tEXt) or JPG (COM marker), then exits without touching the GPU pipeline.
    // server.js calls this after transcoding a stamped PNG to JPG (ffmpeg drops tEXt on transcode).
    for (int i = 1; i < argc; ++i) {
        if (narrow(argv[i]) != "--meta-inject") continue;
        std::string file = (i + 1 < argc) ? narrow(argv[i + 1]) : "";
        std::string json;
        for (int j = i + 2; j + 1 < argc; ++j)
            if (narrow(argv[j]) == "--meta-json") json = narrow(argv[j + 1]);
        if (file.empty() || json.empty()) {
            fprintf(stderr,
                    "usage: dlss5nr_engine --meta-inject <png|jpg> --meta-json <compactJson>\n");
            exitCode = 2;
            return 1;
        }
        if (!injectMetaFile(file, makeMetaPayload(json))) {
            fprintf(stderr, "meta-inject failed on %s (png/jpg only?)\n", file.c_str());
            exitCode = 1;
            return 1;
        }
        printf("meta-injected: %s\n", file.c_str());
        exitCode = 0;
        return 1;
    }

    for (int i = 1; i < argc; ++i) {
        std::string a = narrow(argv[i]);
        if (a == "--help" || a == "-h") {
            usage();
            exitCode = 0;
            return 1;
        }
        if (a.empty() || a[0] != '-' || i + 1 >= argc) continue;
        std::string v = narrow(argv[++i]);

        if (a == "--input") opt.input = v;
        else if (a == "--output") opt.output = v;
        else if (a == "--snippet") opt.snippet = v;
        else if (a == "--forwarder") opt.forwarder = v;
        else if (a == "--encoder") opt.encoder = v;
        else if (a == "--codec-args") opt.extraArgs = v;
        else if (a == "--pix-fmt") opt.pixFmt = v;
        else if (a == "--dump-frame") opt.dumpFrame = v;
        if (a == "--no-audio") { opt.keepAudio = false; --i; }
        else if (a == "--hw-decode") { opt.hwDecode = true; --i; }
        else if (a == "--daemon") { opt.daemon = true; --i; }
        else if (a == "--start-time") parseDouble(v.c_str(), opt.startTime);
        else if (a == "--end-time") parseDouble(v.c_str(), opt.endTime);
        else if (a == "--preset") parseInt(v.c_str(), opt.nr.preset);
        else if (a == "--intensity") parseFloat(v.c_str(), opt.nr.intensity);
        else if (a == "--style") parseInt(v.c_str(), opt.nr.style);
        else if (a == "--local-tone") parseFloat(v.c_str(), opt.nr.localTone);
        else if (a == "--local-structure") parseFloat(v.c_str(), opt.nr.localStructure);
        else if (a == "--skin-structure") parseFloat(v.c_str(), opt.nr.skinStructure);
        else if (a == "--auto-mask") parseInt(v.c_str(), opt.nr.useAutoMask);
        else if (a == "--ui-correction") parseInt(v.c_str(), opt.nr.uiCorrection);
        else if (a == "--frame-reset") { opt.frameReset = true; --i; }
        else if (a == "--bypass-nr") { opt.bypassNr = true; --i; }
        else if (a == "--png16") opt.png16 = v;
        else if (a == "--residual-mult") parseFloat(v.c_str(), opt.residualMult);
        else if (a == "--frame-guidance") parseInt(v.c_str(), opt.frameGuidance);
        else if (a == "--mvec-quality") parseInt(v.c_str(), opt.mvecQuality);
        else if (a == "--depth-interval") parseInt(v.c_str(), opt.depthInterval);
        else if (a == "--gpu-idx") parseInt(v.c_str(), opt.gpuIdx);
        else if (a == "--warp") { opt.warp = true; --i; }
        else if (a == "--onnx-nr") { opt.onnxNr = true; --i; }
        else if (a == "--onnx-model") opt.onnxModel = v;
        else if (a == "--perf") { opt.perf = true; --i; }
    }
    return 0;
}

void applyEncoderPolicy(Options& opt) {
    prependBundledToolsToPath();

    // Before any alias is applied: a plain NVENC request on a non-NVIDIA box becomes the
    // matching software encoder so the render does not die when the encoder opens.
    degradeNvenc(opt, "needs an NVIDIA GPU", 18, 20);

    // 10-bit encoder aliases: *_10bit map to the base encoder + a 10-bit pixel format
    // (yuv420p10le; NVENC also needs the main10 profile). The deep pipeline reads the 16F
    // result back, so these outputs never touch an 8-bit quantisation.
    if (opt.encoder == "hevc_nvenc_10bit") {
        opt.encoder = "hevc_nvenc";
        if (opt.pixFmt == "yuv420p") opt.pixFmt = "yuv420p10le";
        if (opt.extraArgs.find("-profile:v") == std::string::npos)
            opt.extraArgs += " -profile:v main10";
    } else if (opt.encoder == "libx265_10bit") {
        opt.encoder = "libx265";
        if (opt.pixFmt == "yuv420p") opt.pixFmt = "yuv420p10le";
    } else if (opt.encoder == "hevc10_master" || opt.encoder == "hevc10_lossless") {
        // Master intermediate for the two-stage flow. Near-lossless 10-bit HEVC via NVENC so the
        // master render stays at hardware-encode speed (a lossless libx265 master serialised the
        // CPU and dropped long renders to a few fps). Re-exporting later is a fast transcode.
        opt.encoder = "hevc_nvenc";
        if (opt.pixFmt == "yuv420p") opt.pixFmt = "yuv420p10le";
        if (opt.extraArgs.find("-profile:v") == std::string::npos)
            opt.extraArgs += " -rc vbr -cq 14 -b:v 0 -profile:v main10";
    }

    // An alias above can re-select NVENC, and it also carries NVENC-only flags (-rc/-cq/-b:v)
    // that libx264/libx265 would reject, so re-run the downgrade with the master path's higher
    // quality floor and strip those flags afterwards.
    if (opt.encoder.find("nvenc") != std::string::npos) {
        if (degradeNvenc(opt, "needs an NVIDIA GPU", 16, 14)) {
            for (const char* flag : {" -rc vbr", " -cq 14", " -b:v 0"}) {
                size_t pos = opt.extraArgs.find(flag);
                if (pos != std::string::npos) opt.extraArgs.erase(pos, strlen(flag));
            }
        }
    }
}

}  // namespace dlss5nr
