#![forbid(unsafe_code)]

use tva_core::{
    adapters::image_compare::SsimComparator,
    adapters::savgol::SavgolSmoother,
    config::PipelineConfig,
    detect::{self, DedupState, TearInfo},
    frame::{Frame, VideoMeta},
    metrics::{compute_frame_metrics, compute_summary},
    pixel_buffer::PixelBuffer,
    report::Report,
    traits::FrameComparator,
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
        let summary = compute_summary(&fm, self.tears.len() as u64);
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
