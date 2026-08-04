# Cove Image Upscaler

Desktop app for Windows x64 and Linux x64 that upscales photos and anime
images with AI, powered by [NCNN](https://github.com/Tencent/ncnn) + Vulkan,
plus a Pixel mode that enlarges pixel art with exact nearest-neighbor
scaling. No Python, no CUDA, no cloud - runs fully offline.

One codebase, four artifacts: a Windows installer + portable exe, and a
Linux AppImage + .deb. Every `v*` tag cuts all four via GitHub Actions.

![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)
![Platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20Linux-informational?style=flat-square)
[![Release](https://img.shields.io/github/v/release/Sin213/cove-image-upscaler?style=flat-square&color=5eead4)](https://github.com/Sin213/cove-image-upscaler/releases/latest)

![Cove Image Upscaler - main window](docs/screenshots/main.png)

---

## What it does

- **Photo mode** - AI upscaling with the bundled Real-ESRGAN ncnn-Vulkan
  payload, at ×2 / ×3 / ×4. Photo non-4× runs the model at native ×4 and
  downscales locally to avoid the tile-stitch artifacts the binary produces
  with x4-only models at lower scales.
- **Anime mode** - AI upscaling with the bundled Real-CUGAN ncnn-Vulkan
  payload, at ×2 / ×3 / ×4. Scale-aware denoise level (×2 uses the balanced
  denoise2x model; ×3 / ×4 use no-denoise to preserve line detail).
- **Pixel mode** - exact nearest-neighbor scaling at ×2 / ×3 / ×4 / ×5 / ×6 /
  ×8, for pixel art and any image whose hard edges must stay unchanged. It
  runs locally in-process: no NCNN/Vulkan executable, no AI enhancement, no
  denoise or sharpening. Each source pixel becomes an exact block of
  identical pixels.
- **Queue + drag-drop** - drop files or whole folders any time, even after
  the queue is non-empty. Reorder pending entries by dragging. Click a row
  to select; press <kbd>Delete</kbd> to remove. Per-row cancel × on running
  jobs, refresh ↻ to re-run with current settings.
- **Compare modal** - full-screen before / after with a draggable divider,
  arrow-key nudge, dimension transition, reveal-in-folder.

  ![Compare modal - Frieren ×4 anime](docs/screenshots/compare.png)

- **Activity log** - collapsible panel below the queue. Color-coded events
  for every state transition. Friendly translations for common NCNN failures
  (out-of-memory, model mismatch, missing Vulkan, decode errors).
- **Vulkan GPU acceleration** for Photo and Anime - AMD, NVIDIA, Intel.
- **Light + dark** themes; remembers your choice. Window position persisted.
- **No cloud** - your images never leave the machine.

### Modes, scales, inputs, outputs

| Mode  | Engine                                   | Scales                     |
| ----- | ---------------------------------------- | -------------------------- |
| Photo | Real-ESRGAN ncnn-Vulkan (bundled)        | ×2 ×3 ×4                   |
| Anime | Real-CUGAN ncnn-Vulkan (bundled)         | ×2 ×3 ×4                   |
| Pixel | exact nearest-neighbor, no AI, in-app    | ×2 ×3 ×4 ×5 ×6 ×8          |

The selected scale is remembered per mode, so switching modes restores that
mode's last scale rather than carrying one over.

**Input formats** - the file picker and drag-drop validation accept `PNG`,
`JPG` / `JPEG`, and `WebP`.

**Output** - always PNG, written next to the input (or to the chosen output
folder) as:

```
<base>_<scale>x_<mode>.png
```

If that name is taken, a numeric suffix is added instead of overwriting:
`<base>_<scale>x_<mode> (1).png`.

**Queue** - `Upscale N` processes the currently eligible queue entries.
Completed jobs are not reprocessed by it; failed and cancelled jobs stay
retryable.

---

## Install a prebuilt release

Head to the [Releases page](https://github.com/Sin213/cove-image-upscaler/releases):

| OS      | Artifact                                            | Notes                                              |
| ------- | --------------------------------------------------- | -------------------------------------------------- |
| Windows | `Cove-Image-Upscaler-<version>-Setup.exe`           | NSIS installer (Start Menu + Desktop shortcut)     |
| Windows | `Cove-Image-Upscaler-<version>-Portable.exe`        | Single-file portable, no install                   |
| Linux   | `Cove-Image-Upscaler-<version>-x86_64.AppImage`     | `chmod +x` and run - needs `libfuse2`              |
| Linux   | `Cove-Image-Upscaler-<version>-amd64.deb`           | `sudo apt install ./Cove-Image-Upscaler-*.deb`     |

Releases are x64 only, for both Windows and Linux. NCNN Vulkan binaries and
models are fetched at build time and bundled, so every release ships
self-contained.

### Verifying downloads

Every published asset carries its own `<asset-name>.sha256` sidecar, including
the auto-update metadata (`latest.yml`, `latest-linux.yml`) and any
`.blockmap`. Download the sidecar next to the file and check it:

```bash
# Linux / macOS shell
sha256sum -c Cove-Image-Upscaler-2.2.0-x86_64.AppImage.sha256
```

```powershell
# Windows PowerShell
$expected = ((Get-Content .\Cove-Image-Upscaler-2.2.0-Setup.exe.sha256 -Raw).Trim() -split "\s+")[0]
$actual   = (Get-FileHash -Algorithm SHA256 .\Cove-Image-Upscaler-2.2.0-Setup.exe).Hash
if ($actual -ieq $expected) { "OK" } else { "MISMATCH" }
```

### Linux runtime requirements

Photo and Anime need a Vulkan-capable GPU with a working driver, plus a
Vulkan loader/ICD supplied by your OS and GPU vendor. The app does not bundle
GPU drivers. Pixel mode does not use the AI/Vulkan executables and works
without them.

The `.deb` declares `libvulkan1` as a runtime dependency, so `apt` pulls the
loader in when you install the package. The AppImage carries no package
metadata, so the loader and drivers must already be present on the system.

### Linux AppImage troubleshooting

If the AppImage refuses to start with a FUSE error, install `fuse2`:

- Arch / EndeavourOS / Manjaro: `sudo pacman -S fuse2`
- Debian / Ubuntu / Mint: `sudo apt install libfuse2`
- Fedora: `sudo dnf install fuse`
- openSUSE: `sudo zypper install fuse`

### Windows SmartScreen

The installer and portable exe are unsigned, so Windows may warn on first
launch. Click **More info → Run anyway**.

---

## Running from source

Requires Node.js 20+ and Git, plus a Vulkan-capable GPU to exercise Photo and
Anime.

```bash
git clone https://github.com/Sin213/cove-image-upscaler.git
cd cove-image-upscaler
npm install           # also downloads NCNN Vulkan binaries for your host OS
npm run dev           # Vite + Electron with hot reload
```

`postinstall` fetches NCNN binaries + models for the host OS automatically.
On a flaky network it falls back silently; rerun with
`node scripts/download-binaries.mjs` (pass `linux`, `win`, or `--all` to
override the host default). The same fetch is wrapped by
`npm run release:payload`, `npm run release:payload:linux`, and
`npm run release:payload:win`.

---

## Building release artifacts

```bash
# Linux
npm run dist:linux         # AppImage only - fast iteration
npm run dist:linux:full    # AppImage + .deb

# Windows (works cross-platform from Linux via Wine)
npm run dist:win           # Setup.exe + Portable.exe
npm run dist:win:portable  # Portable.exe only - fast iteration
```

Each `dist:*` script runs the matching payload fetch first, so
`resources/bin/win/` or `resources/bin/linux/` is populated with the right
executables and libraries before electron-builder runs. To fetch a payload on
its own, use `node scripts/download-binaries.mjs win` or `... linux`.

### Automated release via GitHub Actions

Push a tag matching `v*` (e.g. `v2.2.0`) and `.github/workflows/release.yml`
runs the Linux + Windows jobs in parallel and attaches all four artifacts
to the GitHub Release created for the tag. Each job runs a strict payload gate
before packaging, so a release cannot ship with a missing or truncated AI
binary, and then generates a `.sha256` sidecar for every asset it uploads.

---

## Project layout

```
cove-image-upscaler/
├── electron/                     Electron main process (TypeScript)
│   ├── main.ts                   window + IPC + frameless titlebar
│   ├── paths.ts                  cross-platform binary/model paths
│   ├── preload.ts                contextBridge API
│   ├── upscaler.ts               job queue + ncnn child process + error humanizer
│   ├── pixel.ts                  exact nearest-neighbor Pixel processing
│   └── types.ts                  shared types (re-exported from src/)
├── src/                          React renderer (Vite + Tailwind)
│   ├── App.tsx                   layout + drop overlay
│   ├── store.ts                  zustand store + persistence
│   └── components/               Titlebar, Dropzone, ImageQueue, CompareModal, LogPanel, …
├── resources/
│   ├── bin/                      NCNN binaries - populated by postinstall
│   │   ├── linux/  win/
│   ├── licenses/                 third-party notices shipped with the app
│   └── models/                   shared across platforms
├── public/cove_icon.png          renderer-served brand icon
├── scripts/download-binaries.mjs fetches NCNN binaries + models per host OS
├── cove_icon.png / cove_icon.ico window + installer icons
├── package.json                  electron-builder targets: linux + win
└── .github/workflows/release.yml
```

---

## Licensing

- Cove Image Upscaler is **MIT** - see `LICENSE`.
- Bundled [Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN) and
  [realcugan-ncnn-vulkan](https://github.com/nihui/realcugan-ncnn-vulkan)
  binaries are BSD-3-Clause / MIT. Models carry their upstream licenses.
- Third-party notices for **sharp**, the prebuilt **libvips** binaries and the
  libraries bundled inside them live in `resources/licenses/`, starting with
  `resources/licenses/THIRD_PARTY_NOTICES.txt`. Notices for the bundled AI
  components live alongside them under `resources/licenses/ai/`. Installed
  builds ship the same tree, at `<install dir>/resources/licenses/`.
