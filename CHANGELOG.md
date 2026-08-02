# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.2.0] - 2026-08-02

### Added

- **Pixel mode** — exact nearest-neighbor enlargement for pixel art and other
  images whose hard edges must stay unchanged. It runs in-process and never
  invokes the NCNN/Vulkan executables, so it needs no GPU or Vulkan driver.
- Pixel scale options up to ×8 (×2, ×3, ×4, ×5, ×6, ×8), alongside the
  existing ×2 / ×3 / ×4 for Photo and Anime.
- Per-mode scale memory: each mode remembers its own last-used scale, and
  switching modes restores that mode's scale instead of carrying one over.
- Third-party notices for the bundled native and AI components are now
  distributed with the app under `resources/licenses/`, including sharp, the
  prebuilt libvips libraries, ncnn, Real-ESRGAN, and Real-CUGAN.

### Changed

- Windows x64 and Linux x64 are the supported release platforms.
- The AI payload bootstrap and the release packaging now fail loudly when the
  required binaries, libraries, or models are missing or incomplete, instead
  of producing a partially populated build.
- Debian packages declare `libvulkan1` as a runtime dependency, so the Vulkan
  loader needed by Photo and Anime is installed with the package.
- Release assets each get an individual SHA-256 sidecar file, including the
  auto-update metadata and `.blockmap` files.
- Refreshed `electron-updater` to 6.8.9.

### Fixed

- `Upscale N` acts only on eligible queue entries: completed jobs are no
  longer reprocessed, while failed and cancelled jobs stay retryable, and the
  button's count always matches the set it enqueues.
- Cancel-all no longer leaves stale cancellation state behind when the queue
  is idle, so subsequent runs start clean.
- Compare previews stay tied to the settings of the run that produced them
  rather than following later mode or scale changes.
- The Windows payload no longer ships `vcomp140d.dll`, Microsoft's debug
  OpenMP runtime, which was never intended for redistribution.

### Security

- Unexpected in-app navigation and new-window requests are denied by an
  explicit navigation policy.
- Enqueue IPC payloads are validated at runtime: job shape, mode, and
  mode-specific scale are all checked before any job is accepted.
- Job IDs are constrained to a safe character set before being used to build
  temporary filesystem paths.

[2.2.0]: https://github.com/Sin213/cove-image-upscaler/releases/tag/v2.2.0
