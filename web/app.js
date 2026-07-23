import init, { analyze_frames, version } from "./pkg/tva_wasm.js";

const MAX_DURATION_S = 10;
const TARGET_HEIGHT = 360;
const EXTRACT_FPS = 30;

let wasmReady = false;
let fpsChart = null;
let timelineChart = null;

async function initWasm() {
    await init();
    wasmReady = true;
    document.getElementById("version").textContent = `v${version()}`;
}
initWasm().catch((e) => showError(`WASM init failed: ${e}`));

const dropZone = document.getElementById("drop-zone");
const fileInput = document.getElementById("file-input");
dropZone.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", (e) => { if (e.target.files.length > 0) handleFile(e.target.files[0]); });
dropZone.addEventListener("dragover", (e) => { e.preventDefault(); dropZone.classList.add("dragover"); });
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
dropZone.addEventListener("drop", (e) => {
    e.preventDefault(); dropZone.classList.remove("dragover");
    if (e.dataTransfer.files.length > 0) handleFile(e.dataTransfer.files[0]);
});

async function handleFile(file) {
    hideError();
    document.getElementById("results").hidden = true;
    showProgress("Loading video…");
    try {
        const { rgbData, width, height, frameCount, fps } = await extractFrames(file);
        if (frameCount === 0) { showError("No frames extracted."); return; }
        setProgress(90, "Analyzing frames…");
        await new Promise((r) => setTimeout(r, 50));
        const jsonStr = analyze_frames(rgbData, width, height, frameCount, fps, 0.98);
        const report = JSON.parse(jsonStr);
        if (report.error) { showError(`Analysis error: ${report.error}`); return; }
        setProgress(100, "Done");
        renderResults(report);
    } catch (e) { showError(`Failed: ${e.message || e}`); }
    finally { setTimeout(() => hideProgress(), 500); }
}

async function extractFrames(file) {
    const video = document.createElement("video");
    video.muted = true; video.playsInline = true;
    video.src = URL.createObjectURL(file);
    await new Promise((resolve, reject) => {
        video.onloadedmetadata = resolve;
        video.onerror = () => reject(new Error("Cannot load video"));
    });
    const duration = Math.min(video.duration, MAX_DURATION_S);
    const frameCount = Math.floor(duration * EXTRACT_FPS);
    const scale = Math.min(1, TARGET_HEIGHT / video.videoHeight);
    const width = Math.round(video.videoWidth * scale);
    const height = Math.round(video.videoHeight * scale);
    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const frameSize = width * height * 3;
    const rgbData = new Uint8Array(frameCount * frameSize);
    for (let i = 0; i < frameCount; i++) {
        video.currentTime = i / EXTRACT_FPS;
        await new Promise((resolve) => { video.onseeked = resolve; });
        ctx.drawImage(video, 0, 0, width, height);
        const imgData = ctx.getImageData(0, 0, width, height);
        const src = imgData.data;
        const off = i * frameSize;
        for (let j = 0, k = 0; j < src.length; j += 4, k += 3) {
            rgbData[off + k] = src[j];
            rgbData[off + k + 1] = src[j + 1];
            rgbData[off + k + 2] = src[j + 2];
        }
        setProgress(Math.round((i / frameCount) * 85), `Extracting frame ${i + 1}/${frameCount}`);
    }
    URL.revokeObjectURL(video.src);
    return { rgbData, width, height, frameCount, fps: EXTRACT_FPS };
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
                { label: "Instantaneous FPS", data: report.frames.map((f) => f.instantaneous_fps), borderColor: "rgba(99,102,241,0.3)", borderWidth: 1, pointRadius: 0 },
                { label: "Smoothed FPS", data: report.fps_smoothed.length ? report.fps_smoothed : report.frames.map((f) => f.instantaneous_fps), borderColor: "#6366f1", borderWidth: 2, pointRadius: 0 },
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
        data: { labels, datasets: [{ label: "Streak length", data: streaks, backgroundColor: streaks.map((s) => s > 1 ? "rgba(239,68,68,0.7)" : "rgba(34,197,94,0.5)") }] },
        options: { responsive: true, plugins: { title: { display: true, text: "Frame timeline (red = duplicates)", color: "#e4e4e7" }, legend: { display: false } }, scales: { x: { ticks: { color: "#8b8d97" }, grid: { color: "rgba(42,45,58,0.5)" } }, y: { ticks: { color: "#8b8d97" }, grid: { color: "rgba(42,45,58,0.5)" } } } },
    });
}

function showProgress(text) { document.getElementById("progress-section").hidden = false; document.getElementById("progress-text").textContent = text; document.getElementById("progress-fill").style.width = "0%"; }
function setProgress(pct, text) { document.getElementById("progress-fill").style.width = `${pct}%`; if (text) document.getElementById("progress-text").textContent = text; }
function hideProgress() { document.getElementById("progress-section").hidden = true; }
function showError(msg) { document.getElementById("error-text").textContent = msg; document.getElementById("error-section").hidden = false; }
function hideError() { document.getElementById("error-section").hidden = true; }

// ── Sample: synthetic frames with known duplicates ──
document.getElementById("sample-btn").addEventListener("click", runSample);

function runSample() {
    hideError();
    document.getElementById("results").hidden = true;
    showProgress("Generating sample…");

    const width = 320, height = 240, fps = 30, totalFrames = 90;
    const frameSize = width * height * 3;
    const rgbData = new Uint8Array(totalFrames * frameSize);

    for (let i = 0; i < totalFrames; i++) {
        const isDupe = i > 0 && i % 3 === 0;
        const ui = isDupe ? i - 1 : i;
        const [r, g, b] = hslToRgb((ui * 4 % 360) / 360, 0.7, 0.5);
        const off = i * frameSize;
        for (let p = 0; p < width * height; p++) {
            rgbData[off + p * 3] = r;
            rgbData[off + p * 3 + 1] = g;
            rgbData[off + p * 3 + 2] = b;
        }
        setProgress(Math.round((i / totalFrames) * 50), `Frame ${i + 1}/${totalFrames}`);
    }

    setProgress(60, "Analyzing…");
    setTimeout(() => {
        try {
            const jsonStr = analyze_frames(rgbData, width, height, totalFrames, fps, 0.98);
            const report = JSON.parse(jsonStr);
            if (report.error) { showError(`Analysis error: ${report.error}`); return; }
            setProgress(100, "Done");
            renderResults(report);
        } catch (e) { showError(`Failed: ${e.message || e}`); }
        finally { setTimeout(() => hideProgress(), 500); }
    }, 50);
}

function hslToRgb(h, s, l) {
    let r, g, b;
    if (s === 0) { r = g = b = l * 255; }
    else {
        const hue2rgb = (p, q, t) => {
            if (t < 0) t += 1;
            if (t > 1) t -= 1;
            if (t < 1/6) return p + (q - p) * 6 * t;
            if (t < 1/2) return q;
            if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
            return p;
        };
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        r = hue2rgb(p, q, h + 1/3) * 255;
        g = hue2rgb(p, q, h) * 255;
        b = hue2rgb(p, q, h - 1/3) * 255;
    }
    return [Math.round(r), Math.round(g), Math.round(b)];
}
