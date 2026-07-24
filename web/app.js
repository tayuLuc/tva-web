import init, { TvaSession, CompareSession, version, compare_frames_wasm, diff_heatmap_wasm } from "./pkg/tva_wasm.js";
import { decodeVideo } from "./decode.js";

const MAX_DURATION_S = 10;
const TARGET_HEIGHT = 360;
const EXTRACT_FPS = 30;

let fpsChart = null;
let timelineChart = null;
let analyzing = false, comparing = false;
let lastCompareKey = null;
const TAB_SEL = { 1: "#panel-1", 2: "#compare-section" };

// ── tabs ──
document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
        const p = btn.dataset.panel;
        document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b === btn));
        Object.entries(TAB_SEL).forEach(([k, sel]) => {
            document.querySelector(sel).hidden = k !== p;
        });
    });
});
document.querySelector("#compare-section").hidden = true;

function setBusy(panel, on) {
    const b = document.querySelector(`.tab[data-panel="${panel}"]`);
    if (b) b.classList.toggle("busy", on);
}

async function initWasm() {
    await init();
    document.getElementById("version").textContent = `v${version()}`;
}
initWasm().catch((e) => showError(`WASM init failed: ${e}`));

const dropZone = document.getElementById("drop-zone");
const fileInput = document.getElementById("file-input");
dropZone.addEventListener("click", (e) => {
    if (e.target.closest("button, label, input")) return;
    fileInput.click();
});
fileInput.addEventListener("change", (e) => { if (e.target.files[0]) handleFile(e.target.files[0]); });
dropZone.addEventListener("dragover", (e) => { e.preventDefault(); dropZone.classList.add("dragover"); });
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
dropZone.addEventListener("drop", (e) => {
    e.preventDefault(); dropZone.classList.remove("dragover");
    if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
});

async function handleFile(file) {
    if (analyzing) return;
    hideError();
    document.getElementById("results").hidden = true;
    showProgress("Loading video…");
    analyzing = true; setBusy(1, true);
    try {
        const { width, height, fps } = await analyzeWithSession(file);
    } catch (e) { showError(`Failed: ${e.message || e}`); }
    finally { analyzing = false; setBusy(1, false); }
}

function loadVideo(file) {
    return new Promise((resolve, reject) => {
        const video = document.createElement("video");
        video.muted = true; video.playsInline = true;
        video.src = URL.createObjectURL(file);
        video.onloadedmetadata = () => resolve(video);
        video.onerror = () => reject(new Error("Cannot load video"));
    });
}

function videoDims(video) {
    const duration = Math.min(video.duration, MAX_DURATION_S);
    const frameCount = Math.floor(duration * EXTRACT_FPS);
    const scale = Math.min(1, TARGET_HEIGHT / video.videoHeight);
    const width = Math.round(video.videoWidth * scale);
    const height = Math.round(video.videoHeight * scale);
    return { duration, frameCount, width, height };
}

function rgbaToRgb(src, dst, dstOff) {
    for (let j = 0, k = dstOff || 0; j < src.length; j += 4, k += 3) {
        dst[k] = src[j]; dst[k + 1] = src[j + 1]; dst[k + 2] = src[j + 2];
    }
}

async function analyzeWithSession(file) {
    const video = await loadVideo(file);
    const { width, height } = videoDims(video);
    URL.revokeObjectURL(video.src);

    const session = new TvaSession(width, height, EXTRACT_FPS, 0.98);
    let decodePath = null;

    showProgress("Extracting frames…");
    for await (const fr of decodeVideo(file, {
        targetH: TARGET_HEIGHT,
        maxSeconds: MAX_DURATION_S,
        onMeta: (m) => {
            decodePath = m;
            setProgress(undefined, m.path === "seek" ? "Extracting frames (browser seek)…" : m.path);
        },
        onProgress: (idx, pts) =>
            setProgress(Math.min(95, (idx / 300) * 95), `Frame ${idx + 1} · t=${(pts / 1000).toFixed(2)}s`),
    })) {
        session.push_frame_pts(fr.rgb, fr.pts_ms);
    }

    setProgress(99, "Finalizing…");
    const jsonStr = session.finish();
    const report = JSON.parse(jsonStr);
    if (report.error) { showError(`Analysis error: ${report.error}`); return; }
    setProgress(100, "Done");
    renderResults(report, decodePath);
    setTimeout(() => hideProgress(), 500);
    return { width, height, fps: EXTRACT_FPS, path: decodePath };
}

function runSample() {
    if (analyzing) return;
    analyzing = true; setBusy(1, true);
    document.getElementById("sample-btn").disabled = true;
    hideError();
    document.getElementById("results").hidden = true;
    showProgress("Generating…");

    const width = 320, height = 240, fps = 30, totalFrames = 90;
    const session = new TvaSession(width, height, fps, 0.98);
    const frameSize = width * height * 3;

    for (let i = 0; i < totalFrames; i++) {
        const isDupe = i > 0 && i % 3 === 0;
        const ui = isDupe ? i - 1 : i;
        const [r, g, b] = hslToRgb((ui * 4 % 360) / 360, 0.7, 0.5);
        const rgb = new Uint8Array(frameSize);
        for (let p = 0; p < width * height; p++) {
            rgb[p * 3] = r;
            rgb[p * 3 + 1] = g;
            rgb[p * 3 + 2] = b;
        }
        session.push_frame(rgb);
        setProgress(Math.round((i / totalFrames) * 50), `Frame ${i + 1}/${totalFrames}`);
    }

    setProgress(95, "Finalizing…");
    const jsonStr = session.finish();
    const report = JSON.parse(jsonStr);
    if (report.error) { showError(report.error); analyzing = false; setBusy(1, false); document.getElementById("sample-btn").disabled = false; return; }
    setProgress(100, "Done");
    renderResults(report);
    setTimeout(() => hideProgress(), 500);
    analyzing = false; setBusy(1, false);
    document.getElementById("sample-btn").disabled = false;
}

function renderResults(report, path) {
    const dp = document.getElementById("decode-path");
    if (dp) {
        if (path && path.path) {
            dp.hidden = false;
            dp.textContent = `Decode: ${path.path}${path.note ? " — " + path.note : ""}`;
        } else {
            dp.hidden = true;
        }
    }
    const s = report.summary;
    document.getElementById("stat-fps").textContent = s.avg_fps.toFixed(1);
    document.getElementById("stat-1low").textContent = s.fps_1_low.toFixed(1);
    document.getElementById("stat-unique").textContent = s.total_unique_frames;
    document.getElementById("stat-dupes").textContent = s.duplicate_count;
    document.getElementById("stat-tears").textContent = s.tear_count;
    document.getElementById("stat-p99").textContent = s.p99_frame_time_ms.toFixed(1);
    document.getElementById("raw-json").textContent = JSON.stringify(report, null, 2);
    renderFpsChart(report);
    renderTimeline(report);
    document.getElementById("results").hidden = false;
}

// ── Crosshair plugin (vertical dashed line on hover) ──
const crosshair = {
    id: "crosshair",
    afterDraw(chart) {
        const act = chart.getActiveElements();
        if (!act.length) return;
        const x = act[0].element.x;
        const { top, bottom } = chart.chartArea;
        const ctx = chart.ctx;
        ctx.save();
        ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom);
        ctx.lineWidth = 1; ctx.strokeStyle = "rgba(255,255,255,0.25)";
        ctx.setLineDash([4, 3]); ctx.stroke(); ctx.restore();
    },
};

// ── Zoom + position sliders for linear-x charts ──
function attachZoom(chart, fullMin, fullMax) {
    const wrap = chart.canvas.parentNode;
    wrap.querySelectorAll(".zoom-controls").forEach((n) => n.remove());
    const canvas = chart.canvas;
    if (canvas.__zoomAbort) canvas.__zoomAbort.abort();
    const ac = new AbortController();
    canvas.__zoomAbort = ac;
    const sig = ac.signal;

    const range = Math.max(fullMax - fullMin, 1e-6);
    const ctl = document.createElement("div");
    ctl.className = "zoom-controls";
    ctl.innerHTML =
        `<label>Zoom <input type="range" class="z-zoom" min="1" max="20" step="0.1" value="1"></label>` +
        `<label>Position <input type="range" class="z-pos" min="0" max="1000" step="1" value="500"></label>` +
        `<button type="button" class="z-reset">Reset</button>`;
    wrap.appendChild(ctl);
    const zIn = ctl.querySelector(".z-zoom");
    const pIn = ctl.querySelector(".z-pos");
    ctl.querySelector(".z-reset").addEventListener("click", () => { zIn.value = 1; pIn.value = 500; apply(); });

    const clampWin = (min, max, win) => {
        if (min < fullMin) { min = fullMin; max = fullMin + win; }
        if (max > fullMax) { max = fullMax; min = fullMax - win; }
        if (min < fullMin) min = fullMin;
        return [min, max];
    };
    function apply() {
        const live = Chart.getChart(canvas) || chart;
        const win = range / parseFloat(zIn.value);
        const center = fullMin + (parseFloat(pIn.value) / 1000) * range;
        const [min, max] = clampWin(center - win / 2, center + win / 2, win);
        live.options.scales.x.min = min; live.options.scales.x.max = max;
        live.update("none");
    }
    zIn.addEventListener("input", apply);
    pIn.addEventListener("input", apply);

    canvas.addEventListener("wheel", (e) => {
        e.preventDefault();
        const live = Chart.getChart(canvas);
        if (!live || !live.canvas) return;
        const rect = live.canvas.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const xVal = live.scales.x.getValueForPixel(px);
        const area = live.chartArea;
        const frac = Math.max(0, Math.min(1, (px - area.left) / (area.right - area.left)));
        const newZ = Math.min(20, Math.max(1, parseFloat(zIn.value) * (e.deltaY < 0 ? 1.2 : 1 / 1.2)));
        const newWin = range / newZ;
        const [min, max] = clampWin(xVal - frac * newWin, xVal - frac * newWin + newWin, newWin);
        live.options.scales.x.min = min; live.options.scales.x.max = max;
        zIn.value = newZ;
        pIn.value = Math.round((((min + max) / 2 - fullMin) / range) * 1000);
        live.update("none");
    }, { passive: false, signal: sig });

    apply();
}

function renderFpsChart(report) {
    const ctx = document.getElementById("fps-chart").getContext("2d");
    if (fpsChart) fpsChart.destroy();
    const sm = report.fps_smoothed.length ? report.fps_smoothed : report.frames.map((f) => f.instantaneous_fps);
    const maxI = report.frames.length ? report.frames[report.frames.length - 1].unique_frame : 0;
    fpsChart = new Chart(ctx, {
        type: "line",
        data: {
            datasets: [
                { label: "FPS", data: report.frames.map((f) => ({ x: f.unique_frame, y: f.instantaneous_fps })), borderColor: "rgba(99,102,241,0.3)", borderWidth: 1, pointRadius: 0, pointHoverRadius: 4 },
                { label: "Smoothed", data: report.frames.map((f, i) => ({ x: f.unique_frame, y: sm[i] })), borderColor: "#6366f1", borderWidth: 2, pointRadius: 0, pointHoverRadius: 4 },
            ],
        },
        options: {
            responsive: true,
            interaction: { mode: "index", intersect: false },
            hover: { mode: "index", intersect: false },
            plugins: { title: { display: true, text: "FPS per unique frame", color: "#e4e4e7" }, legend: { labels: { color: "#8b8d97" } } },
            scales: {
                x: { type: "linear", title: { display: true, text: "unique frame #", color: "#8b8d97" }, ticks: { color: "#8b8d97" }, grid: { color: "rgba(42,45,58,0.5)" } },
                y: { ticks: { color: "#8b8d97" }, grid: { color: "rgba(42,45,58,0.5)" } },
            },
        },
        plugins: [crosshair],
    });
    attachZoom(fpsChart, 0, maxI);
}

function renderTimeline(report) {
    const ctx = document.getElementById("timeline-chart").getContext("2d");
    if (timelineChart) timelineChart.destroy();
    const labels = report.frames.map((f) => f.unique_frame);
    const streaks = report.frames.map((f) => f.streak_length);
    timelineChart = new Chart(ctx, {
        type: "bar",
        data: { labels, datasets: [{ label: "Streak", data: streaks, backgroundColor: streaks.map((s) => s > 1 ? "rgba(239,68,68,0.7)" : "rgba(34,197,94,0.5)") }] },
        options: {
            responsive: true,
            interaction: { mode: "index", intersect: false },
            hover: { mode: "index", intersect: false },
            plugins: { title: { display: true, text: "Timeline (red = duplicate)", color: "#e4e4e7" }, legend: { display: false } },
            scales: { x: { ticks: { color: "#8b8d97" }, grid: { color: "rgba(42,45,58,0.5)" } }, y: { ticks: { color: "#8b8d97" }, grid: { color: "rgba(42,45,58,0.5)" } } },
        },
        plugins: [crosshair],
    });
}

function showProgress(text) { document.getElementById("progress-section").hidden = false; document.getElementById("progress-text").textContent = text; document.getElementById("progress-fill").style.width = "0%"; }
function setProgress(pct, text) { document.getElementById("progress-fill").style.width = `${pct}%`; if (text) document.getElementById("progress-text").textContent = text; }
function hideProgress() { document.getElementById("progress-section").hidden = true; }
function showError(msg) { document.getElementById("error-text").textContent = msg; document.getElementById("error-section").hidden = false; }
function hideError() { document.getElementById("error-section").hidden = true; }

document.getElementById("sample-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    runSample();
});

function hslToRgb(h, s, l) {
    let r, g, b;
    if (s === 0) { r = g = b = l * 255; }
    else {
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        const hue = (t) => { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1/6) return p + (q-p)*6*t; if (t < 1/2) return q; if (t < 2/3) return p + (q-p)*(2/3-t)*6; return p; };
        r = hue(h + 1/3) * 255; g = hue(h) * 255; b = hue(h - 1/3) * 255;
    }
    return [Math.round(r), Math.round(g), Math.round(b)];
}

// ── Compare (case A) ──
let fileA = null, fileB = null, simChart = null;
let lastReport = null, lastDims = null;

function wireSlot(letter) {
    const zone = document.getElementById(`drop-${letter}`);
    const input = document.getElementById(`file-${letter}`);
    zone.addEventListener("click", () => input.click());
    zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("dragover"); });
    zone.addEventListener("dragleave", () => zone.classList.remove("dragover"));
    zone.addEventListener("drop", (e) => {
        e.preventDefault(); zone.classList.remove("dragover");
        if (e.dataTransfer.files.length) setSlot(letter, e.dataTransfer.files[0]);
    });
    input.addEventListener("change", (e) => { if (e.target.files.length) setSlot(letter, e.target.files[0]); });
}
function setSlot(letter, file) {
    if (letter === "a") fileA = file; else fileB = file;
    const zone = document.getElementById(`drop-${letter}`);
    zone.classList.add("filled");
    document.getElementById(`name-${letter}`).textContent = file.name;
    document.getElementById("compare-btn").disabled = !(fileA && fileB);
}
wireSlot("a"); wireSlot("b");

document.getElementById("compare-btn").addEventListener("click", runCompare);

async function extractFrames(file) {
    const video = await loadVideo(file);
    const { duration, frameCount, width, height } = videoDims(video);

    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    const rgbData = new Uint8Array(width * height * 3 * frameCount);
    const fs = width * height * 3;

    for (let i = 0; i < frameCount; i++) {
        video.currentTime = i / EXTRACT_FPS;
        await new Promise((r) => { video.onseeked = r; });
        ctx.drawImage(video, 0, 0, width, height);
        rgbaToRgb(ctx.getImageData(0, 0, width, height).data, rgbData, i * fs);
    }

    URL.revokeObjectURL(video.src);
    return { rgbData, width, height, fps: EXTRACT_FPS, frameCount };
}

async function runCompare() {
    if (comparing) return;
    const metric = document.getElementById("cmp-metric").value;
    const key = [fileA, fileB, metric];
    if (lastReport && lastCompareKey &&
        lastCompareKey[0] === key[0] && lastCompareKey[1] === key[1] && lastCompareKey[2] === key[2]) {
        return;
    }
    hideError();
    document.getElementById("compare-results").hidden = true;
    comparing = true; setBusy(2, true);
    document.getElementById("compare-btn").disabled = true;
    try {
        document.getElementById("progress-section").hidden = false;
        document.getElementById("progress-fill").style.width = "0%";

        document.getElementById("progress-text").textContent = "Extracting A…";
        const a = await extractFrames(fileA);
        document.getElementById("progress-fill").style.width = "45%";
        document.getElementById("progress-text").textContent = "Extracting B…";
        const b = await extractFrames(fileB);

        document.getElementById("progress-fill").style.width = "90%";
        document.getElementById("progress-text").textContent = "Comparing…";
        await new Promise((r) => setTimeout(r, 30));

        const json = compare_frames_wasm(
            a.rgbData, a.width, a.height, a.fps, a.frameCount,
            b.rgbData, b.width, b.height, b.fps, b.frameCount,
            metric, 16.0,
        );
        const report = JSON.parse(json);
        if (report.error) { showError(`Compare error: ${report.error}`); return; }

        lastReport = report;
        lastDims = { width: a.width, height: a.height };
        lastCompareKey = key;

        document.getElementById("progress-fill").style.width = "100%";
        document.getElementById("progress-text").textContent = "Done";
        renderCompare(report);
    } catch (e) {
        showError(`Compare failed: ${e.message || e}`);
    } finally {
        comparing = false; setBusy(2, false);
        document.getElementById("compare-btn").disabled = !(fileA && fileB);
        setTimeout(() => { document.getElementById("progress-section").hidden = true; }, 500);
    }
}

function renderCompare(r) {
    const s = r.summary;
    document.getElementById("cmp-drop").textContent = s.quality_drop_pct.toFixed(1);
    document.getElementById("cmp-mean").textContent = s.mean_similarity.toFixed(3);
    document.getElementById("cmp-min").textContent = s.min_similarity.toFixed(3);
    document.getElementById("cmp-pairs").textContent = s.pairs_compared;
    document.getElementById("cmp-dropped").textContent = s.pairs_dropped;

    const mm = document.getElementById("cmp-mismatch");
    if (r.size_mismatch) {
        const m = r.size_mismatch;
        mm.textContent = `Aspect/resolution differ after downscale (${m.a[0]}×${m.a[1]} vs ${m.b[0]}×${m.b[1]}) — likely a crop; no pixel comparison performed.`;
        mm.hidden = false;
    } else {
        mm.hidden = true;
    }
    document.getElementById("heatmap-panel").hidden = !!r.size_mismatch;

    const simData = r.profile.map((p) => ({ x: p.timestamp_ms / 1000, y: p.similarity }));
    const maxSec = simData.length ? simData[simData.length - 1].x : 1;
    const ctx = document.getElementById("sim-chart").getContext("2d");
    if (simChart) simChart.destroy();
    simChart = new Chart(ctx, {
        type: "line",
        data: {
            datasets: [{
                label: "Similarity (1 = identical)",
                data: simData,
                borderColor: "#6366f1", borderWidth: 2, pointRadius: 0, pointHoverRadius: 5, fill: false,
            }],
        },
        options: {
            responsive: true,
            interaction: { mode: "index", intersect: false },
            hover: { mode: "index", intersect: false },
            plugins: {
                title: { display: true, text: "Degradation over time (dips = where compression hit)", color: "#e4e4e7" },
                legend: { labels: { color: "#8b8d97" } },
            },
            scales: {
                x: { type: "linear", title: { display: true, text: "seconds", color: "#8b8d97" }, ticks: { color: "#8b8d97" }, grid: { color: "rgba(42,45,58,0.5)" } },
                y: { min: 0, max: 1, title: { display: true, text: "similarity", color: "#8b8d97" }, ticks: { color: "#8b8d97" }, grid: { color: "rgba(42,45,58,0.5)" } },
            },
            onClick: (_evt, els) => { if (els.length) seekHeat(els[0].index); },
        },
        plugins: [crosshair],
    });
    attachZoom(simChart, 0, maxSec);

    document.getElementById("compare-results").hidden = false;

    // auto-show worst pair
    if (r.profile.length && !r.size_mismatch) {
        let worst = 0;
        for (let i = 1; i < r.profile.length; i++) {
            if (r.profile[i].similarity < r.profile[worst].similarity) worst = i;
        }
        seekHeat(worst);
    }
}

// ── Heatmap on click: re-seek both videos to the pair's timestamp ──
async function seekHeat(idx) {
    if (!lastReport || !lastDims || !fileA || !fileB) return;
    const point = lastReport.profile[idx];
    if (!point) return;
    const t = point.timestamp_ms / 1000;
    const { width, height } = lastDims;

    document.getElementById("heatmap-hint").textContent =
        `t = ${t.toFixed(2)}s · similarity ${point.similarity.toFixed(3)} · diff pixels ${(point.diff_pixel_ratio * 100).toFixed(1)}%`;

    try {
        const rgbA = await grabFrame(fileA, t, width, height);
        const rgbB = await grabFrame(fileB, t, width, height);

        drawRgb(document.getElementById("hm-a"), rgbA, width, height);
        drawRgb(document.getElementById("hm-b"), rgbB, width, height);

        const gray = diff_heatmap_wasm(rgbA, rgbB);
        drawGray(document.getElementById("hm-diff"), stretchGray(gray), width, height);
        document.getElementById("ba-slider").style.setProperty("--pos", "50%");

        document.getElementById("heatmap-meta").textContent =
            "Note: browser seek lands on the nearest decodable frame, so the pair may differ by ±1 frame from the analysis pass — fine for locating *where* quality dropped, not for exact frame math.";
    } catch (e) {
        document.getElementById("heatmap-meta").textContent = `heatmap failed: ${e.message || e}`;
    }
}

function grabFrame(file, t, width, height) {
    return new Promise((resolve, reject) => {
        const video = document.createElement("video");
        video.muted = true; video.playsInline = true; video.preload = "auto";
        const url = URL.createObjectURL(file);
        video.src = url;
        const canvas = document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });

        video.onloadeddata = () => { video.currentTime = Math.min(t, video.duration); };
        video.onseeked = () => {
            ctx.drawImage(video, 0, 0, width, height);
            const src = ctx.getImageData(0, 0, width, height).data;
            const rgb = new Uint8Array(width * height * 3);
            rgbaToRgb(src, rgb);
            URL.revokeObjectURL(url);
            resolve(rgb);
        };
        video.onerror = () => { URL.revokeObjectURL(url); reject(new Error("seek failed")); };
    });
}

function drawRgb(canvas, rgb, w, h) {
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(w, h);
    for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
        img.data[j] = rgb[i]; img.data[j + 1] = rgb[i + 1]; img.data[j + 2] = rgb[i + 2]; img.data[j + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
}

function drawGray(canvas, gray, w, h) {
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(w, h);
    for (let i = 0, j = 0; i < gray.length; i++, j += 4) {
        img.data[j] = img.data[j + 1] = img.data[j + 2] = gray[i]; img.data[j + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
}

// Контраст-стретч: p99 яркости → белое.
function stretchGray(gray) {
    const n = gray.length;
    if (n === 0) return gray;
    const hist = new Uint32Array(256);
    let maxv = 0;
    for (let i = 0; i < n; i++) { const v = gray[i]; hist[v]++; if (v > maxv) maxv = v; }
    if (maxv === 0) return gray;
    const target = Math.floor(n * 0.99);
    let acc = 0, white = 255;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= target) { white = v || 1; break; } }
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) { out[i] = Math.min(255, (gray[i] * 255 / white) | 0); }
    return out;
}

// ── Before/After slider (drag) + click-to-enlarge ──
(function initSlider() {
    const slider = document.getElementById("ba-slider");
    if (!slider) return;
    let down = false, moved = 0, lastX = 0;

    const posFromX = (clientX) => {
        const r = slider.getBoundingClientRect();
        const pct = Math.max(0, Math.min(100, ((clientX - r.left) / r.width) * 100));
        slider.style.setProperty("--pos", pct + "%");
        return pct;
    };

    slider.addEventListener("pointerdown", (e) => {
        down = true; moved = 0; lastX = e.clientX;
        slider.setPointerCapture(e.pointerId);
    });
    slider.addEventListener("pointermove", (e) => {
        if (!down) return;
        moved += Math.abs(e.clientX - lastX); lastX = e.clientX;
        posFromX(e.clientX);
    });
    slider.addEventListener("pointerup", (e) => {
        if (!down) return;
        down = false;
        if (moved < 6) {
            const r = slider.getBoundingClientRect();
            const side = (e.clientX - r.left) < r.width / 2 ? "hm-a" : "hm-b";
            openLightbox(side, side === "hm-a" ? "A — original" : "B — compressed", false);
        }
    });
})();

// ── Lightbox: растягивание + зум колесом + pan перетаскиванием ──
const lb = {
    el: document.getElementById("lightbox"),
    fig: null, img: null,
    z: 1, px: 0, py: 0,
    down: false, moved: 0, lx: 0, ly: 0,
};
lb.fig = lb.el.querySelector(".lb-figure");
lb.img = document.getElementById("lb-img");

function lbApply() {
    lb.img.style.transform = `translate(${lb.px}px, ${lb.py}px) scale(${lb.z})`;
    lb.fig.classList.toggle("zoomed", lb.z > 1.01);
}
function lbReset() { lb.z = 1; lb.px = 0; lb.py = 0; lbApply(); }

function openLightbox(canvasId, caption, pixelated) {
    const c = document.getElementById(canvasId);
    if (!c) return;
    lb.img.src = c.toDataURL();
    lb.img.className = pixelated ? "pixelated" : "";
    document.getElementById("lb-cap").textContent = caption;
    lbReset();
    lb.el.hidden = false;
}
function closeLightbox() { lb.el.hidden = true; lbReset(); }

lb.fig.addEventListener("wheel", (e) => {
    e.preventDefault();
    const f = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    lb.z = Math.max(1, Math.min(8, lb.z * f));
    if (lb.z === 1) { lb.px = 0; lb.py = 0; }
    lbApply();
}, { passive: false });

lb.fig.addEventListener("pointerdown", (e) => {
    lb.down = true; lb.moved = 0; lb.lx = e.clientX; lb.ly = e.clientY;
    lb.fig.setPointerCapture(e.pointerId);
    if (lb.z > 1.01) lb.fig.classList.add("panning");
});
lb.fig.addEventListener("pointermove", (e) => {
    if (!lb.down) return;
    const dx = e.clientX - lb.lx, dy = e.clientY - lb.ly;
    lb.moved += Math.abs(dx) + Math.abs(dy);
    lb.lx = e.clientX; lb.ly = e.clientY;
    if (lb.z > 1.01) { lb.px += dx; lb.py += dy; lbApply(); }
});
lb.fig.addEventListener("pointerup", () => {
    lb.fig.classList.remove("panning");
    if (!lb.down) return;
    lb.down = false;
    if (lb.moved < 6 && lb.z <= 1.01) closeLightbox();
});

lb.fig.addEventListener("dblclick", (e) => { e.preventDefault(); lbReset(); });

lb.el.addEventListener("click", (e) => { if (e.target.dataset.close !== undefined) closeLightbox(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !lb.el.hidden) closeLightbox(); });

document.getElementById("hm-diff").addEventListener("click", () => openLightbox("hm-diff", "Δ heatmap (contrast-stretched)", true));

// ── Resource monitoring helpers ──
function resourceSnapshot() {
    const m = performance.memory;
    const heap = m ? `${(m.usedJSHeapSize / 1048576).toFixed(0)} / ${(m.jsHeapSizeLimit / 1048576).toFixed(0)} MB heap` : "heap n/a (non-Chromium)";
    const cores = navigator.hardwareConcurrency ?? "?";
    const ram = navigator.deviceMemory ? `${navigator.deviceMemory} GB RAM` : "RAM n/a";
    return `${heap} · ${cores} cores · ${ram}`;
}
function effectiveMbps(file, duration) {
    if (!duration || duration <= 0) return null;
    return (file.size * 8) / duration / 1e6;
}
function even(x) { return x + (x & 1); }

// ── metric explainer ──
const METRIC_INFO = {
    ssim: {
        t: "SSIM — structural similarity (default)",
        d: "Compares structure, not raw pixels. Ignores faint compression noise, flags real structural damage. Best for \u201ca social network re-encoded my clip\u201d. Score 0\u20131, higher = closer.",
    },
    hybrid: {
        t: "Hybrid \u2014 structure + colour/luma",
        d: "SSIM blended with colour and brightness signals. A touch more sensitive to colour shifts and banding than plain SSIM. Score 0\u20131.",
    },
    mad: {
        t: "MAD \u2014 raw per-pixel difference",
        d: "Mean absolute byte difference, scale 0\u2013255. Sees *all* noise, including compression grain \u2014 so it reports \u201csomething changed everywhere\u201d even when SSIM says \u201cfine\u201d. Use for clean/capture content, or to prove noise exists. Not a 0\u20131 score.",
    },
};
function updateMetricDesc(val) {
    const el = document.getElementById("cmp-metric-desc");
    const info = METRIC_INFO[val] || METRIC_INFO.ssim;
    el.innerHTML = `<b>${info.t}</b> \u2014 ${info.d}`;
}
const metricSel = document.getElementById("cmp-metric");
metricSel.addEventListener("change", (e) => {
    updateMetricDesc(e.target.value);
    lastCompareKey = null;     // invalidate compare cache
});
updateMetricDesc(metricSel.value);
