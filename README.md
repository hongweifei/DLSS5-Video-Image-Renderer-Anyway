用 NVIDIA DLSS 5 Neural Renderer（DLSS NR）神经网络对**视频与图片做逐帧画质增强**的本地工具。
纯本地运算，不上传任何数据；浏览器操作界面，无需安装。

> 当前版本 **v2.0-anyway**。`-anyway` 是这个分支的标记：把原本只在 NVIDIA NGX 上跑的
> DLSS NR，改造成在 AMD / Intel / 核显 / CPU 上同样能出神经增强结果的版本。

**硬件支持**：管线（解码 → 光流 → 渲染 → 编码）可在**任意 D3D12 显卡**（AMD / Intel /
NVIDIA）上运行，无独显时自动回退到 WARP 软渲染与 CPU 光流。

**神经增强在所有硬件上都能用**：

| 硬件 | 神经增强后端 | 说明 |
|---|---|---|
| NVIDIA 显卡 | **NGX 原生**（`nvngx_dlssnr.dll`） | 原版路径，硬件光流 NV-OF + Tensor Core，最快 |
| AMD / Intel / 核显 | **DLSS5 ONNX 重建**（WebGPU 优先） | 社区从官方 DLL 提取真实权重重建的 71 块网络，数值经 PyTorch 验证 |
| 无独显 / 虚拟机 | 同上（自动回退到 CPU） | 可用但慢，适合离线批处理 |

ONNX 后端按 **WebGPU → DirectML → CPU** 顺序自动选择首个能编译该图的执行提供者：

- **WebGPU**（推荐）：经 Dawn 分发到 D3D12 / Vulkan / Metal，**跨厂商，且能编译这张含动态
  Shape/Gather 注意力掩码的大图**——实测 11144 个节点**全部在 GPU 上执行、零 CPU 回退**。
  需要插件 EP（`runtime/webgpu/` 下的 `onnxruntime_providers_webgpu.dll` +
  `dxcompiler.dll` + `dxil.dll`）与 ONNX Runtime ≥ 1.24.4。
- **DirectML**：能编译时很快，但部分驱动（如 Intel Iris Xe）会以 `E_INVALIDARG` 拒绝此图。
- **CPU**：永远可用的兜底，自动多会话并行（每会话 8 线程，实测 0.87 tiles/s）。

> 注：WebGPU 后端在同一进程内**只能单会话串行**使用（并发会崩溃），故 GPU 路径不做 tile 并行。

还原本神经网络的 ONNX 权重来自开源项目 **taowen/dlss5-onnx**（从 `nvngx_dlssnr.dll` 的
`WEIGHTS_HT2` 资源段提取，非 NVIDIA 官方发布，仅供研究）。网络为**静态单帧**模式：
逐帧独立、无时域反馈，固定 256×256 分块推理。NVENC 硬编码在无 N 卡时自动回退
libx264/libx265；运动矢量只在 N 卡原生路径下消耗，其他后端自动跳过以省时间。

> ⚖️ **许可提示**：ONNX 权重源自 NVIDIA 专有模型，请自行确认合规性；仅供个人研究，勿商用。

> 🤖 **关于本软件**：这是 **Vibe Coding（对话式 AI 辅助开发）** 的产物——界面、引擎与视频处理
> 流程均由 AI 在人类引导下编写、评审与反复调优完成，人类负责需求定义、效果测试与发布决策。
> 欢迎 fork 与改进。


> **使用提示**：源码仓库不含模型等二进制大文件（GitHub 单文件 100MB 限制）。
> 完整发行版已打包在 **GitHub Releases**（含引擎、界面、模型、深度运行库与内置运行时），
> 下载解压即可用，无需安装/改名。详见下文「快速开始」。

---
<img width="1539" height="1227" alt="图片" src="https://github.com/user-attachments/assets/2c5ef11f-6580-4cf8-9f15-68d230eac514" />



## 快速开始

### 路线 A：普通用户（免编译，推荐）

1. 打开本仓库 **Releases** 页面，下载最新版 **完整发行包**（如 `DLSS5NR_v2.0-anyway.zip`）；
2. 解压到任意目录（路径含中文也没问题）；
3. 双击 **（点击启动）Start_DLSS5NR.bat**；
4. 浏览器自动打开操作界面（默认 http://127.0.0.1:8777；若该端口被占用或被系统保留，
   服务会自动改用下一个可用端口，**实际地址以黑色命令行窗口打印的为准**）；
5. 拖入/选择视频或图片 → 调参数 → 点「开始处理」/「渲染此图」；
6. 用完直接关闭黑色命令行窗口：服务停止，同时自动清理临时缓存。

> 端口打不开时：启用过 WSL/Hyper-V 的 Windows 会保留整段动态端口（如 8729-8828 覆盖了
> 默认的 8777），服务会自动跳到可用端口。可用 `netsh interface ipv4 show excludedportrange
> protocol=tcp` 查看保留段，或 `set PORT=8888` 指定端口。

完整发行包已内置：处理引擎、NR 模型、深度运行库、网页界面、便携 node/ffmpeg，解压即用。

### 路线 B：源码构建（开发者）

```powershell
# 1) 编译引擎（推荐用 PowerShell 脚本，自动探测 VS/MSVC/SDK 版本）
powershell -File src\build.ps1               # 产物 build\dlss5nr_engine.exe
powershell -File src\build.ps1 -Guard        # 同时编译 server_guard.exe
#    可选：-Clean 清理旧产物；-MsvcVer / -SdkVer / -VsRoot 手动指定工具链

# 2) 准备模型与运行库（源码仓库不含二进制大文件，全部被 .gitignore 排除）
#    models/           NGX 模型 + 转发器（N 卡原生路径）
#    models/onnx/      非 N 卡用的 ONNX 重建模型（.onnx 权重）
#    runtime/          onnxruntime.dll + DirectML.dll + webgpu/ 插件（ONNX 后端运行库）
#    tools/            便携 node/ffmpeg/ffprobe
#    这些都在 Releases 发行包里，解压覆盖到源码根目录即可

# 3) 启动界面
start_ui.bat
```

也可以从 Git-Bash 构建：`cd src && bash build.sh`（脚本会在 WSL / Git-Bash / 原生
shell 下自动转换路径）。**注意**：若 `bash` 指向 WSL 且未开启 interop，Windows 的
`cl.exe` 无法执行，脚本会提示改用 `build.ps1`。

运行时依赖：`ffmpeg`/`ffprobe` 与 `node`。源码构建时可用 `tools/` 里的便携版
（`start_ui.bat` 会自动把 `tools\` 加入 PATH），或自行安装到系统 PATH。

### 打包发布

发行包是「引擎 + 二进制 payload + 界面」按下面的布局压缩。注意源码目录（`src/`、`build/`）
**不进发行包**——发行包把引擎放在根目录，直接双击即用：

```
DLSS5NR_vX.Y/
  dlss5nr_engine.exe              # src/build.ps1 的产物（build\ 里取出）
  runtime/onnxruntime.dll         # ONNX 后端运行库（单一副本）
  runtime/DirectML.dll
  runtime/webgpu/{onnxruntime_providers_webgpu,dxcompiler,dxil}.dll
  models/                         # NGX 模型 + 转发器（fp16/fp8）
  models/onnx/                    # ONNX 重建模型（.onnx 权重）
  web/                            # 界面：index.html + css/ + js/ + server.js + server/（必须整目录打包）
  tools/{node,ffmpeg,ffprobe}.exe # 便携运行时
  server_guard.exe                # 可选：关窗自动清理临时缓存
  Start_DLSS5NR.bat               # 双击启动（= start_ui.bat）
  start_ui.bat
```

打包检查清单：

1. `powershell -File src\build.ps1 -Clean -Guard` 得到干净的引擎与守护程序；
2. 确认二进制 payload 齐全：`models/`、`models/onnx/`、`runtime/`（含 `webgpu/`）、`tools/`；
3. `server_guard.exe` 由 `src\build.ps1 -Guard` 一并产出（`/MT` 静态 CRT，无 VC 运行库依赖）；
   `cl src\guard\server_guard.c /O1 /MT /W3 /nologo /Fe:server_guard.exe` 亦可；
4. **不要**把 `src/`、`build/`、`outputs/`、`.tmp_uploads/`、`.frame_previews/`、`*.log`
   打进包——发行包不需要源码与构建产物；
5. `web/` 必须**整目录**打包（`index.html` + `css/` + `js/` + `server.js` + `server/`）；
   改动后先跑校验：`node tools/verify-web.js .`、`node tools/verify-static.js .`、
   `node tools/verify-server.js`（漏掉 `server/` 服务会直接启动失败）；
6. 解压到**含中文或空格的路径**下试运行一次，确认启动与渲染正常。

`.gitignore` 已把 `build/`、`models/`、`runtime/`、`tools/`、`outputs/`、`example/` 排除，
仓库只存源码。

### Releases 资产说明

| 资产 | 内容 | 适用 |
|---|---|---|
| 完整发行包 `DLSS5NR_v2.0-anyway.zip` | 引擎 + 界面 + NR 模型(fp16/fp8) + ONNX 重建模型 + 运行库 + 便携 node/ffmpeg + 启动脚本 | 所有用户：解压 → 双击启动 → 浏览器操作 |

包内 `models/` 放 NR 模型与配套转发器（`nvngx_dlssnr_fp16.dll` / `nvngx_dlssnr_fp8.dll` +
`nvngx.dll_dlssnr_fp16.dll` / `nvngx.dll_dlssnr_fp8.dll`，**文件名勿改**）；
`models/onnx/` 放 ONNX 重建模型；`runtime/` 放 ONNX 后端运行库与其 `webgpu/` 插件。

---

## 目录结构

```
src/                        C++ 引擎源码 + 构建脚本 + 第三方头文件
  main.cpp                  编排层：渲染主循环 runJob + daemon 模式
  cli.*                     命令行：参数解析、用法文本、编码器策略（别名/NVENC 降级）
  paths.*                   资源布局解析（模型/运行库/便携工具的查找与旧布局兼容）
  util.h                    UTF-8<->UTF-16 转换、路径绝对化、像素小工具（共享）
  finalize.*                模型输出 → 编码器像素格式（Bayer 抖动 / 16-bit）
  d3d12_ctx.*               渲染上下文、纹理上传/回读、WARP 软渲染兜底
  dlssnr.* / ngx_params.*   NGX DLSS NR feature 加载与参数块构造
  nvof_flow.*               NVIDIA 硬件光流(NV-OF, D3D11) → 稀疏网格
  flow.*                    通用光流：D3D12 计算着色器（任意显卡/WARP）+ CPU 块匹配兜底
  onnx_nr.*                 DLSS5 ONNX 重建后端（WebGPU → DirectML → CPU 分块推理）
  densify_pass.* / blend_pass.*  稀疏网格致密化 / GPU 残差混合 + 抖动降位
  depth_anything.*          深度推理（可选）
  video_pipe.*              ffmpeg 解码/编码子进程封装
  meta_io.*                 渲染参数内嵌（mp4 comment / PNG tEXt / JPG COM）
  build.sh / build.ps1      MSVC 构建脚本（自动探测工具链；自动收集 *.cpp；输出到 build/）
  guard/server_guard.c      启动守护源码（关窗即清临时缓存）
  third_party/nvof/         NVIDIA NV-OF 头文件（上游，宽松许可）
  third_party/onnxruntime/  ONNX Runtime C API 头文件（上游，MIT）
build/                      构建产物（.obj + .exe，由 src/build.ps1 生成）
runtime/                    ONNX 后端运行库：onnxruntime.dll + DirectML.dll + webgpu/ 插件
models/                     NR 模型与转发器（N 卡路径）
models/onnx/                ONNX 重建模型权重（非 N 卡路径）
tools/                      便携 node/ffmpeg/ffprobe
web/                        浏览器界面 + 本地服务（node，无第三方依赖、无构建步骤）
  index.html                页面外壳：顶部模式切换 + 左参数栏 + 底部操作栏 + 浮层（约 500 行）
  css/tokens.css            设计令牌唯一来源：浅色 :root / 深色 [data-theme="dark"]
  css/app.css               布局与组件（头部/标签页/参数栏/卡片/控件/进度/队列/底栏）
  css/overlays.css          脱离文档流的层：对比视图、图片放大、日志抽屉、提示条、拖放层、确认框
  js/app-shell.js           交互外壳：主题、模式切换、提示条、忙碌态、统一键盘、拖放、底栏
  js/overlays-compare.js    视频对比播放器（自包含 IIFE，向 app-shell 暴露 setZoom/setSplit）
  js/app-core.js            基础：DOM 助手、滑杆绑定、输入视频载入、拖入文件的接收
  js/app-status.js          日志面板、状态轮询、任务提交与取消、任务配置构建
  js/app-range.js           时间范围与「渲染当前帧并对比」（单帧渲染的总互斥标志也在这里）
  js/app-image.js           图片渲染、图片批量渲染与对比视图
  js/app-video-batch.js     视频批量渲染与显卡列表加载
  js/app-params.js          参数持久化、渲染参数恢复、撤销/重做、命名预设

  前端约定（改动前请先读）：
    · 8 个 js 文件用 <script src> 顺序加载、**共享同一个全局作用域**（不是 ES module）。
      顶层用 const/let 声明重名会直接 SyntaxError；新增模块请包在 IIFE 里，
      只把需要的接口挂到 window（app-shell.js 就是这么做的）。
    · DOM 契约：JS 通过 id 取元素，index.html 必须保留这些 id。
      `node tools/verify-web.js .` 会逐个核对（当前 115 个引用）。
    · 主题色只能在 tokens.css 里定义，组件只引用 var(--…)。未定义的自定义属性会让
      整条声明失效，效果是"样式静默消失"，`tools/audit-css-tokens.js` 专门盯这个。
    · 全局键盘只有一个入口（app-shell.js，采集阶段 + 明确优先级）。不要再往
      document 上挂 keydown，否则会重新出现"按 Esc 关弹层的同时把渲染也停了"。

  server.js                 本地服务入口：端口选择/绑定、空闲清理（约 120 行）
  server/                   服务端模块（CommonJS，无第三方依赖、无构建步骤）
    paths.js                全部磁盘位置解析（WEB_DIR/ROOT/models/outputs/临时目录）+ 输出路径
    state.js                渲染队列的共享可变状态（当前任务/队列/lastDone/uiLastPoll）
    http.js                 JSON 响应、请求体解析、两个 MIME 映射
    tempfiles.js            可丢弃的上传与帧缓存目录：分类、清扫、按类型清理
    engine.js               引擎定位、模型配对、任务配置 -> argv、单次运行与看门狗
    media.js                ffmpeg/ffprobe 封装（探测、时长、尺寸、转码）
    export.js               成品转码导出（编码器预设 + 进度状态）
    meta.js                 渲染参数内嵌/读取（mp4 comment / PNG tEXt / JPG COM）
    dialog.js               Windows 原生文件对话框 + 打开浏览器
    jobs.js                 渲染队列状态机：入队/多趟/进度/取消/让位
    batch.js                图片批量渲染 + 文件夹遍历 + 单帧渲染原语
    routes/index.js         路由表（"METHOD path" -> handler）+ 静态资源兜底
    routes/status.js        /api/status、/api/info
    routes/job.js           队列控制：start / queue-* / cancel / exit / video-batch
    routes/picker.js        原生对话框路由（选文件/选文件夹/保存）
    routes/render.js        单帧与单图渲染、frame-img、read-meta
    routes/media.js         字节流与探测：video / download / image / gpus / probe
    routes/batch.js         /api/image-batch*
    routes/export.js        /api/export 与 /api/upload
    routes/static.js        静态资源兜底 + 目录穿越守卫（用 WEB_DIR，不是 __dirname）
tools/                      便携 node/ffmpeg/ffprobe + 校验脚本（本目录不入库，见 .gitignore）
  verify-web.js             校验：前端 JS 语法、全局作用域无重复声明、JS 引用的 id 都存在
  verify-static.js          校验：静态资源路径与 MIME（复现 routes/static.js 的解析逻辑）
  audit-css-tokens.js       校验：所有 var(--x) 都有定义
  verify-server.js          校验：服务端语法、29 个路由、原声明清点、共享状态引用方式
  verify-live.js            校验：起服务后页面与全部资源 200、字节与磁盘一致、接口字段齐全
  audit-html.js             校验：重复属性/重复 id、CSS 里混入 HTML 标签、alt/按钮名/表单标签
  audit-theme.js            校验：两套主题令牌一致 + 全部前景/背景组合的 WCAG AA 对比度
  server-probe.js           校验：真实 HTTP 打全部路由（`--render` 含真实 ONNX 推理）
  server-queue-test.js      校验：队列端到端（排队/重排/取消让位/多趟/日志协议/导出/批量）
  make-test-media.js        生成上面两个脚本用的 320x240 测试素材
start_ui.bat                启动脚本（双击运行）
```

> **前端改完请跑这几条**（都在项目根执行，`tools/` 不入库，克隆后需自行准备）：
>
> ```bash
> node tools/verify-web.js .          # JS 语法 + 全局作用域 + 115 个 id 的 DOM 契约
> node tools/verify-static.js .       # 静态资源路径与 MIME
> node tools/audit-html.js            # 重复属性/id、CSS 混入 HTML、可访问性
> node tools/audit-theme.js           # 主题令牌一致性 + WCAG AA 对比度
> node tools/audit-css-tokens.js .    # 所有 var(--x) 都有定义
> # 起服务后再跑：
> node tools/verify-live.js http://127.0.0.1:9788
> ```
>
> `audit-html.js` 与 `audit-theme.js` 这两条不是走过场：它们对应的正是本项目实际踩过的坑
> —— 同一元素写两个 `class`（第二个被浏览器忽略，`input-compact` / `mt-10` / `btn-xs`
> 全都没生效）、CSS 里混进 `<style>` 标签（导致紧跟其后的整条规则被丢弃，`.vd-zoom`、
> `.vcompare`、`#exitWrap` 三条定义静默失效）、未定义的自定义属性（5 条分隔线消失）。
> 这些在浏览器里都不会报错，只能靠机器检查。

> **布局说明**：`src/build.ps1` 把产物写进 `build/`；引擎按**可执行文件所在目录**向上
> 探测 `models/`、`runtime/`、`tools/`，因此开发者（exe 在 `build/`）与发行包（exe 在根）
> 两种布局都能直接工作。旧版把运行库放在 `core/depth/`、插件放在 `models/onnx/webgpu/`
> 的发行包**仍然兼容**（`src/paths.cpp` 会依次探测）。

## 构建（Windows）

要求：**Visual Studio 2022**（含「使用 C++ 的桌面开发」工作负载，x64 `cl.exe`）+
**Windows 10/11 SDK**。工具链版本由脚本自动探测，无需手改路径。

```powershell
# 推荐：原生 PowerShell（Windows 下最省事）
powershell -File src\build.ps1
powershell -File src\build.ps1 -Clean        # 先清理旧产物
powershell -File src\build.ps1 -Guard        # 同时编译 server_guard.exe
```

```bash
# 备选：Git-Bash / MSYS2
cd src && bash build.sh
GUARD=1 bash build.sh      # 同时编译守护程序

# 备选：手动指定工具链（自动探测失败时）
#   PowerShell: -VsRoot / -MsvcVer / -SdkVer
#   bash:       VSROOT=... MSVCVER=... SDKVER=... bash build.sh
```

脚本会打印实际使用的 VS / MSVC / SDK 版本；产物为 `build/dlss5nr_engine.exe`
（发行时把它放到包根目录即可，引擎会自动向上探测 `models/`、`runtime/`、`tools/`）。

引擎通过 ffmpeg 子进程编解码，运行期需要 `ffmpeg`/`ffprobe` 与 `node`：
`start_ui.bat` 会优先使用 `tools\` 里的便携版并自动加入 PATH。

`server_guard.exe`（可选，负责关窗时清理临时缓存）用 `/MT` 静态 CRT 编译，以免依赖
VC 运行库；由 `src\build.ps1 -Guard` 自动产出，也可手动：

```bash
cl src\guard\server_guard.c /O1 /MT /W3 /nologo /Fe:server_guard.exe
```

> `server_guard.c` 含中文字符串，文件为 **UTF-16LE（带 BOM）**。用编辑器改动时请保持该
> 编码，否则 MSVC 会报 `C2001: newline in constant`。

## 命令行参数

```bash
build/dlss5nr_engine.exe --input in.mp4 --output out.mp4 \
  --encoder h264_nvenc --residual-mult 1.0 --frame-guidance 3 \
  --end-time 5 --perf
```

常用：`--input --output --encoder --codec-args --pix-fmt --start-time --end-time
--preset --intensity --style --local-tone --local-structure --skin-structure
--auto-mask --ui-correction --residual-mult --frame-guidance --depth-interval
--dump-frame --frame-reset --hw-decode --gpu-idx --list-gpus --warp --onnx-nr --onnx-model`。
完整列表见 `--help`。

### 神经增强后端与自动选择

引擎启动时按硬件自动选择后端，无需手动配置：

| 硬件 | 神经增强 | 光流 (运动矢量) | 编码 |
|---|---|---|---|
| NVIDIA 显卡 | ✅ NGX 原生（最快） | ✅ NV-OF 硬件光流 | NVENC 硬编 |
| AMD / Intel 显卡 | ✅ DLSS5 ONNX 重建（WebGPU 优先） | 自动跳过（ONNX 模型不消耗） | libx264/libx265（自动回退） |
| 无独显 / 虚拟机 | ✅ DLSS5 ONNX 重建（回退 CPU） | 自动跳过 | libx264/libx265 |

手动控制：

- `--onnx-nr` 强制使用 ONNX 重建后端（即使在 N 卡上，可用来对比效果）
- `--onnx-model <path>` 指定 .onnx 模型（默认探测 `models/onnx/dlss5_real_static_256_fp16.onnx`）
- `--frame-guidance`：`0` 无运动矢量；`3` NVIDIA 硬件光流（非 N 卡自动降级到 `4`）；
  `4` 通用光流（D3D12 计算着色器，任意显卡可用，含 WARP；无 D3D12 时回退 CPU 块匹配）
- `--warp` 强制 WARP 软渲染；`--gpu-idx` / `--list-gpus` 选择渲染显卡

### 部署 ONNX 后端（非 N 卡用户）

需要两组文件（引擎自动探测）：

**1) 模型权重** → `models/onnx/`

- `dlss5_real_static_256_fp16.onnx` — 约 301 MB，从
  [taowen/dlss5-onnx](https://huggingface.co/taowen/dlss5-onnx) 下载

**2) 原生运行库** → `runtime/`

- `onnxruntime.dll` — **ONNX Runtime ≥ 1.24.4**
- `DirectML.dll` — DirectML 兜底路径用（可用系统 `C:\Windows\System32\DirectML.dll`）
- `webgpu/` 子目录 — **WebGPU 插件 EP**（推荐）：`onnxruntime_providers_webgpu.dll` +
  `dxcompiler.dll` + `dxil.dll`，来自 NuGet 包 `Microsoft.ML.OnnxRuntime.EP.WebGpu`

缺失时会逐级降级（无 WebGPU → DirectML → CPU → 无模型直通），并在日志中说明原因。
运行库与 WebGPU 插件**只需一份**放在 `runtime/`；旧发行包把它们分散在 `core/depth/` 与
`models/onnx/webgpu/` 也能被自动探测到。

**性能参考**（720p / 每帧 15 个 256×256 分块 / Intel Iris Xe 笔记本，16 线程）：

| 后端 | 每帧 | 说明 |
|---|---|---|
| WebGPU | **23.9 s** | 全 GPU 执行，零 CPU 回退 |
| CPU 并行池 | 32.7 s | 2 会话 × 8 线程 |
| CPU 单会话 | 95 s | 未优化基线 |

DirectML 在这台机器上**拒绝编译该图**（`E_INVALIDARG`），故未计入；能编译的显卡上会更快。
这是静态单帧模型，**适合图片渲染与短视频**；长视频建议在 N 卡上用 NGX 原生路径。

---

## 许可与致谢

本项目源码以 **GPL-3.0** 发布（见 `LICENSE`）。DLSSNR 的接入方式与参数方案参考了以下
开源项目，特此致谢：

- **Magpie** 的 DLSSNR 实验支持：开源 fork **SAOG0721/Magpie** 的 **`experimental` 分支**
  （https://github.com/SAOG0721/Magpie ，GPL-3.0；上游为 Blinue/Magpie）；
- **OptiScaler** 社区的 DLSSNR 支持实现（本工具早期调试所用的转发器 `nvngx.dll_dlssnr*.dll`
  源于其社区构建）。
- **taowen/dlss5-onnx**：非 N 卡神经增强后端所用的 ONNX 网络重建与权重提取工具
  （https://huggingface.co/taowen/dlss5-onnx ）；权重源自 NVIDIA `nvngx_dlssnr.dll`，
  该项目自述为研究性重建，非 NVIDIA 官方发布。
- **ONNX Runtime WebGPU 插件 EP**（`Microsoft.ML.OnnxRuntime.EP.WebGpu`，MIT 许可）与
  **Google Dawn**：非 N 卡 GPU 推理路径所依赖的跨厂商执行提供者（经 D3D12/Vulkan/Metal）。

界面、引擎与视频处理流程为本项目独立编写。

- `src/third_party/nvof/` 头文件：Copyright (c) 2018-2023 NVIDIA Corporation，宽松许可（见文件头）。
- `src/third_party/onnxruntime/`：ONNX Runtime 项目头文件，MIT 许可。
- **Releases 中的模型与转发器为社区/原作者作品**，打包发布前请自行确认其许可与
  NVIDIA 软件许可条款允许；请勿用于商业用途。
- **ONNX 权重（`models/onnx/*.onnx`）源自 NVIDIA 专有模型**，本仓库不附带、需用户自行
  从上游获取；其许可与合规性由使用者自行确认，仅供个人研究。

> 再分发或商用前，请自行完成对第三方组件的许可与合规核查。
