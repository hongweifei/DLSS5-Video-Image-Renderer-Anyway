// Vendor-neutral optical flow backends (see flow.h for the contract).
//
// GpuFlow: a D3D12 compute pass does 4x4-pixel block matching against the previous frame.
// Each thread handles one grid cell (= one 4x4 block). It sweeps candidate offsets in the
// previous frame inside a +-R/2 window (R from the quality tier), scores each candidate with
// the SAD over the block's 16 luma samples, keeps the best offset, then refines it with a
// +2/-2 px local sweep (MEDIUM/SLOW only). The result is packed as S10.5 int2 - exactly the
// NV-OF sparse grid encoding the densify pass already consumes (raw vectors * 32).
//
// CpuFlow: the same algorithm on the CPU, parallelised over grid-row stripes with
// std::thread. Used when even a software D3D12 device is unavailable.

#include "flow.h"

#include <atomic>
#include <climits>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <thread>

#include <d3dcompiler.h>

using Microsoft::WRL::ComPtr;

#pragma comment(lib, "d3dcompiler.lib")

namespace {

// Same S10.5/32 px scale and grid semantics as the NV-OF backend (denseify_pass.cpp reads
// int2 vectors and divides by 32).
const char* kFlowCS = R"(
Texture2D<float4> gPrev : register(t0);
Texture2D<float4> gCur  : register(t1);
RWTexture2D<int2> gOut  : register(u0);
cbuffer Flow : register(b0) { uint4 P; }   // x = width, y = height, z = search radius R, w = refine

inline float lumaAt(Texture2D<float4> t, int2 px, int w, int h) {
    px = clamp(px, int2(0, 0), int2(w - 1, h - 1));
    float3 c = t[px].rgb;
    return dot(c, float3(0.299f, 0.587f, 0.114f));
}

[numthreads(8, 8, 1)]
void CS(uint3 dt : SV_DispatchThreadID) {
    const int gw = (int)((P.x + 3u) / 4u);
    const int gh = (int)((P.y + 3u) / 4u);
    if (dt.x >= (uint)gw || dt.y >= (uint)gh) return;

    const int2 base = int2(dt.x, dt.y) * 4;          // block origin in the current frame

    float bestSAD = 1e30f;
    int2 best = int2(0, 0);
    const int R = (int)P.z;                          // search window +-R/2
    const int lo = -(R / 2), hi = R / 2;

    for (int dy = lo; dy <= hi; ++dy) {
        for (int dx = lo; dx <= hi; ++dx) {
            float sad = 0.f;
            [unroll] for (int j = 0; j < 4; ++j) {
                [unroll] for (int i = 0; i < 4; ++i) {
                    float a = lumaAt(gCur,  base + int2(i, j), (int)P.x, (int)P.y);
                    float b = lumaAt(gPrev, base + int2(i, j) + int2(dx, dy), (int)P.x, (int)P.y);
                    sad += abs(a - b);
                }
            }
            const float tie = sad * 1.0001f + 0.0001f * (abs(dx) + abs(dy));
            if (tie < bestSAD) { bestSAD = tie; best = int2(dx, dy); }
        }
    }

    if (P.w != 0u) {
        // Local +-2 px refinement around the coarse winner.
        int2 refined = best;
        float refBest = bestSAD;
        for (int dy = best.y - 2; dy <= best.y + 2; ++dy) {
            for (int dx = best.x - 2; dx <= best.x + 2; ++dx) {
                float sad = 0.f;
                [unroll] for (int j = 0; j < 4; ++j) {
                    [unroll] for (int i = 0; i < 4; ++i) {
                        float a = lumaAt(gCur,  base + int2(i, j), (int)P.x, (int)P.y);
                        float b = lumaAt(gPrev, base + int2(i, j) + int2(dx, dy), (int)P.x, (int)P.y);
                        sad += abs(a - b);
                    }
                }
                const float tie = sad * 1.0001f + 0.0001f * (abs(dx) + abs(dy));
                if (tie < refBest) { refBest = tie; refined = int2(dx, dy); }
            }
        }
        best = refined;
    }

    gOut[dt.xy] = best * 32;   // S10.5: multiply by 32, same encoding NV-OF delivers
}
)";

UINT alignPitch(UINT rowBytes) { return (rowBytes + 255u) & ~255u; }

int radiusFor(int tier) {
    if (tier <= 0) return 8;     // FAST
    if (tier == 1) return 16;    // MEDIUM
    return 32;                   // SLOW (default)
}

bool refineFor(int tier) { return tier >= 1; }

}  // namespace

// ------------------------------------------------------------------ GpuFlow

GpuFlow::~GpuFlow() { destroy(); }

void GpuFlow::destroy() {
    if (m_fenceEvent) { CloseHandle(m_fenceEvent); m_fenceEvent = nullptr; }
    m_tex[0].Reset(); m_tex[1].Reset();
    m_gridTex.Reset();
    m_upload.Reset(); m_readback.Reset();
    m_pso.Reset(); m_rootSig.Reset(); m_heap.Reset();
    m_list.Reset(); m_alloc.Reset(); m_queue.Reset(); m_dev.Reset();
}

bool GpuFlow::init(uint32_t w, uint32_t h) {
    m_w = w;
    m_h = h;
    m_gridW = (w + 3) / 4;
    m_gridH = (h + 3) / 4;
    m_havePrev = false;

    HRESULT hr = D3D12CreateDevice(nullptr, D3D_FEATURE_LEVEL_11_0, IID_PPV_ARGS(&m_dev));
    if (FAILED(hr)) {
        // Normal on CPU-only boxes; main.cpp falls back to CpuFlow.
        m_err = "D3D12CreateDevice failed";
        return false;
    }

    D3D12_COMMAND_QUEUE_DESC qd = {};
    qd.Type = D3D12_COMMAND_LIST_TYPE_DIRECT;
    if (FAILED(m_dev->CreateCommandQueue(&qd, IID_PPV_ARGS(&m_queue))) ||
        FAILED(m_dev->CreateCommandAllocator(D3D12_COMMAND_LIST_TYPE_DIRECT,
                                             IID_PPV_ARGS(&m_alloc)))) {
        m_err = "flow: queue/allocator creation failed";
        return false;
    }
    if (FAILED(m_dev->CreateCommandList(0, D3D12_COMMAND_LIST_TYPE_DIRECT, m_alloc.Get(), nullptr,
                                        IID_PPV_ARGS(&m_list)))) {
        m_err = "flow: command list creation failed";
        return false;
    }
    m_list->Close();
    if (FAILED(m_dev->CreateFence(0, D3D12_FENCE_FLAG_NONE, IID_PPV_ARGS(&m_fence)))) {
        m_err = "flow: fence creation failed";
        return false;
    }
    m_fenceEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    if (!m_fenceEvent) {
        m_err = "flow: event creation failed";
        return false;
    }

    ComPtr<ID3DBlob> cs, errBlob;
    hr = D3DCompile(kFlowCS, strlen(kFlowCS), nullptr, nullptr, nullptr, "CS", "cs_5_0",
                    D3DCOMPILE_OPTIMIZATION_LEVEL3, 0, &cs, &errBlob);
    if (FAILED(hr)) {
        m_err = "flow: CS compile failed";
        printf("[flow] %s\n", errBlob ? (const char*)errBlob->GetBufferPointer() : "");
        return false;
    }

    // Root signature: descriptor table (SRV t0 prev, SRV t1 cur, UAV u0 grid) + 4 constants.
    D3D12_DESCRIPTOR_RANGE ranges[2] = {};
    ranges[0].RangeType = D3D12_DESCRIPTOR_RANGE_TYPE_SRV;
    ranges[0].BaseShaderRegister = 0;
    ranges[0].NumDescriptors = 2;
    ranges[1].RangeType = D3D12_DESCRIPTOR_RANGE_TYPE_UAV;
    ranges[1].BaseShaderRegister = 0;
    ranges[1].NumDescriptors = 1;
    D3D12_ROOT_PARAMETER params[2] = {};
    params[0].ParameterType = D3D12_ROOT_PARAMETER_TYPE_DESCRIPTOR_TABLE;
    params[0].DescriptorTable.NumDescriptorRanges = 2;
    params[0].DescriptorTable.pDescriptorRanges = ranges;
    params[0].ShaderVisibility = D3D12_SHADER_VISIBILITY_ALL;
    params[1].ParameterType = D3D12_ROOT_PARAMETER_TYPE_32BIT_CONSTANTS;
    params[1].Constants.ShaderRegister = 0;
    params[1].Constants.Num32BitValues = 4;
    params[1].ShaderVisibility = D3D12_SHADER_VISIBILITY_ALL;

    D3D12_ROOT_SIGNATURE_DESC rsDesc = {};
    rsDesc.NumParameters = 2;
    rsDesc.pParameters = params;
    rsDesc.Flags = D3D12_ROOT_SIGNATURE_FLAG_NONE;
    ComPtr<ID3DBlob> rsBlob, rsErr;
    if (FAILED(D3D12SerializeRootSignature(&rsDesc, D3D_ROOT_SIGNATURE_VERSION_1_0, &rsBlob,
                                           &rsErr))) {
        m_err = "flow: root signature serialize failed";
        return false;
    }
    if (FAILED(m_dev->CreateRootSignature(0, rsBlob->GetBufferPointer(),
                                          rsBlob->GetBufferSize(), IID_PPV_ARGS(&m_rootSig)))) {
        m_err = "flow: CreateRootSignature failed";
        return false;
    }
    D3D12_COMPUTE_PIPELINE_STATE_DESC psDesc = {};
    psDesc.pRootSignature = m_rootSig.Get();
    psDesc.CS = {cs->GetBufferPointer(), cs->GetBufferSize()};
    if (FAILED(m_dev->CreateComputePipelineState(&psDesc, IID_PPV_ARGS(&m_pso)))) {
        m_err = "flow: CreateComputePipelineState failed";
        return false;
    }

    // Two alternating RGBA8 frame textures (SRV for the shader, written via CopyTextureRegion).
    D3D12_RESOURCE_DESC td = {};
    td.Dimension = D3D12_RESOURCE_DIMENSION_TEXTURE2D;
    td.Width = w;
    td.Height = h;
    td.DepthOrArraySize = 1;
    td.MipLevels = 1;
    td.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    td.SampleDesc.Count = 1;
    td.Flags = D3D12_RESOURCE_FLAG_ALLOW_UNORDERED_ACCESS;
    D3D12_HEAP_PROPERTIES hp = {};
    hp.Type = D3D12_HEAP_TYPE_DEFAULT;
    for (int i = 0; i < 2; ++i) {
        if (FAILED(m_dev->CreateCommittedResource(&hp, D3D12_HEAP_FLAG_NONE, &td,
                                                  D3D12_RESOURCE_STATE_COMMON, nullptr,
                                                  IID_PPV_ARGS(&m_tex[i])))) {
            m_err = "flow: frame texture alloc failed";
            return false;
        }
        wchar_t nm[32];
        swprintf(nm, 32, L"flow_in%d", i);
        m_tex[i]->SetName(nm);
    }

    // Sparse grid texture (R16G16_SINT, same layout as the NV-OF output) written as a UAV.
    D3D12_RESOURCE_DESC gd = td;
    gd.Width = m_gridW;
    gd.Height = m_gridH;
    gd.Format = DXGI_FORMAT_R16G16_SINT;
    if (FAILED(m_dev->CreateCommittedResource(&hp, D3D12_HEAP_FLAG_NONE, &gd,
                                              D3D12_RESOURCE_STATE_COMMON, nullptr,
                                              IID_PPV_ARGS(&m_gridTex)))) {
        m_err = "flow: grid texture alloc failed";
        return false;
    }
    m_gridTex->SetName(L"flow_grid");

    D3D12_DESCRIPTOR_HEAP_DESC hd = {};
    hd.Type = D3D12_DESCRIPTOR_HEAP_TYPE_CBV_SRV_UAV;
    hd.NumDescriptors = 3;   // t0 t1 u0
    hd.Flags = D3D12_DESCRIPTOR_HEAP_FLAG_SHADER_VISIBLE;
    if (FAILED(m_dev->CreateDescriptorHeap(&hd, IID_PPV_ARGS(&m_heap)))) {
        m_err = "flow: descriptor heap creation failed";
        return false;
    }
    D3D12_CPU_DESCRIPTOR_HANDLE cpu0 = m_heap->GetCPUDescriptorHandleForHeapStart();
    const UINT inc = m_dev->GetDescriptorHandleIncrementSize(
        D3D12_DESCRIPTOR_HEAP_TYPE_CBV_SRV_UAV);
    for (int i = 0; i < 2; ++i) {
        D3D12_SHADER_RESOURCE_VIEW_DESC srv = {};
        srv.Shader4ComponentMapping = D3D12_DEFAULT_SHADER_4_COMPONENT_MAPPING;
        srv.ViewDimension = D3D12_SRV_DIMENSION_TEXTURE2D;
        srv.Texture2D.MipLevels = 1;
        srv.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
        m_dev->CreateShaderResourceView(m_tex[i].Get(), &srv,
                                        {cpu0.ptr + (SIZE_T)i * inc});
    }
    D3D12_UNORDERED_ACCESS_VIEW_DESC uav = {};
    uav.ViewDimension = D3D12_UAV_DIMENSION_TEXTURE2D;
    uav.Format = DXGI_FORMAT_R16G16_SINT;
    m_dev->CreateUnorderedAccessView(m_gridTex.Get(), nullptr, &uav,
                                     {cpu0.ptr + 2 * (SIZE_T)inc});

    m_ok = true;
    return true;
}

bool GpuFlow::feed(const uint8_t* curRGBA, uint8_t* outGrid) {
    if (!m_ok) return false;
    const UINT rowBytes = m_w * 4;
    const UINT pitch = alignPitch(rowBytes);

    // --- staging upload buffer (grows once, reused every frame) ---
    const UINT64 uploadBytes = (UINT64)pitch * m_h;
    if (!m_upload || m_uploadCap < uploadBytes) {
        D3D12_HEAP_PROPERTIES hp = {};
        hp.Type = D3D12_HEAP_TYPE_UPLOAD;
        D3D12_RESOURCE_DESC bd = {};
        bd.Dimension = D3D12_RESOURCE_DIMENSION_BUFFER;
        bd.Width = uploadBytes;
        bd.Height = 1;
        bd.DepthOrArraySize = 1;
        bd.MipLevels = 1;
        bd.Format = DXGI_FORMAT_UNKNOWN;
        bd.SampleDesc.Count = 1;
        bd.Layout = D3D12_TEXTURE_LAYOUT_ROW_MAJOR;
        if (FAILED(m_dev->CreateCommittedResource(&hp, D3D12_HEAP_FLAG_NONE, &bd,
                                                  D3D12_RESOURCE_STATE_GENERIC_READ, nullptr,
                                                  IID_PPV_ARGS(&m_upload)))) {
            m_err = "flow: upload buffer alloc failed";
            return false;
        }
        m_uploadCap = uploadBytes;
    }
    void* mapped = nullptr;
    D3D12_RANGE noRead = {0, 0};
    if (FAILED(m_upload->Map(0, &noRead, &mapped))) {
        m_err = "flow: upload map failed";
        return false;
    }
    for (uint32_t y = 0; y < m_h; ++y) {
        memcpy((uint8_t*)mapped + (UINT64)y * pitch, curRGBA + (UINT64)y * rowBytes, rowBytes);
    }
    m_upload->Unmap(0, nullptr);

    // --- readback buffer for the sparse grid ---
    const UINT gridRowBytes = m_gridW * 4;
    const UINT gridPitch = alignPitch(gridRowBytes);
    const UINT64 readbackBytes = (UINT64)gridPitch * m_gridH;
    if (!m_readback || m_readbackCap < readbackBytes) {
        D3D12_HEAP_PROPERTIES hp = {};
        hp.Type = D3D12_HEAP_TYPE_READBACK;
        D3D12_RESOURCE_DESC bd = {};
        bd.Dimension = D3D12_RESOURCE_DIMENSION_BUFFER;
        bd.Width = readbackBytes;
        bd.Height = 1;
        bd.DepthOrArraySize = 1;
        bd.MipLevels = 1;
        bd.Format = DXGI_FORMAT_UNKNOWN;
        bd.SampleDesc.Count = 1;
        bd.Layout = D3D12_TEXTURE_LAYOUT_ROW_MAJOR;
        if (FAILED(m_dev->CreateCommittedResource(&hp, D3D12_HEAP_FLAG_NONE, &bd,
                                                  D3D12_RESOURCE_STATE_COPY_DEST, nullptr,
                                                  IID_PPV_ARGS(&m_readback)))) {
            m_err = "flow: readback buffer alloc failed";
            return false;
        }
        m_readbackCap = readbackBytes;
    }

    ID3D12Resource* dst = m_tex[m_slot].Get();      // current frame lands here
    ID3D12Resource* src = m_tex[1 - m_slot].Get();  // previous frame (reference)

    auto copyCur = [&](ID3D12GraphicsCommandList* cmd) {
        D3D12_TEXTURE_COPY_LOCATION d = {};
        d.pResource = dst;
        d.Type = D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX;
        D3D12_TEXTURE_COPY_LOCATION s = {};
        s.pResource = m_upload.Get();
        s.Type = D3D12_TEXTURE_COPY_TYPE_PLACED_FOOTPRINT;
        s.PlacedFootprint.Offset = 0;
        s.PlacedFootprint.Footprint.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
        s.PlacedFootprint.Footprint.Width = m_w;
        s.PlacedFootprint.Footprint.Height = m_h;
        s.PlacedFootprint.Footprint.Depth = 1;
        s.PlacedFootprint.Footprint.RowPitch = pitch;
        cmd->CopyTextureRegion(&d, 0, 0, 0, &s, nullptr);
    };
    auto barrier = [&](ID3D12GraphicsCommandList* cmd, ID3D12Resource* t,
                       D3D12_RESOURCE_STATES a, D3D12_RESOURCE_STATES b) {
        D3D12_RESOURCE_BARRIER bar = {};
        bar.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
        bar.Transition.pResource = t;
        bar.Transition.StateBefore = a;
        bar.Transition.StateAfter = b;
        bar.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
        cmd->ResourceBarrier(1, &bar);
    };

    if (FAILED(m_list->Reset(m_alloc.Get(), nullptr))) {
        m_err = "flow: list reset failed";
        return false;
    }

    if (!m_havePrev) {
        // First frame: stage the image as the next reference; grid stays all-zero.
        copyCur(m_list.Get());
        if (FAILED(m_list->Close())) {
            m_err = "flow: list close failed";
            return false;
        }
        ID3D12CommandList* lists[] = {m_list.Get()};
        m_queue->ExecuteCommandLists(1, lists);
        ++m_fenceValue;
        m_queue->Signal(m_fence.Get(), m_fenceValue);
        m_fence->SetEventOnCompletion(m_fenceValue, m_fenceEvent);
        WaitForSingleObject(m_fenceEvent, INFINITE);
        m_alloc->Reset();

        memset(outGrid, 0, (size_t)m_gridW * m_gridH * 4);
        m_slot = 1 - m_slot;
        m_havePrev = true;
        return true;
    }

    // cur -> dst, dispatch (prev = src, cur = dst), grid -> readback: one GPU submission.
    barrier(m_list.Get(), dst, D3D12_RESOURCE_STATE_COMMON, D3D12_RESOURCE_STATE_COPY_DEST);
    copyCur(m_list.Get());
    barrier(m_list.Get(), dst, D3D12_RESOURCE_STATE_COPY_DEST, D3D12_RESOURCE_STATE_COMMON);
    barrier(m_list.Get(), src, D3D12_RESOURCE_STATE_COMMON,
            D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE);
    barrier(m_list.Get(), dst, D3D12_RESOURCE_STATE_COMMON,
            D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE);
    barrier(m_list.Get(), m_gridTex.Get(), D3D12_RESOURCE_STATE_COMMON,
            D3D12_RESOURCE_STATE_UNORDERED_ACCESS);

    m_list->SetPipelineState(m_pso.Get());
    m_list->SetComputeRootSignature(m_rootSig.Get());
    unsigned p[4] = {m_w, m_h, (unsigned)radiusFor(m_quality), refineFor(m_quality) ? 1u : 0u};
    m_list->SetComputeRoot32BitConstants(1, 4, p, 0);
    ID3D12DescriptorHeap* heaps[] = {m_heap.Get()};
    m_list->SetDescriptorHeaps(1, heaps);
    m_list->SetComputeRootDescriptorTable(0, m_heap->GetGPUDescriptorHandleForHeapStart());
    m_list->Dispatch((m_gridW + 7) / 8, (m_gridH + 7) / 8, 1);

    barrier(m_list.Get(), m_gridTex.Get(), D3D12_RESOURCE_STATE_UNORDERED_ACCESS,
            D3D12_RESOURCE_STATE_COPY_SOURCE);
    barrier(m_list.Get(), dst, D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE,
            D3D12_RESOURCE_STATE_COMMON);
    barrier(m_list.Get(), src, D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE,
            D3D12_RESOURCE_STATE_COMMON);
    {
        D3D12_TEXTURE_COPY_LOCATION d = {};
        d.pResource = m_readback.Get();
        d.Type = D3D12_TEXTURE_COPY_TYPE_PLACED_FOOTPRINT;
        d.PlacedFootprint.Offset = 0;
        d.PlacedFootprint.Footprint.Format = DXGI_FORMAT_R16G16_SINT;
        d.PlacedFootprint.Footprint.Width = m_gridW;
        d.PlacedFootprint.Footprint.Height = m_gridH;
        d.PlacedFootprint.Footprint.Depth = 1;
        d.PlacedFootprint.Footprint.RowPitch = gridPitch;
        D3D12_TEXTURE_COPY_LOCATION s = {};
        s.pResource = m_gridTex.Get();
        s.Type = D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX;
        m_list->CopyTextureRegion(&d, 0, 0, 0, &s, nullptr);
    }
    barrier(m_list.Get(), m_gridTex.Get(), D3D12_RESOURCE_STATE_COPY_SOURCE,
            D3D12_RESOURCE_STATE_COMMON);

    if (FAILED(m_list->Close())) {
        m_err = "flow: list close failed";
        return false;
    }
    ID3D12CommandList* lists[] = {m_list.Get()};
    m_queue->ExecuteCommandLists(1, lists);
    ++m_fenceValue;
    m_queue->Signal(m_fence.Get(), m_fenceValue);
    m_fence->SetEventOnCompletion(m_fenceValue, m_fenceEvent);
    WaitForSingleObject(m_fenceEvent, INFINITE);
    m_alloc->Reset();

    // --- unpack the grid rows ---
    void* rm = nullptr;
    D3D12_RANGE allRead = {0, (SIZE_T)readbackBytes};
    if (FAILED(m_readback->Map(0, &allRead, &rm))) {
        m_err = "flow: readback map failed";
        return false;
    }
    for (uint32_t y = 0; y < m_gridH; ++y) {
        memcpy(outGrid + (size_t)y * gridRowBytes, (uint8_t*)rm + (UINT64)y * gridPitch,
               gridRowBytes);
    }
    m_readback->Unmap(0, nullptr);

    m_slot = 1 - m_slot;
    return true;
}

// ------------------------------------------------------------------ CpuFlow

bool CpuFlow::init(uint32_t w, uint32_t h) {
    m_w = w;
    m_h = h;
    m_gridW = (w + 3) / 4;
    m_gridH = (h + 3) / 4;
    m_havePrev = false;
    try {
        m_prev.assign((size_t)w * h * 4, 0);
    } catch (...) {
        m_err = "out of memory for the previous-frame buffer";
        return false;
    }
    m_ok = true;
    return true;
}

bool CpuFlow::feed(const uint8_t* curRGBA, uint8_t* outGrid) {
    if (!m_ok) return false;
    const uint32_t W = m_w, H = m_h;
    const int R = radiusFor(m_quality);
    const bool refine = refineFor(m_quality);
    const int lo = -(R / 2), hi = R / 2;

    auto lumaAt = [&](const uint8_t* img, int x, int y) -> int {
        x = x < 0 ? 0 : (x >= (int)W ? (int)W - 1 : x);
        y = y < 0 ? 0 : (y >= (int)H ? (int)H - 1 : y);
        const uint8_t* p = img + ((size_t)y * W + x) * 4;
        return (p[0] * 77 + p[1] * 150 + p[2] * 29) >> 8;
    };

    if (!m_havePrev) {
        memcpy(m_prev.data(), curRGBA, (size_t)W * H * 4);
        memset(outGrid, 0, (size_t)m_gridW * m_gridH * 4);
        m_havePrev = true;
        return true;
    }

    // Grid-row stripes across worker threads; each stripe writes disjoint grid rows.
    unsigned nThreads = std::thread::hardware_concurrency();
    if (nThreads == 0) nThreads = 4;
    if (nThreads > 16) nThreads = 16;
    std::atomic<unsigned> nextRow{0};
    std::vector<std::thread> pool;
    for (unsigned t = 0; t < nThreads; ++t) {
        pool.emplace_back([&] {
            for (;;) {
                const unsigned gy = nextRow.fetch_add(1);
                if (gy >= m_gridH) return;
                for (uint32_t gx = 0; gx < m_gridW; ++gx) {
                    const int bx = (int)gx * 4, by = (int)gy * 4;
                    int bestSAD = INT_MAX;
                    int bx0 = 0, by0 = 0;
                    for (int dy = lo; dy <= hi; ++dy) {
                        for (int dx = lo; dx <= hi; ++dx) {
                            int sad = 0;
                            for (int j = 0; j < 4; ++j) {
                                for (int i = 0; i < 4; ++i) {
                                    const int a = lumaAt(curRGBA, bx + i, by + j);
                                    const int b = lumaAt(m_prev.data(), bx + i + dx,
                                                         by + j + dy);
                                    sad += a > b ? a - b : b - a;
                                }
                            }
                            const int tie = sad * 1000 + (dx < 0 ? -dx : dx) +
                                            (dy < 0 ? -dy : dy);
                            if (tie < bestSAD) { bestSAD = tie; bx0 = dx; by0 = dy; }
                        }
                    }
                    if (refine) {
                        for (int dy = by0 - 2; dy <= by0 + 2; ++dy) {
                            for (int dx = bx0 - 2; dx <= bx0 + 2; ++dx) {
                                int sad = 0;
                                for (int j = 0; j < 4; ++j) {
                                    for (int i = 0; i < 4; ++i) {
                                        const int a = lumaAt(curRGBA, bx + i, by + j);
                                        const int b = lumaAt(m_prev.data(), bx + i + dx,
                                                             by + j + dy);
                                        sad += a > b ? a - b : b - a;
                                    }
                                }
                                const int tie = sad * 1000 + (dx < 0 ? -dx : dx) +
                                                (dy < 0 ? -dy : dy);
                                if (tie < bestSAD) { bestSAD = tie; bx0 = dx; by0 = dy; }
                            }
                        }
                    }
                    // S10.5 encoding: raw vector * 32, little-endian int16 pairs.
                    uint8_t* cell = outGrid + ((size_t)gy * m_gridW + gx) * 4;
                    const int16_t vx = (int16_t)(bx0 * 32);
                    const int16_t vy = (int16_t)(by0 * 32);
                    memcpy(cell, &vx, 2);
                    memcpy(cell + 2, &vy, 2);
                }
            }
        });
    }
    for (auto& th : pool) th.join();

    memcpy(m_prev.data(), curRGBA, (size_t)W * H * 4);
    return true;
}
