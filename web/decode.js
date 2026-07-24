// A2a: libav.js demux (real container PTS) + WebCodecs VideoDecoder (HW decode)
// with automatic fallback to browser seek. Probe-gate: one keyframe decoded
// before any yield -> fallback never mixes frames with the A2 path.
//
// The bundled libav build (webcodecs-avf) has no software video decoder; it
// serves only as the demuxer here. WebCodecs provides the hardware decode.
//
// For long clips (>10s) a Worker+transfer design would be the v2 upgrade;
// for the vitrine, direct mode (noworker) with async callback->queue bridge is
// sufficient -- the heavy decode runs asynchronously in WebCodecs anyway.

const LIBAV_BASE = "./libav";
const LIBAV_VARIANT = "webcodecs-avf";
const EXTRACT_FPS = 30;

let libavP = null;
function getLibAV() {
  if (!libavP) {
    globalThis.LibAV = { base: LIBAV_BASE + "/" };
    libavP = new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = `${LIBAV_BASE}/libav-${LIBAV_VARIANT}.js`;
      s.onload = () => res(globalThis.LibAV.LibAV({ noworker: true }));
      s.onerror = () => rej(new Error("libav.js failed to load"));
      document.head.appendChild(s);
    });
  }
  return libavP;
}

// libav codec name -> WebCodecs codec string.
// H.264 needs extradata (avcC) passed as `description`; others are self-describing.
function codecString(name) {
  switch ((name || "").toLowerCase()) {
    case "h264":  return "avc1";
    case "vp9":   return "vp09.00.10.08";
    case "vp8":   return "vp8";
    case "av1":   return "av01.0.01M.08";
    case "hevc":
    case "h265":  return "hev1.1.6.L93.B0";
    default:      return null;
  }
}

// Async queue: producer (WebCodecs output callback) pushes, consumer (generator) pulls.
const END = Symbol();
function makeQueue() {
  let waiter = null;
  const q = [];
  return {
    push(v) { if (waiter) { const w = waiter; waiter = null; w({ value: v, done: false }); } else q.push(v); },
    close() { if (waiter) { const w = waiter; waiter = null; w({ value: undefined, done: true }); } q.push(END); },
    fail(e) { if (waiter) { const w = waiter; waiter = null; w({ value: undefined, done: true }); } q.push(END); },
    next() {
      if (q.length) { const v = q.shift(); return Promise.resolve(v === END ? { value: undefined, done: true } : { value: v, done: false }); }
      return new Promise((r) => { waiter = r; });
    },
  };
}

// Downscale a VideoFrame in HW via createImageBitmap, read back RGB24.
async function frameToRgb(frame, w, h) {
  const bmp = await createImageBitmap(frame, { resizeWidth: w, resizeHeight: h });
  const oc = new OffscreenCanvas(w, h);
  const ctx = oc.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const src = ctx.getImageData(0, 0, w, h).data;
  const rgb = new Uint8Array(w * h * 3);
  for (let j = 0, k = 0; j < src.length; j += 4, k += 3) { rgb[k] = src[j]; rgb[k + 1] = src[j + 1]; rgb[k + 2] = src[j + 2]; }
  return rgb;
}

async function* decodeWebCodecs(file, { targetW, targetH, maxSeconds, onProgress }) {
  if (typeof VideoDecoder === "undefined") throw new Error("WebCodecs unavailable");
  const lib = await getLibAV();

  const name = "in_" + Math.random().toString(36).slice(2);
  await lib.writeFile(name, new Uint8Array(await file.arrayBuffer()));
  const [fmt, streams] = await lib.ff_init_demuxer_file(name);
  const vs = streams.find((s) => s.codec_type === lib.AVMEDIA_TYPE_VIDEO);
  if (!vs) throw new Error("no video stream");

  const codecName = await lib.avcodec_get_name(vs.codec_id);
  const codec = codecString(codecName);
  if (!codec) throw new Error("unsupported codec: " + codecName);

  const cp = await lib.ff_copyout_codecpar(vs.codecpar);
  const w = targetW || cp.width, h = targetH || cp.height;

  const queue = makeQueue();
  let probed = false, probeErr = null;
  let probeRes, probeRej;
  const probe = new Promise((res, rej) => { probeRes = res; probeRej = rej; });

  const decoder = new VideoDecoder({
    output: async (frame) => {
      try {
        const ptsMs = frame.timestamp / 1000;
        const rgb = await frameToRgb(frame, w, h);
        frame.close();
        if (!probed) { probed = true; probeRes(); }
        queue.push({ rgb, pts_ms: ptsMs, width: w, height: h });
      } catch (e) { queue.fail(e); }
    },
    error: (e) => { probeErr = e; if (!probed) probeRej(e); else queue.fail(e); },
  });

  const cfg = { codec, codedWidth: cp.width, codedHeight: cp.height, optimizeForLatency: true };
  if (codec === "avc1" && cp.extradata) cfg.description = cp.extradata;
  try { decoder.configure(cfg); } catch (e) { decoder.close(); throw e; }

  const maxPtsMs = maxSeconds * 1000;
  const pkt = await lib.av_packet_alloc();

  (async () => {
    try {
      let eof = false;
      while (!eof) {
        const [ret, byStream] = await lib.ff_read_frame_multi(fmt, pkt, { limit: 1 << 20 });
        const pkts = byStream[vs.index] || [];
        for (const p of pkts) {
          const ptsS = lib.i64tof64(p.pts, p.ptshi) * (p.time_base_num / p.time_base_den);
          if (ptsS * 1000 > maxPtsMs) { eof = true; break; }
          const chunk = new EncodedVideoChunk({
            type: (p.flags & lib.AV_PKT_FLAG_KEY) ? "key" : "delta",
            timestamp: ptsS * 1e6,
            data: p.data,
          });
          decoder.decode(chunk);
        }
        if (ret === lib.AVERROR_EOF) eof = true;
      }
      await decoder.flush();
      decoder.close();
      queue.close();
    } catch (e) { queue.fail(e); }
    finally {
      try { await lib.av_packet_free(pkt); } catch {}
      try { await lib.avformat_close_input_js(fmt); } catch {}
      try { await lib.unlink(name); } catch {}
    }
  })();

  await probe;
  if (probeErr) throw probeErr;

  for (;;) {
    const { value, done, error } = await queue.next();
    if (error) throw error;
    if (done) return;
    onProgress((value.index || 0) + 1, value.pts_ms);
    yield value;
  }
}

// fallback: browser seek, uniform 30 fps
async function* seekDecode(file, { targetW, targetH, maxSeconds, onProgress }) {
  const video = document.createElement("video");
  video.muted = true; video.playsInline = true; video.preload = "auto";
  const url = URL.createObjectURL(file);
  video.src = url;
  try {
    await new Promise((res, rej) => { video.onloadedmetadata = res; video.onerror = () => rej(new Error("metadata")); });
    const scale = Math.min(1, (targetH || 360) / video.videoHeight);
    const w = targetW || Math.round(video.videoWidth * scale);
    const h = targetH || Math.round(video.videoHeight * scale);
    const frameCount = Math.floor(Math.min(video.duration, maxSeconds || 10) * EXTRACT_FPS);
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const rgb = new Uint8Array(w * h * 3);
    for (let i = 0; i < frameCount; i++) {
      video.currentTime = i / EXTRACT_FPS;
      await new Promise((res, rej) => { video.onseeked = res; video.onerror = () => rej(new Error("seek")); });
      ctx.drawImage(video, 0, 0, w, h);
      const src = ctx.getImageData(0, 0, w, h).data;
      for (let j = 0, k = 0; j < src.length; j += 4, k += 3) { rgb[k] = src[j]; rgb[k + 1] = src[j + 1]; rgb[k + 2] = src[j + 2]; }
      const pts = (i / EXTRACT_FPS) * 1000;
      onProgress(i + 1, pts);
      yield { rgb: rgb.slice(), pts_ms: pts, width: w, height: h, index: i };
    }
  } finally { URL.revokeObjectURL(url); video.removeAttribute("src"); video.load(); }
}

export async function* decodeVideo(file, opts = {}) {
  const o = { targetH: 360, maxSeconds: 10, onProgress: () => {}, onMeta: () => {}, ...opts };
  try {
    o.onMeta({ path: "webcodecs", note: "libav demux + WebCodecs decode -- real container PTS / VFR." });
    yield* decodeWebCodecs(file, o);
  } catch (e) {
    console.warn("WebCodecs unavailable, falling back to seek:", e.message);
    o.onMeta({ path: "seek", note: "browser seek -- uniform 30 fps (source PTS unavailable: " + e.message + ")." });
    yield* seekDecode(file, o);
  }
}
