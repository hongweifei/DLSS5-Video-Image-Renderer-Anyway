// DLSS 5 ONNX reconstruction backend (see onnx_nr.h for the contract).
//
// Session pool: the graph is heavy, so a single tile does not scale linearly across all cores
// (measured on a 16-thread laptop: 2.08 s/tile at 16 threads vs 2.30 s/tile at 8 threads with
// TWO tiles in flight -> 0.48 vs 0.87 tiles/s). Tiles are therefore dispatched to a small pool
// of sessions, each configured with intra_op = cores/pool.

#include "onnx_nr.h"

#include "util.h"

#include <cstring>
#include <cmath>
#include <cstdio>
#include <algorithm>
#include <atomic>
#include <mutex>
#include <thread>

#include "depth/onnxruntime_c_api.h"

using dlss5nr::absolutePath;
using dlss5nr::widen;

// windows.h (included via onnx_nr.h) defines min/max macros that clash with std::min/std::max.
#undef min
#undef max

namespace {

using OrtStatusPtr = OrtStatus*;
using PFN_AppendDML = OrtStatusPtr(ORT_API_CALL*)(OrtSessionOptions*, int);

inline float srgbToLinear(float c) {
    return c <= 0.04045f ? c / 12.92f : std::pow((c + 0.055f) / 1.055f, 2.4f);
}
inline float linearToSrgb(float c) {
    c = c < 0.f ? 0.f : (c > 1.f ? 1.f : c);
    return c <= 0.0031308f ? c * 12.92f : 1.055f * std::pow(c, 1.f / 2.4f) - 0.055f;
}

}  // namespace

OnnxNr::~OnnxNr() { destroy(); }

void OnnxNr::destroy() {
    const OrtApi* api = nullptr;
    if (m_ortModule) {
        auto fnGetApiBase = (const OrtApiBase* (ORT_API_CALL*)())GetProcAddress(
            (HMODULE)m_ortModule, "OrtGetApiBase");
        if (fnGetApiBase) api = fnGetApiBase()->GetApi(ORT_API_VERSION);
    }
    if (api) {
        for (void* s : m_sess) if (s) api->ReleaseSession((OrtSession*)s);
        if (m_env) api->ReleaseEnv((OrtEnv*)m_env);
        if (m_memoryInfo) api->ReleaseMemoryInfo((OrtMemoryInfo*)m_memoryInfo);
    }
    m_sess.clear();
    if (m_dmlModule) FreeLibrary((HMODULE)m_dmlModule);
    if (m_ortModule) FreeLibrary((HMODULE)m_ortModule);
    m_env = m_memoryInfo = nullptr;
    m_ortModule = m_dmlModule = nullptr;
    m_ok = false;
}

bool OnnxNr::init(const std::string& dllDir, const std::string& modelPath, int threads) {
    m_threads = threads;
    m_dllDirW = dlss5nr::widen(dllDir);
    if (!loadOrt()) return false;

    // 1) WebGPU first: it accepts this graph where DirectML often does not, and it is the only
    //    GPU path that works across vendors without a vendor SDK. One session only (concurrent
    //    WebGPU sessions crash the process - measured).
    {
        void* sess = nullptr;
        if (createWebGpuSession(modelPath, &sess)) {
            m_sess.push_back(sess);
            m_provider = "WebGPU";
            m_isWebGpu = true;
            m_ok = true;
            printf("[onnxnr] WebGPU execution provider (Dawn -> D3D12/Vulkan), 1 session\n");
            return true;
        }
    }

    // 2/3) DirectML then CPU, pooled for CPU throughput. Pool layout: pick (intra, count) so
    // intra*count approximates the core count. Measured optimum on a 16-thread machine is
    // intra=8, count=2; scale that shape to other machines and cap the pool so memory stays
    // bounded (each session holds the ~300 MB of weights).
    unsigned cores = std::thread::hardware_concurrency();
    if (cores == 0) cores = 8;
    if (threads > 0) cores = (unsigned)threads;
    int count = (int)((cores + 7) / 8);         // one session per 8 cores
    if (count < 1) count = 1;
    if (count > 4) count = 4;                   // cap: 4 sessions x ~300 MB of weights
    m_intra = (int)(cores / (unsigned)count);
    if (m_intra < 1) m_intra = 1;

    for (int i = 0; i < count; ++i) {
        void* sess = nullptr;
        std::string prov;
        if (!createSession(modelPath, m_intra, &sess, &prov)) {
            if (m_sess.empty()) { destroy(); return false; }
            break;   // keep the sessions we have; one is enough to make progress
        }
        if (m_provider.empty()) m_provider = prov;
        m_sess.push_back(sess);
    }
    if (m_sess.empty()) { destroy(); return false; }

    printf("[onnxnr] %d session(s) x %d intra-op threads\n", (int)m_sess.size(), m_intra);
    m_ok = true;
    return true;
}

bool OnnxNr::loadOrt() {
    const std::wstring ortPath = m_dllDirW + L"\\onnxruntime.dll";
    const std::wstring dmlPath = m_dllDirW + L"\\DirectML.dll";
    if (!m_dllDirW.empty()) SetDllDirectoryW(m_dllDirW.c_str());
    // LOAD_WITH_ALTERED_SEARCH_PATH only works with an ABSOLUTE dll path; the probe above
    // produces cwd-relative paths ("models/onnx/..."), so normalise both to absolute first.
    m_ortModule = (void*)LoadLibraryExW(absolutePath(ortPath).c_str(), nullptr,
                                        LOAD_WITH_ALTERED_SEARCH_PATH);
    if (!m_ortModule) {
        char buf[256];
        snprintf(buf, sizeof(buf), "onnxruntime.dll load failed (err=%lu)",
                 (unsigned long)GetLastError());
        m_err = buf;
        return false;
    }
    // DirectML.dll is loaded by ORT on demand; probe it up front so the error message is clear.
    m_dmlModule = (void*)LoadLibraryExW(absolutePath(dmlPath).c_str(), nullptr,
                                        LOAD_WITH_ALTERED_SEARCH_PATH);
    // (not fatal: the CPU EP works without it)

    auto fnGetApiBase = (const OrtApiBase* (ORT_API_CALL*)())GetProcAddress(
        (HMODULE)m_ortModule, "OrtGetApiBase");
    if (!fnGetApiBase) { m_err = "OrtGetApiBase missing"; return false; }
    const OrtApi* api = fnGetApiBase()->GetApi(ORT_API_VERSION);
    if (!api) { m_err = "ORT api version unavailable"; return false; }
    m_api = api;

    // The WebGPU plugin EP may live in a `webgpu/` subdirectory next to the runtime (that is
    // how this project ships it); add it to the search path so the plugin can find dxcompiler.
    if (!m_dllDirW.empty()) {
        std::wstring wg = m_dllDirW + L"\\webgpu";
        DWORD attrs = GetFileAttributesW(wg.c_str());
        if (attrs != INVALID_FILE_ATTRIBUTES && (attrs & FILE_ATTRIBUTE_DIRECTORY))
            AddDllDirectory(wg.c_str());
    }

    OrtEnv* env = nullptr;
    OrtStatusPtr st = api->CreateEnv(ORT_LOGGING_LEVEL_ERROR, "dlss5nr-onnx", &env);
    if (st) { m_err = api->GetErrorMessage(st); api->ReleaseStatus(st); return false; }
    m_env = env;

    OrtMemoryInfo* mi = nullptr;
    st = api->CreateCpuMemoryInfo(OrtArenaAllocator, OrtMemTypeDefault, &mi);
    if (st) { m_err = api->GetErrorMessage(st); api->ReleaseStatus(st); return false; }
    m_memoryInfo = mi;
    return true;
}

// Registers the WebGPU plugin EP (if present) and builds a session on its first device.
// Returns false - without making the whole backend fail - when the plugin is missing, has no
// compatible adapter, or cannot compile this graph.
bool OnnxNr::createWebGpuSession(const std::string& modelPath, void** outSession) {
    const OrtApi* api = (const OrtApi*)m_api;
    if (!api || !m_env) return false;
    // API 1.22+ is required for the plugin EP entry points.
    if (!api->RegisterExecutionProviderLibrary || !api->GetEpDevices ||
        !api->SessionOptionsAppendExecutionProvider_V2) {
        return false;
    }

    // Locate the plugin: either beside the runtime or in the webgpu/ subdirectory.
    wchar_t cwd[MAX_PATH] = {};
    GetCurrentDirectoryW(MAX_PATH, cwd);
    std::wstring wgpu;
    for (const std::wstring& cand : { m_dllDirW + L"\\webgpu\\onnxruntime_providers_webgpu.dll",
                                      m_dllDirW + L"\\onnxruntime_providers_webgpu.dll" }) {
        DWORD a = GetFileAttributesW(cand.c_str());
        if (a != INVALID_FILE_ATTRIBUTES && !(a & FILE_ATTRIBUTE_DIRECTORY)) { wgpu = cand; break; }
    }
    if (wgpu.empty()) {
        printf("[onnxnr] WebGPU plugin EP not found (expected webgpu/"
               "onnxruntime_providers_webgpu.dll)\n");
        return false;
    }

    // Absolute path for the loader, then register. dxcompiler/dxil are resolved from the
    // plugin's own directory via AddDllDirectory (set in loadOrt).
    wchar_t abs[MAX_PATH] = {};
    if (GetFullPathNameW(wgpu.c_str(), MAX_PATH, abs, nullptr) == 0) return false;
    m_wgpuModule = (void*)LoadLibraryExW(abs, nullptr, LOAD_WITH_ALTERED_SEARCH_PATH);

    OrtStatusPtr st = api->RegisterExecutionProviderLibrary((OrtEnv*)m_env, "webgpu_ep", abs);
    if (st) {
        const char* msg = api->GetErrorMessage(st);
        printf("[onnxnr] WebGPU plugin registration failed: %s\n", msg ? msg : "?");
        api->ReleaseStatus(st);
        return false;
    }

    // Pick the first device the plugin advertises. (Concurrent WebGPU sessions crash, so the
    // caller keeps exactly one.)
    const OrtEpDevice* const* devices = nullptr;
    size_t num = 0;
    st = api->GetEpDevices((const OrtEnv*)m_env, &devices, &num);
    if (st) { api->ReleaseStatus(st); return false; }
    const OrtEpDevice* pick = nullptr;
    for (size_t i = 0; i < num; ++i) {
        const char* name = api->EpDevice_EpName(devices[i]);
        if (name && strstr(name, "WebGpu")) { pick = devices[i]; break; }
    }
    if (!pick) {
        printf("[onnxnr] WebGPU EP registered but no device/adapter was found\n");
        return false;
    }

    const std::wstring modelW = dlss5nr::widen(modelPath);

    OrtSessionOptions* so = nullptr;
    st = api->CreateSessionOptions(&so);
    if (st) { api->ReleaseStatus(st); return false; }
    api->SetSessionGraphOptimizationLevel(so, ORT_ENABLE_ALL);
    const OrtEpDevice* one[1] = { pick };
    st = api->SessionOptionsAppendExecutionProvider_V2(so, (OrtEnv*)m_env, one, 1, nullptr,
                                                       nullptr, 0);
    if (st) {
        const char* msg = api->GetErrorMessage(st);
        printf("[onnxnr] WebGPU append failed: %s\n", msg ? msg : "?");
        api->ReleaseStatus(st);
        api->ReleaseSessionOptions(so);
        return false;
    }

    OrtSession* sess = nullptr;
    st = api->CreateSession((OrtEnv*)m_env, modelW.c_str(), so, &sess);
    api->ReleaseSessionOptions(so);
    if (st) {
        const char* msg = api->GetErrorMessage(st);
        printf("[onnxnr] WebGPU could not compile this graph (%s); trying DirectML/CPU\n",
               msg ? msg : "?");
        api->ReleaseStatus(st);
        return false;
    }
    *outSession = sess;
    return true;
}

bool OnnxNr::createSession(const std::string& modelPath, int intraThreads, void** outSession,
                           std::string* providerOut) {
    const OrtApi* api = nullptr;
    auto getBase = (const OrtApiBase* (ORT_API_CALL*)())GetProcAddress((HMODULE)m_ortModule,
                                                                      "OrtGetApiBase");
    api = getBase()->GetApi(ORT_API_VERSION);

    const std::wstring modelW = dlss5nr::widen(modelPath);

    // 1) DirectML (any GPU) - the fast path. Some graphs fail to compile on some drivers;
    //    fall through to CPU on any failure.
    if (m_dmlModule) {
        auto pfnAppend = (PFN_AppendDML)GetProcAddress((HMODULE)m_ortModule,
                                                       "OrtSessionOptionsAppendExecutionProvider_DML");
        if (pfnAppend) {
            OrtSessionOptions* dmlSo = nullptr;
            if (!api->CreateSessionOptions(&dmlSo)) {
                api->SetSessionGraphOptimizationLevel(dmlSo, ORT_ENABLE_ALL);
                api->SetIntraOpNumThreads(dmlSo, intraThreads);
                OrtStatusPtr dst = pfnAppend(dmlSo, 0);
                OrtSession* sess = nullptr;
                OrtStatusPtr cst = dst ? dst
                                       : api->CreateSession((OrtEnv*)m_env, modelW.c_str(), dmlSo,
                                                            &sess);
                if (!cst && sess) {
                    api->ReleaseSessionOptions(dmlSo);
                    *outSession = sess;
                    *providerOut = "DirectML";
                    printf("[onnxnr] DirectML execution provider\n");
                    return true;
                }
                if (cst) {
                    if (dst) api->ReleaseStatus(dst);
                    else api->ReleaseStatus(cst);
                }
                api->ReleaseSessionOptions(dmlSo);
            }
        }
        printf("[onnxnr] DirectML could not compile this graph; using the CPU provider\n");
    }

    // 2) CPU EP
    OrtSessionOptions* so = nullptr;
    OrtStatusPtr st = api->CreateSessionOptions(&so);
    if (st) { m_err = api->GetErrorMessage(st); api->ReleaseStatus(st); return false; }
    api->SetSessionGraphOptimizationLevel(so, ORT_ENABLE_ALL);
    api->SetIntraOpNumThreads(so, intraThreads);
    OrtSession* sess = nullptr;
    st = api->CreateSession((OrtEnv*)m_env, modelW.c_str(), so, &sess);
    if (st) {
        m_err = std::string("CPU session failed: ") + api->GetErrorMessage(st);
        api->ReleaseStatus(st);
        api->ReleaseSessionOptions(so);
        return false;
    }
    api->ReleaseSessionOptions(so);
    *outSession = sess;
    *providerOut = "CPU";
    return true;
}

bool OnnxNr::feed(const uint8_t* rgba, uint8_t* outDst, uint32_t w, uint32_t h) {
    if (!m_ok || !rgba || !outDst || !w || !h) {
        m_err = "bad feed args";
        return false;
    }
    const OrtApi* api = nullptr;
    auto getBase = (const OrtApiBase* (ORT_API_CALL*)())GetProcAddress((HMODULE)m_ortModule,
                                                                      "OrtGetApiBase");
    api = getBase()->GetApi(ORT_API_VERSION);

    const int64_t T = m_tile;
    const size_t TP = (size_t)T * T;

    // Work on a copy when in-place so source tiles are never overwritten before use.
    const uint8_t* src = rgba;
    std::vector<uint8_t> copy;
    if (outDst == rgba) {
        copy.assign(rgba, rgba + (size_t)w * h * 4);
        src = copy.data();
    }

    // Build the tile job list: (x, y) origins. Partial edge tiles are padded by replication.
    struct Tile { uint32_t x, y; };
    std::vector<Tile> tiles;
    for (uint32_t ty = 0; ty < h; ty += (uint32_t)T)
        for (uint32_t tx = 0; tx < w; tx += (uint32_t)T)
            tiles.push_back({tx, ty});

    std::atomic<size_t> next{0};
    std::atomic<bool> failed{false};
    std::mutex errMtx;
    std::string errMsg;

    auto worker = [&](void* session) {
        std::vector<float> inTile((size_t)3 * TP);
        std::vector<uint8_t> tileIn((size_t)T * T * 4);
        std::vector<uint8_t> tileOut((size_t)T * T * 4);
        for (;;) {
            if (failed.load()) return;
            const size_t idx = next.fetch_add(1);
            if (idx >= tiles.size()) return;
            const uint32_t tx = tiles[idx].x, ty = tiles[idx].y;
            const uint32_t tw = std::min<uint32_t>((uint32_t)T, w - tx);
            const uint32_t th = std::min<uint32_t>((uint32_t)T, h - ty);

            // gather (replicating edge pixels for partial tiles)
            for (uint32_t y = 0; y < (uint32_t)T; ++y) {
                const uint32_t sy = std::min(ty + y, h - 1);
                for (uint32_t x = 0; x < (uint32_t)T; ++x) {
                    const uint32_t sx = std::min(tx + x, w - 1);
                    memcpy(tileIn.data() + ((size_t)y * T + x) * 4,
                           src + ((size_t)sy * w + sx) * 4, 4);
                }
            }
            // sRGB -> linear, planar CHW
            for (size_t i = 0; i < TP; ++i) {
                inTile[i] = srgbToLinear(tileIn[i * 4 + 0] / 255.f);
                inTile[TP + i] = srgbToLinear(tileIn[i * 4 + 1] / 255.f);
                inTile[2 * TP + i] = srgbToLinear(tileIn[i * 4 + 2] / 255.f);
            }

            int64_t inShape[4] = {1, 3, T, T};
            OrtValue* inVal = nullptr;
            OrtStatusPtr st = api->CreateTensorWithDataAsOrtValue(
                (OrtMemoryInfo*)m_memoryInfo, inTile.data(), inTile.size() * sizeof(float),
                inShape, 4, ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT, &inVal);
            if (st) {
                std::lock_guard<std::mutex> lk(errMtx);
                errMsg = api->GetErrorMessage(st);
                api->ReleaseStatus(st);
                failed.store(true);
                return;
            }
            const char* inNames[] = { "rgb" };
            const char* outNames[] = { "output" };
            OrtValue* outVal = nullptr;
            st = api->Run((OrtSession*)session, nullptr, inNames,
                          (const OrtValue* const*)&inVal, 1, outNames, 1, &outVal);
            api->ReleaseValue(inVal);
            if (st) {
                std::lock_guard<std::mutex> lk(errMtx);
                errMsg = api->GetErrorMessage(st);
                api->ReleaseStatus(st);
                failed.store(true);
                return;
            }
            float* outData = nullptr;
            st = api->GetTensorMutableData(outVal, (void**)&outData);
            if (st) {
                std::lock_guard<std::mutex> lk(errMtx);
                errMsg = api->GetErrorMessage(st);
                api->ReleaseStatus(st);
                api->ReleaseValue(outVal);
                failed.store(true);
                return;
            }
            // linear -> sRGB back into the tile (alpha preserved)
            for (size_t i = 0; i < TP; ++i) {
                tileOut[i * 4 + 0] = (uint8_t)(linearToSrgb(outData[i]) * 255.f + 0.5f);
                tileOut[i * 4 + 1] = (uint8_t)(linearToSrgb(outData[TP + i]) * 255.f + 0.5f);
                tileOut[i * 4 + 2] = (uint8_t)(linearToSrgb(outData[2 * TP + i]) * 255.f + 0.5f);
            }
            api->ReleaseValue(outVal);

            for (uint32_t y = 0; y < th; ++y) {
                memcpy(outDst + ((size_t)(ty + y) * w + tx) * 4,
                       tileOut.data() + (size_t)y * T * 4, (size_t)tw * 4);
            }
        }
    };

    if (m_sess.size() <= 1) {
        worker(m_sess.empty() ? nullptr : m_sess[0]);
    } else {
        std::vector<std::thread> pool;
        pool.reserve(m_sess.size());
        for (size_t i = 0; i < m_sess.size(); ++i)
            pool.emplace_back(worker, m_sess[i]);
        for (auto& th : pool) th.join();
    }

    if (failed.load()) {
        if (!errMsg.empty()) m_err = errMsg;
        return false;
    }
    return true;
}
