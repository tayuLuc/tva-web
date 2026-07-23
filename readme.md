# tva-web

Browser demo for [tva-core](https://github.com/tayuLuc/tva).
Analyze video frames for FPS drops, duplicates, and tears — entirely client-side.

## Dev

```bash
wasm-pack build wasm --target web --out-dir ../web/pkg
cd web && python3 -m http.server 8080
```

## Deploy

Push to `main` → GitHub Actions → GitHub Pages.
