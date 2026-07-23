import init, { TvaSession, version, compare_frames_wasm, diff_heatmap_wasm } from "./pkg/tva_wasm.js";

const MAX_DURATION_S = 10;
const TARGET_HEIGHT = 360;
const EXTRACT_FPS = 30;

let fpsChart = null;
let timelineChart = null;

async function initWasm() {
    await init();
    document.getElementById("version").textContent = `v${version()}`;
}
initWasm().catch((e) => showError(`WASM init failed: ${e}`));

const dropZone = document.getElementById("drop-zone");
const fileInput = document.getElementById("file-input");
dropZone.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", (e) => { if (e.target.files[0]) handleFile(e.target.files[0]); });
dropZone.addEventListener("dragover", (e) => { e.preventDefault(); dropZone.classList.add("dragover"); });
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
dropZone.addEventListener("drop", (e) => {
    e.preventDefault(); dropZone.classList.remove("dragover");
    if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
});

async function handleFile(file) {
    hideError();
    document.getElementById("results").hidden = true;
    showProgress("Loading video…");
    try {
        const { width, height, fps } = await analyzeWithSession(file);
    } catch (e) { showError(`Failed: ${e.message || e}`); }
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
    const { frameCount, width, height } = videoDims(video);
    const fps = EXTRACT_FPS;

    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    const session = new TvaSession(width, height, fps, 0.98);

    for (let i = 0; i < frameCount; i++) {
        video.currentTime = i / fps;
        await new Promise((r) => { video.onseeked = r; });
        ctx.drawImage(video, 0, 0, width, height);
        const imgData = ctx.getImageData(0, 0, width, height);
        const rgba = imgData.data;

        const rgb = new Uint8Array(width * height * 3);
        rgbaToRgb(rgba, rgb);

        session.push_frame(rgb);
        setProgress(Math.round((i / frameCount) * 95), `Frame ${i + 1}/${frameCount}`);
    }

    URL.revokeObjectURL(video.src);
    setProgress(99, "Finalizing…");
    const jsonStr = session.finish();
    const report = JSON.parse(jsonStr);
    if (report.error) { showError(`Analysis error: ${report.error}`); return; }
    setProgress(100, "Done");
    renderResults(report);
    setTimeout(() => hideProgress(), 500);

    return { width, height, fps };
}

function runSample() {
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
    if (report.error) { showError(report.error); return; }
    setProgress(100, "Done");
    renderResults(report);
    setTimeout(() => hideProgress(), 500);
}

function renderResults(report) {
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

function renderFpsChart(report) {
    const ctx = document.getElementById("fps-chart").getContext("2d");
    if (fpsChart) fpsChart.destroy();
    const labels = report.frames.map((f) => f.unique_frame);
    fpsChart = new Chart(ctx, {
        type: "line",
        data: {
            labels,
            datasets: [
                { label: "FPS", data: report.frames.map((f) => f.instantaneous_fps), borderColor: "rgba(99,102,241,0.3)", borderWidth: 1, pointRadius: 0 },
                { label: "Smoothed", data: report.fps_smoothed.length ? report.fps_smoothed : report.frames.map((f) => f.instantaneous_fps), borderColor: "#6366f1", borderWidth: 2, pointRadius: 0 },
            ],
        },
        options: { responsive: true, plugins: { title: { display: true, text: "FPS per unique frame", color: "#e4e4e7" }, legend: { labels: { color: "#8b8d97" } } }, scales: { x: { ticks: { color: "#8b8d97" }, grid: { color: "rgba(42,45,58,0.5)" } }, y: { ticks: { color: "#8b8d97" }, grid: { color: "rgba(42,45,58,0.5)" } } } },
    });
}

function renderTimeline(report) {
    const ctx = document.getElementById("timeline-chart").getContext("2d");
    if (timelineChart) timelineChart.destroy();
    const labels = report.frames.map((f) => f.unique_frame);
    const streaks = report.frames.map((f) => f.streak_length);
    timelineChart = new Chart(ctx, {
        type: "bar",
        data: { labels, datasets: [{ label: "Streak", data: streaks, backgroundColor: streaks.map((s) => s > 1 ? "rgba(239,68,68,0.7)" : "rgba(34,197,94,0.5)") }] },
        options: { responsive: true, plugins: { title: { display: true, text: "Timeline (red = duplicate)", color: "#e4e4e7" }, legend: { display: false } }, scales: { x: { ticks: { color: "#8b8d97" }, grid: { color: "rgba(42,45,58,0.5)" } }, y: { ticks: { color: "#8b8d97" }, grid: { color: "rgba(42,45,58,0.5)" } } } },
    });
}

function showProgress(text) { document.getElementById("progress-section").hidden = false; document.getElementById("progress-text").textContent = text; document.getElementById("progress-fill").style.width = "0%"; }
function setProgress(pct, text) { document.getElementById("progress-fill").style.width = `${pct}%`; if (text) document.getElementById("progress-text").textContent = text; }
function hideProgress() { document.getElementById("progress-section").hidden = true; }
function showError(msg) { document.getElementById("error-text").textContent = msg; document.getElementById("error-section").hidden = false; }
function hideError() { document.getElementById("error-section").hidden = true; }

document.getElementById("sample-btn").addEventListener("click", runSample);

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
    hideError();
    document.getElementById("compare-results").hidden = true;
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

        const metric = document.getElementById("cmp-metric").value;
        const json = compare_frames_wasm(
            a.rgbData, a.width, a.height, a.fps, a.frameCount,
            b.rgbData, b.width, b.height, b.fps, b.frameCount,
            metric, 16.0,
        );
        const report = JSON.parse(json);
        if (report.error) { showError(`Compare error: ${report.error}`); return; }

        lastReport = report;
        lastDims = { width: a.width, height: a.height };

        document.getElementById("progress-fill").style.width = "100%";
        document.getElementById("progress-text").textContent = "Done";
        renderCompare(report);
    } catch (e) {
        showError(`Compare failed: ${e.message || e}`);
    } finally {
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

    const ctx = document.getElementById("sim-chart").getContext("2d");
    if (simChart) simChart.destroy();
    simChart = new Chart(ctx, {
        type: "line",
        data: {
            labels: r.profile.map((p) => (p.timestamp_ms / 1000).toFixed(1)),
            datasets: [{
                label: "Similarity (1 = identical)",
                data: r.profile.map((p) => p.similarity),
                borderColor: "#6366f1", borderWidth: 2, pointRadius: 0, fill: false,
            }],
        },
        options: {
            responsive: true,
            plugins: {
                title: { display: true, text: "Degradation over time (dips = where compression hit)", color: "#e4e4e7" },
                legend: { labels: { color: "#8b8d97" } },
            },
            scales: {
                x: { title: { display: true, text: "seconds", color: "#8b8d97" }, ticks: { color: "#8b8d97" }, grid: { color: "rgba(42,45,58,0.5)" } },
                y: { min: 0, max: 1, title: { display: true, text: "similarity", color: "#8b8d97" }, ticks: { color: "#8b8d97" }, grid: { color: "rgba(42,45,58,0.5)" } },
            },
            onClick: (evt) => {
                const els = simChart.getElementsAtEventForMode(evt, "index", { intersect: false }, true);
                if (els.length) seekHeat(els[0].index);
            },
        },
    });

    document.getElementById("compare-results").hidden = false;
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
        drawGray(document.getElementById("hm-diff"), gray, width, height);
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
            openLightbox(side, side === "hm-a" ? "A — original" : "B — compressed");
        }
    });
})();

// ── Lightbox (enlarge on click) ──
function openLightbox(canvasId, caption) {
    const c = document.getElementById(canvasId);
    if (!c) return;
    document.getElementById("lb-img").src = c.toDataURL();
    document.getElementById("lb-cap").textContent = caption;
    document.getElementById("lightbox").hidden = false;
}
function closeLightbox() { document.getElementById("lightbox").hidden = true; }

document.getElementById("lightbox").addEventListener("click", (e) => {
    if (e.target.dataset.close !== undefined || e.target.id === "lightbox") closeLightbox();
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeLightbox(); });

document.getElementById("hm-diff").addEventListener("click", () => openLightbox("hm-diff", "Δ heatmap"));
