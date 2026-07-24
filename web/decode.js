// Video → stream of RGB24 frames for tva-core sessions.
//
// ACTIVE path: browser seek (uniform 30 fps timestamps). Correct for every
// metric tva computes (duplicates, tears, SSIM/MAD, Laplacian) on constant-rate
// content; source PTS / VFR is the one thing it approximates.
//
// Planned but not shipped here:
//   - WebCodecs decode (libav demux → VideoDecoder, honest source PTS/VFR):
//     needs a probe/reopen streaming design validated in a real browser.
//     The web/libav/ files stay as the demuxer for that step.
//
// Yields { rgb: Uint8Array(RGB24), pts_ms, width, height, index }.
// Calls opts.onMeta({path, note}) once, when the path is chosen.

const EXTRACT_FPS = 30;

export async function* decodeVideo(file, opts = {}) {
  const { targetH = 360, maxSeconds = 10, onProgress = () => {}, onMeta = () => {} } = opts;

  onMeta({
    path: "seek",
    note:
      "browser seek → uniform 30 fps timestamps. Honest source PTS / VFR " +
      "via libav-demux + WebCodecs is the planned next step.",
  });

  yield* seekDecode(file, { targetH, maxSeconds, onProgress });
}

async function* seekDecode(file, { targetH, maxSeconds, onProgress }) {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  const url = URL.createObjectURL(file);
  video.src = url;

  let canvas, ctx;
  try {
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = () => reject(new Error("cannot load video metadata"));
    });

    const duration = Math.min(video.duration, maxSeconds);
    const frameCount = Math.floor(duration * EXTRACT_FPS);
    const scale = Math.min(1, targetH / video.videoHeight);
    let width = Math.round(video.videoWidth * scale);
    let height = Math.round(video.videoHeight * scale);
    width += width & 1;
    height += height & 1;

    canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    ctx = canvas.getContext("2d", { willReadFrequently: true });

    const rgb = new Uint8Array(width * height * 3);

    for (let i = 0; i < frameCount; i++) {
      video.currentTime = i / EXTRACT_FPS;
      await new Promise((resolve, reject) => {
        video.onseeked = resolve;
        video.onerror = () => reject(new Error("seek failed"));
      });
      ctx.drawImage(video, 0, 0, width, height);

      // pull RGBA pixels from canvas, convert to RGB in one loop
      const src = ctx.getImageData(0, 0, width, height).data;
      for (let j = 0, k = 0; j < src.length; j += 4, k += 3) {
        rgb[k] = src[j];
        rgb[k + 1] = src[j + 1];
        rgb[k + 2] = src[j + 2];
      }

      yield {
        rgb: rgb.slice(), // session copies anyway; slice is cheap insurance
        pts_ms: (i / EXTRACT_FPS) * 1000,
        width,
        height,
        index: i,
      };
      onProgress(i, (i / EXTRACT_FPS) * 1000);
    }
  } finally {
    URL.revokeObjectURL(url);
    video.removeAttribute("src");
    video.load();
  }
}
