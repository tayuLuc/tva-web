# tva-web

WASM demo for [Temporal Video Analyzer](https://github.com/YOUR_USER/tva) — analyze short video clips in the browser.

## How it works

1. Browser decodes video via WebCodecs (H.264/VP9/AV1)
2. Raw frames passed to WASM (tva-core via wasm-pack)
3. Chart.js renders FPS graph

## Deploy

Pushed to `main` → auto-deploy to GitHub Pages.

```bash
wasm-pack build crates/tva-wasm --target web
```
