#![forbid(unsafe_code)]

use tva_core::{
    adapters::image_compare::{metric_by_name, SsimComparator},
    adapters::savgol::SavgolSmoother,
    config::PipelineConfig,
    degradation::{compare_sources, DegradationConfig},
    detect::{self, DedupState, TearInfo},
    events::NullSink,
    frame::{Frame, VideoMeta},
    metrics::{compute_frame_metrics, compute_summary},
    pixel_buffer::PixelBuffer,
    traits::{FrameDecoder, FrameComparator, Smoother},
    report::Report,
};
use wasm_bindgen::prelude::*;

/// Streaming analysis session. One frame at a time, O(1) memory.
#[wasm_bindgen]
pub struct TvaSession {
    dedup: DedupState,
    streaks: Vec<u32>,
    tears: Vec<TearInfo>,
    prev: Option<PixelBuffer>,
    index: u64,
    fps: f64,
    width: u32,
    height: u32,
    comparator: SsimComparator,
    config: PipelineConfig,
}

#[wasm_bindgen]
impl TvaSession {
    #[wasm_bindgen(constructor)]
    pub fn new(width: u32, height: u32, fps: f64, threshold: f64) -> Self {
        Self {
            dedup: DedupState::new(threshold, true),
            streaks: Vec::new(),
            tears: Vec::new(),
            prev: None,
            index: 0,
            fps,
            width,
            height,
            comparator: SsimComparator,
            config: PipelineConfig {
                duplicate_threshold: threshold,
                ..Default::default()
            },
        }
    }

    pub fn push_frame(&mut self, rgb: Vec<u8>) -> Result<(), JsValue> {
        let buf = PixelBuffer::new(rgb, self.width, self.height)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        let frame = Frame {
            data: buf,
            index: self.index,
            timestamp_ms: self.index as f64 / self.fps * 1000.0,
        };

        if let Some(dup) = self
            .dedup
            .process(&frame, &self.comparator)
            .map_err(|e| JsValue::from_str(&e.to_string()))?
        {
            if let Some(last) = self.streaks.last_mut() {
                *last = dup.streak_length;
            }
        } else {
            self.streaks.push(1);
        }

        if self.config.detect_tears {
            if let Some(ref prev_buf) = self.prev {
                let prev_frame = Frame {
                    data: prev_buf.clone(),
                    index: self.index.saturating_sub(1),
                    timestamp_ms: 0.0,
                };
                if let Some(mut t) = detect::detect_tear(
                    &prev_frame, &frame,
                    self.config.tear_threshold_high,
                    self.config.tear_threshold_low,
                )
                .map_err(|e| JsValue::from_str(&e.to_string()))?
                {
                    t.frame_index = self.index;
                    self.tears.push(t);
                }
            }
        }

        self.prev = Some(frame.data);
        self.index += 1;
        Ok(())
    }

    pub fn finish(&mut self) -> String {
        let meta = VideoMeta {
            fps: self.fps,
            width: self.width,
            height: self.height,
            total_frames: self.index,
            duration_ms: self.index as f64 / self.fps * 1000.0,
            codec: "browser".into(),
        };
        let fm = compute_frame_metrics(&self.streaks, self.fps);
        let summary = compute_summary(&fm, self.tears.len() as u64, 0);
        let fps_raw: Vec<f64> = fm.iter().map(|m| m.instantaneous_fps).collect();
        let smoother = SavgolSmoother { window: 21, polyorder: 3 };
        let fps_smooth = smoother.smooth(&fps_raw).unwrap_or(fps_raw);
        let report = Report {
            schema_version: 1,
            meta,
            summary,
            frames: fm,
            fps_smoothed: fps_smooth,
            tears: if self.tears.is_empty() { None } else { Some(self.tears.clone()) },
            resolution: None,
        };
        serde_json::to_string(&report).unwrap_or_else(|e| format!(r#"{{"error":"{e}"}}"#))
    }
}

#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

// ── Compare (case A) ──

fn err_json(msg: &str) -> String {
    format!(r#"{{"error":"{msg}"}}"#)
}

struct BufSource {
    frames: Vec<Frame>,
    meta: VideoMeta,
    pos: usize,
}

impl FrameDecoder for BufSource {
    fn metadata(&self) -> VideoMeta { self.meta.clone() }
    fn next_frame(&mut self) -> Option<Frame> {
        if self.pos < self.frames.len() {
            let f = self.frames[self.pos].clone();
            self.pos += 1;
            Some(f)
        } else {
            None
        }
    }
}

/// Compare two versions of the same clip (case A: before/after re-encoding).
///
/// Both buffers are concatenated RGB frames.
/// Matching is by timestamp, so different container FPS is fine.
#[wasm_bindgen]
pub fn compare_frames_wasm(
    data_a: Vec<u8>, width_a: u32, height_a: u32, fps_a: f64, count_a: usize,
    data_b: Vec<u8>, width_b: u32, height_b: u32, fps_b: f64, count_b: usize,
    metric: String, drift_ms: f64,
) -> String {
    let build = |data: Vec<u8>, w: u32, h: u32, fps: f64, n: usize| -> Result<(BufSource, VideoMeta), String> {
        let fs = (w * h * 3) as usize;
        if data.len() < fs * n {
            return Err(format!("buffer too short for {n} frames at {w}x{h}"));
        }
        let mut frames = Vec::with_capacity(n);
        for i in 0..n {
            let off = i * fs;
            let buf = PixelBuffer::new(data[off..off + fs].to_vec(), w, h)
                .map_err(|e| e.to_string())?;
            frames.push(Frame { data: buf, index: i as u64, timestamp_ms: i as f64 / fps * 1000.0 });
        }
        let meta = VideoMeta {
            fps, width: w, height: h,
            total_frames: frames.len() as u64,
            duration_ms: frames.len() as f64 / fps * 1000.0,
            codec: "browser".into(),
        };
        Ok((BufSource { frames, meta: meta.clone(), pos: 0 }, meta))
    };

    let (mut src_a, _) = match build(data_a, width_a, height_a, fps_a, count_a) {
        Ok(x) => x, Err(e) => return err_json(&e),
    };
    let (mut src_b, _) = match build(data_b, width_b, height_b, fps_b, count_b) {
        Ok(x) => x, Err(e) => return err_json(&e),
    };

    let spec = match metric_by_name(&metric) {
        Ok(s) => s,
        Err(e) => return err_json(&e.to_string()),
    };
    let cfg = DegradationConfig { max_time_drift_ms: if drift_ms > 0.0 { drift_ms } else { 16.0 } };

    let mut sink = NullSink;
    match compare_sources(&mut src_a, &mut src_b, spec.comparator.as_ref(), &cfg, &mut sink) {
        Ok(report) => serde_json::to_string(&report).unwrap_or_else(|e| err_json(&e.to_string())),
        Err(e) => err_json(&e.to_string()),
    }
}

// ── Heatmap (case A inspection) ──

use tva_core::degradation::diff_heatmap;

/// Grayscale per-pixel difference map for one frame pair.
#[wasm_bindgen]
pub fn diff_heatmap_wasm(a: Vec<u8>, b: Vec<u8>) -> Vec<u8> {
    diff_heatmap(&a, &b)
}
