# Cove Upscaler

Cross-platform desktop app that upscales photos and anime images with AI,
powered by [NCNN](https://github.com/Tencent/ncnn) + Vulkan. No Python, no
CUDA, no cloud — runs fully offline on any Vulkan-capable GPU.

One codebase, one repository, native builds for both platforms: a Windows
installer + portable exe, and a Linux AppImage + .deb. Every `v*` tag cuts
all four artifacts via GitHub Actions.

![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)
![Platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20Linux-informational?style=flat-square)

---

## What it does

- **Photo upscaler** — Real-ESRGAN x2 / x3 / x4.
- **Anime upscaler** — Real-CUGAN x2 / x3 / x4.
- **Drag-and-drop** or click to browse. Queue multiple images. Drop a whole
  folder to enqueue every image inside.
- **Vulkan GPU acceleration** on AMD, NVIDIA, Intel, and Apple Silicon.
- **Light + dark** themes; remembers your choice.
- **No cloud** — your images never leave the machine.

---

## Install a prebuilt release

Head to the [Releases page](https://github.com/Sin213/cove-upscaler/releases):

| OS      | Artifact                                   | Notes                                              |
| ------- | ------------------------------------------ | -------------------------------------------------- |
| Windows | `Cove-Upscaler-<version>-Setup.exe`        | NSIS installer (Start Menu + Desktop shortcut)     |
| Windows | `Cove-Upscaler-<version>-Portable.exe`     | Single-file portable, no install                   |
| Linux   | `Cove-Upscaler-<version>-x86_64.AppImage`  | `chmod +x` and run — needs `libfuse2`              |
| Linux   | `cove-upscaler_<version>_amd64.deb`        | `sudo apt install ./cove-upscaler_*.deb`           |

The NCNN Vulkan binaries and models are fetched at build time in each
platform's CI job, so every release ships self-contained.

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

Requires Node.js 20+, a Vulkan-capable GPU, and Git.

```bash
git clone https://github.com/Sin213/cove-upscaler.git
cd cove-upscaler
npm install           # also downloads NCNN Vulkan binaries for your OS
npm run dev           # Vite + Electron with hot reload
```

The `postinstall` step downloads the right NCNN binaries (Linux, macOS, or
Windows) and upscaling models automatically. On a flaky network it falls back
silently; rerun with `node scripts/download-binaries.mjs`.

---

## Building release artifacts

`electron-builder` can't cross-compile native binaries, so each OS builds its
own artifacts. The GitHub Actions workflow does this for every tag.

Locally:

```bash
npm run dist:linux   # -> release/*.AppImage, release/*.deb
npm run dist:win     # -> release/Cove-Upscaler-*-Setup.exe, *-Portable.exe
npm run dist:mac     # -> release/*.dmg, *.zip  (macOS host only)
```

### Automated release via GitHub Actions

Push a tag matching `v*` (e.g. `v1.0.0`) and `.github/workflows/release.yml`
runs the Linux + Windows jobs in parallel and attaches all four artifacts to
the GitHub Release created for the tag.

---

## Project layout

```
cove-upscaler/
├── electron/                     Electron main process (TypeScript)
│   ├── main.ts                   window + IPC
│   ├── paths.ts                  cross-platform binary/model paths
│   ├── preload.ts                contextBridge API
│   ├── upscaler.ts               job queue + ncnn child process
│   └── types.ts
├── src/                          React renderer (Vite + Tailwind)
├── resources/
│   ├── bin/                      NCNN binaries — populated by postinstall
│   │   ├── linux/  mac/  win/
│   └── models/                    Shared across platforms
├── scripts/download-binaries.mjs  fetches NCNN binaries + models
├── cove_icon.png / cove_icon.ico
├── package.json                    electron-builder targets: linux+win+mac
└── .github/workflows/release.yml
```

---

## Licensing

- Cove Upscaler is **MIT** — see `LICENSE`.
- Bundled [Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN) and
  [realcugan-ncnn-vulkan](https://github.com/nihui/realcugan-ncnn-vulkan)
  binaries are BSD-3-Clause / MIT. Models carry their upstream licenses.
