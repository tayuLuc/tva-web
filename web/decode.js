// Decode video via libav.js → stream of RGB24 frames with real container PTS.
// Variant: webcodecs-avf (H.264, VP8, VP9, AV1 via browser-native WebCodecs).
//   For other codecs just swap variant: vp8-opus-avf, webm, etc.
//
// Design: first decoded frame yields real dimensions → then init filter graph
// with downscale + RGB24 conversion (native C, 4K never materialises in JS).
// Remaining frames: decode+filter in one step via ff_decode_filter_multi.
// Generator yields { rgb: Uint8Array(RGB24), pts_ms, width, height, index }.

const LIBAV_VARIANT = "webcodecs-avf";
const LIBAV_BASE = "https://unpkg.com/libav.js@6.0.7/dist";

let libavPromise = null;
function getLibAV() {
  if (!libavPromise) {
    globalThis.LibAV = { base: LIBAV_BASE };
    libavPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = `${LIBAV_BASE}/libav-${LIBAV_VARIANT}.js`;
      s.onload = () => resolve(globalThis.LibAV.LibAV());
      s.onerror = () => reject(new Error("libav.js failed to load"));
      document.head.appendChild(s);
    });
  }
  return libavPromise;
}

export async function* decodeVideo(file, { targetW, targetH, maxSeconds = 10, onProgress } = {}) {
  const lib = await getLibAV();

  // ── write file into libav's virtual FS ──
  const name = "in_" + Math.random().toString(36).slice(2);
  await lib.writeFile(name, new Uint8Array(await file.arrayBuffer()));

  // ── demux ──
  const [fmtCtx, streams] = await lib.ff_init_demuxer_file(name);
  const vs = streams.find((s) => s.codec_type === lib.AVMEDIA_TYPE_VIDEO);
  if (!vs) throw new Error("no video stream");

  const tbNum = vs.time_base_num, tbDen = vs.time_base_den;
  // ponytail: time_base ≈ 1/fps for CFR; for VFR it's avg, fallback only
  const fallbackFps = tbDen / tbNum;

  // ── init decoder with codecpar from stream ──
  const [, c, pkt, frame] = await lib.ff_init_decoder(vs.codec_id, {
    codecpar: vs.codecpar,
    time_base: [tbNum, tbDen],
  });

  // ── read + decode first batch to get real frame dimensions ──
  let eof = false;
  let [, packetsByStream] = await lib.ff_read_frame_multi(fmtCtx, pkt, { limit: 1 << 20 });
  let videoPackets = packetsByStream[vs.index] || [];
  if (!videoPackets.length) throw new Error("no video packets");

  let decoded = await lib.ff_decode_multi(c, pkt, frame, videoPackets, { copyoutFrame: "video_packed" });
  if (!decoded.length) throw new Error("first frame did not decode");

  // first frame yields real pix_fmt + dimensions after decode
  const firstFrame = decoded[0];
  const srcW = firstFrame.width, srcH = firstFrame.height;
  const pixFmt = firstFrame.format;  // typically AV_PIX_FMT_YUV420P for H.264
  const w = targetW || srcW, h = targetH || srcH;

  // ── init filter graph: downscale + YUV→RGB24 ──
  const [graph, src, sink] = await lib.ff_init_filter_graph(
    `scale=${w}:${h},format=rgb24`,
    {
      width: srcW, height: srcH, pix_fmt: pixFmt,
      time_base: [tbNum, tbDen],
      frame_rate: fallbackFps,
    },
    {
      width: w, height: h,
      pix_fmt: lib.AV_PIX_FMT_RGB24,
      time_base: [tbNum, tbDen],
      frame_rate: fallbackFps,
    },
  );

  // ── filter helper ──
  const maxPtsMs = maxSeconds * 1000;
  let index = 0;

  async function* pump(frames, startIdx) {
    const rgb = await lib.ff_filter_multi(src, sink, frame, frames, { copyoutFrame: "video_packed" });
    for (let i = 0; i < rgb.length; i++) {
      const f = rgb[i];
      // PTS: from RGB frame, fallback to decoded frame's PTS, fallback to counter
      let ptsMs;
      if (f.pts && f.pts > 0) {
        ptsMs = f.pts * (tbNum / tbDen) * 1000;
      } else if (frames[i] && frames[i].pts && frames[i].pts > 0) {
        ptsMs = frames[i].pts * (tbNum / tbDen) * 1000;
      } else {
        ptsMs = (startIdx + i) / fallbackFps * 1000;
      }
      if (ptsMs > maxPtsMs) { eof = true; return; }
      yield { rgb: f.data, pts_ms: ptsMs, width: w, height: h, index: startIdx + i };
      if (onProgress) onProgress(startIdx + i, ptsMs);
    }
  }

  for await (const fr of pump(decoded, index)) { yield fr; index++; }

  // ── decode + filter remaining ──
  while (!eof) {
    const [res, pktByStream] = await lib.ff_read_frame_multi(fmtCtx, pkt, { limit: 1 << 20 });
    const pkts = pktByStream[vs.index] || [];
    const isEof = res === lib.AVERROR_EOF;

    if (pkts.length) {
      const frames = await lib.ff_decode_filter_multi(
        c, src, sink, pkt, frame, pkts,
        { copyoutFrame: "video_packed" },
      );
      for await (const fr of pump(frames, index)) { yield fr; index++; }
    }

    if (isEof) {
      // flush anything still in the decoder/filter
      const fin = await lib.ff_decode_filter_multi(
        c, src, sink, pkt, frame, [],
        { fin: true, copyoutFrame: "video_packed" },
      );
      for await (const fr of pump(fin, index)) { yield fr; index++; }
      eof = true;
    }
  }

  // ── cleanup ──
  try { await lib.ff_free_decoder(c, pkt, frame); } catch {}
  try { await lib.avformat_close_input_js(fmtCtx); } catch {}
  try { await lib.unlink(name); } catch {}
}
