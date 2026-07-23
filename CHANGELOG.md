# Changelog

## [0.1.0] — 2026-07-23

### Added

- tva-core: streaming pipeline with Frame/PixelBuffer types
- tva-core: frame comparison via image-compare (SSIM, MS-SSIM, Hybrid, SAD, MAD)
- tva-core: duplicate detection (DedupState, streak tracking)
- tva-core: tear detection (scanline diff)
- tva-core: FPS metrics (1% low, 0.1% low, P90, P99)
- tva-core: Savitzky-Golay smoothing (staged-sg-filter, SIMD)
- tva-core: FFT-based native resolution detection
- tva-core: additive-only Report schema with serde
- tva-core: feature-gated adapters (compare-image, compare-dssim, smooth-savgol, decode-ffmpeg, fft)
- tva-cli: CLI binary stub (clap subcommands)
- tva-ffi: C FFI stub (cdylib + staticlib)
- tva-wasm: WASM bindings stub (wasm-bindgen)
- CI: 5 parallel jobs (msrv, lint, test, deny, targets) + MegaLinter
- CI: cargo-deny (advisories, bans, licenses)
- CI: release workflow (cross-platform binaries + crates.io publish)
- Lint: MegaLinter with custom configs (yamllint, markdownlint, hadolint, gitleaks, codespell, cspell, ls-lint)
- Docs: architecture.md
- License: MIT

### Architecture

```
tva-core          → core library (traits + pipeline, no external deps)
├── traits/       → FrameComparator, Smoother, FrameDecoder
├── adapters/     → feature-gated wrappers (image-compare, savgol, dssim, video-rs)
├── pixel_buffer  → Vec<u8> RGB, zero external deps
├── pipeline      → generic over traits, feature-gated adapters
└── report        → additive-only serde schema
```
