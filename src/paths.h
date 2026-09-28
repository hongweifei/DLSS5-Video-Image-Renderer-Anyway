#pragma once

// Asset layout resolution: where the engine finds models, the native runtime and the bundled
// portable tools.
//
// The engine is shipped in two shapes and both must work without configuration:
//
//   Source checkout (developer)          Release package (user)
//   ---------------------------          --------------------
//   build/dlss5nr_engine.exe            dlss5nr_engine.exe        (package root)
//   src/                                (sources, not shipped)
//   runtime/{onnxruntime,DirectML}.dll  runtime/...               (same)
//   runtime/webgpu/*.dll                runtime/webgpu/*.dll      (same)
//   models/{ngx dlls}                   models/...                (same)
//   models/onnx/*.onnx                  models/onnx/*.onnx        (same)
//   tools/{ffmpeg,node}.exe             tools/...                 (same)
//
// Layouts predating the src/ + runtime/ split are still probed (core/depth/, core/ next to the
// exe) so an older release package keeps working with a newer engine binary.
//
// All paths are resolved relative to the EXECUTABLE, not the working directory: a user can
// launch the package from any cwd (a shortcut, the terminal, the web UI) and still get the
// right files.

#include <string>
#include <vector>

namespace dlss5nr {

// Directory holding the running executable (no trailing separator).
std::string exeDir();

// Project/deployment root: the exe's directory, or its parent when the exe sits in build/.
// This is where models/, runtime/ and tools/ are expected.
std::string rootDir();

// Candidate directories that may hold onnxruntime.dll + DirectML.dll, best first. Covers the
// new runtime/ layout and the legacy core/depth/ one.
std::vector<std::string> runtimeDirCandidates();

// First existing directory from runtimeDirCandidates(), or "" when none exists.
std::string findRuntimeDir();

// First existing file among `relativePaths` (checked once against rootDir and once against the
// executable directory, so both the source and package layouts resolve). Returns "" if none.
std::string findAsset(const std::vector<std::string>& relativePaths);

// Directories that may hold the NGX model dlls + forwarder, best first.
std::vector<std::string> modelDirCandidates();

// First existing directory from modelDirCandidates(), or "".
std::string findModelDir();

// Directory holding the bundled portable tools (ffmpeg/ffprobe/node), or "" when absent.
std::string findToolsDir();

}  // namespace dlss5nr
