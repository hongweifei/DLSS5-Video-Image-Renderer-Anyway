#pragma once

#include <windows.h>
#include <d3d12.h>
#include <wrl/client.h>

#include <cstdint>
#include <string>
#include <vector>
// Vendor-neutral optical flow backends that produce the SAME sparse S10.5 grid the NV-OF
// backend delivers (grid step 4, one int2 per cell, /32 px scale, forward motion). The D3D12
// densify pass and the DLSS NR model consume the grid unchanged, so the motion source is a
// drop-in swap decided at job start.
//
//   NvofMotion (nvof_flow.h)  - NVIDIA hardware optical flow (unchanged, N GPUs only)
//   GpuFlow     (this file)   - D3D12 compute block matching, runs on any GPU incl. WARP
//   CpuFlow     (this file)   - pure CPU fallback when no usable D3D12 device exists
//
// All backends implement IFlow so main.cpp's render loop stays backend-agnostic:
//   init(w, h)              create the session
//   gridWidth/Height/Size   sparse grid geometry (always step 4 here)
//   feed(curRGBA, outGrid)  push the next BGRA-on-CPU frame, write gridW*gridH*4 bytes
//   tier                    0 FAST / 1 MEDIUM / 2 SLOW quality (search range / iterations)
class IFlow {
public:
    virtual ~IFlow() = default;
    virtual bool init(uint32_t w, uint32_t h) = 0;
    virtual bool ok() const = 0;
    virtual const char* lastError() const = 0;
    virtual uint32_t gridSize() const = 0;
    virtual uint32_t gridWidth() const = 0;
    virtual uint32_t gridHeight() const = 0;
    virtual void setQuality(int tier) = 0;
    virtual int quality() const = 0;
    // Feed the current RGBA8 frame (w*h*4), produce the sparse flow grid
    // (gridW*gridH int2, S10.5 vectors * 32). First call yields zeros.
    virtual bool feed(const uint8_t* curRGBA, uint8_t* outGrid) = 0;
};

// Block-matching optical flow on a 4px grid, tiled so each block scans a +-R/2 search window
// against the previous frame. Quality tier maps to the search radius: FAST 8, MEDIUM 16,
// SLOW 32 px. A D3D12 compute shader does the matching when a device is available (any vendor,
// including WARP); CpuFlow runs the identical algorithm on the CPU otherwise.
class GpuFlow : public IFlow {
public:
    GpuFlow() = default;
    ~GpuFlow();

    GpuFlow(const GpuFlow&) = delete;
    GpuFlow& operator=(const GpuFlow&) = delete;

    bool init(uint32_t w, uint32_t h) override;
    bool ok() const override { return m_ok; }
    const char* lastError() const override { return m_err.c_str(); }
    uint32_t gridSize() const override { return 4; }
    uint32_t gridWidth() const override { return m_gridW; }
    uint32_t gridHeight() const override { return m_gridH; }
    void setQuality(int tier) override { m_quality = tier; }
    int quality() const override { return m_quality; }
    bool feed(const uint8_t* curRGBA, uint8_t* outGrid) override;

private:
    void destroy();

    bool m_ok = false;
    std::string m_err;
    Microsoft::WRL::ComPtr<ID3D12Device> m_dev;
    Microsoft::WRL::ComPtr<ID3D12CommandQueue> m_queue;
    Microsoft::WRL::ComPtr<ID3D12CommandAllocator> m_alloc;
    Microsoft::WRL::ComPtr<ID3D12GraphicsCommandList> m_list;
    Microsoft::WRL::ComPtr<ID3D12RootSignature> m_rootSig;
    Microsoft::WRL::ComPtr<ID3D12PipelineState> m_pso;
    Microsoft::WRL::ComPtr<ID3D12DescriptorHeap> m_heap;
    Microsoft::WRL::ComPtr<ID3D12Fence> m_fence;
    UINT64 m_fenceValue = 0;
    HANDLE m_fenceEvent = nullptr;

    Microsoft::WRL::ComPtr<ID3D12Resource> m_tex[2];      // RGBA8 prev/cur (GPU)
    Microsoft::WRL::ComPtr<ID3D12Resource> m_gridTex;     // sparse grid (R16G16_SINT, UAV)
    Microsoft::WRL::ComPtr<ID3D12Resource> m_upload;      // ring staging
    UINT64 m_uploadCap = 0;
    Microsoft::WRL::ComPtr<ID3D12Resource> m_readback;    // grid readback
    UINT64 m_readbackCap = 0;

    uint32_t m_w = 0, m_h = 0;
    uint32_t m_gridW = 0, m_gridH = 0;
    int m_quality = 2;
    int m_slot = 0;
    bool m_havePrev = false;
};

// CPU twin of the GPU kernel: same 4px grid, same SAD block matching, same S10.5 encoding.
// Used when even a software D3D12 device is unavailable. Multithreaded over rows.
class CpuFlow : public IFlow {
public:
    CpuFlow() = default;
    ~CpuFlow() override = default;

    bool init(uint32_t w, uint32_t h) override;
    bool ok() const override { return m_ok; }
    const char* lastError() const override { return m_err.c_str(); }
    uint32_t gridSize() const override { return 4; }
    uint32_t gridWidth() const override { return m_gridW; }
    uint32_t gridHeight() const override { return m_gridH; }
    void setQuality(int tier) override { m_quality = tier; }
    int quality() const override { return m_quality; }
    bool feed(const uint8_t* curRGBA, uint8_t* outGrid) override;

private:
    bool m_ok = false;
    std::string m_err;
    std::vector<uint8_t> m_prev;          // RGBA8 of the previous frame
    uint32_t m_w = 0, m_h = 0;
    uint32_t m_gridW = 0, m_gridH = 0;
    int m_quality = 2;
    bool m_havePrev = false;
};
