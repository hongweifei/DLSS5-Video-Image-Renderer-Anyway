#pragma once

#include <windows.h>

#include <cstdint>
#include <string>
#include <vector>

// DLSS 5 neural rendering via the community ONNX reconstruction (taowen/dlss5-onnx).
//
// The model is a static-image re-implementation of the 71-block DLSS NR network with the real
// weights extracted from nvngx_dlssnr.dll (WEIGHTS_HT2 resource). Tensor contract:
//   input  'rgb'    [1,3,256,256] float32, LINEAR light, [0,1]
//   output 'output' [1,3,256,256] float32, linear light [0,1]
// The frame is sRGB-decoded to linear on the CPU, split into 256x256 tiles, run through the
// network and sRGB-encoded back. Tiling is overlap-free (the model was trained on full frames;
// tile seams are the accepted trade-off for arbitrary resolutions on non-NVIDIA hardware).
//
// Execution providers, tried in this order (first that compiles the graph wins):
//   1. WebGPU (Dawn -> D3D12/Vulkan/Metal) - cross-vendor, and unlike DirectML it compiles this
//      27k-node graph WITH its dynamic Shape/Gather attention masks. Needs the plugin EP
//      (webgpu/onnxruntime_providers_webgpu.dll + dxcompiler.dll + dxil.dll) and ORT >= 1.24.4.
//   2. DirectML - fast where it accepts the graph; some drivers (e.g. Intel Iris Xe) reject it
//      with E_INVALIDARG, so this is best-effort.
//   3. CPU EP - always works.
//
// WebGPU sessions must be used ONE AT A TIME: two concurrent WebGPU sessions crash the process
// on the test machine. The pool below therefore only parallelises the CPU path.
//
// Measured on the Intel Iris Xe test machine (16 threads, 256x256 tile):
//   WebGPU ~1.0 s/tile   |   DirectML: fails   |   CPU single ~2.3 s   |   CPU 2x8 ~1.15 s
// So on this weak iGPU WebGPU is a modest win; on any discrete AMD/Intel/NVIDIA GPU it is the
// difference between seconds and milliseconds per tile.
class OnnxNr {
public:
    OnnxNr() = default;
    ~OnnxNr();

    OnnxNr(const OnnxNr&) = delete;
    OnnxNr& operator=(const OnnxNr&) = delete;

    // dllDir holds onnxruntime.dll (+ DirectML.dll, + the webgpu/ plugin subdirectory).
    // modelPath is the .onnx file. threads: 0 = auto-tune the CPU session pool.
    bool init(const std::string& dllDir, const std::string& modelPath, int threads);

    bool ok() const { return m_ok; }
    const char* lastError() const { return m_err.c_str(); }
    const char* provider() const { return m_provider.c_str(); }
    int sessions() const { return (int)m_sess.size(); }
    bool isWebGpu() const { return m_isWebGpu; }

    // Enhance one RGBA8 frame (w*h*4). outDst may equal rgba.
    bool feed(const uint8_t* rgba, uint8_t* outDst, uint32_t w, uint32_t h);

private:
    void destroy();
    bool loadOrt();
    bool createSession(const std::string& modelPath, int intraThreads, void** outSession,
                       std::string* providerOut);
    // Registers the WebGPU plugin EP and builds a session on the first WebGPU device. Returns
    // false (without setting a fatal error) when the plugin is absent or has no adapter.
    bool createWebGpuSession(const std::string& modelPath, void** outSession);

    bool m_ok = false;
    std::string m_err;
    std::string m_provider;
    std::wstring m_dllDirW;     // directory holding onnxruntime.dll / DirectML.dll
    std::wstring m_modelDirW;   // directory holding the .onnx (may carry webgpu/ too)
    bool m_isWebGpu = false;

    void* m_ortModule = nullptr;
    void* m_dmlModule = nullptr;
    void* m_wgpuModule = nullptr;         // plugin EP dll (registered with ORT, not freed early)
    void* m_env = nullptr;
    void* m_memoryInfo = nullptr;
    const void* m_api = nullptr;          // const OrtApi* (set by loadOrt)

    int m_threads = 0;
    int m_intra = 8;                      // intra-op threads per pooled session
    int64_t m_tile = 256;                 // model input size
    std::vector<void*> m_sess;            // session pool (WebGPU: exactly one entry)
};
