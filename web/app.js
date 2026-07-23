import init, { TvaSession, version } from "./pkg/tva_wasm.js";

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

async function analyzeWithSession(file) {
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

        // RGBA → RGB
        const rgb = new Uint8Array(width * height * 3);
        for (let j = 0, k = 0; j < rgba.length; j += 4, k += 3) {
            rgb[k] = rgba[j];
            rgb[k + 1] = rgba[j + 1];
            rgb[k + 2] = rgba[j + 2];
        }

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
