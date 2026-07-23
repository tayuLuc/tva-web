#![forbid(unsafe_code)]

use tva_core::{
    adapters::image_compare::SsimComparator,
    config::PipelineConfig,
    events::NullSink,
    frame::{Frame, VideoMeta},
    pixel_buffer::PixelBuffer,
    pipeline,
    traits::{FrameDecoder, Smoother},
};
use wasm_bindgen::prelude::*;

struct BufSource {
    frames: Vec<Frame>,
    meta: VideoMeta,
    index: usize,
}

impl FrameDecoder for BufSource {
    fn metadata(&self) -> VideoMeta {
        self.meta.clone()
    }
    fn next_frame(&mut self) -> Option<Frame> {
        let frame = self.frames.get(self.index)?.clone();
        self.index += 1;
        Some(frame)
    }
}

#[wasm_bindgen]
pub fn analyze_frames(
    data: Vec<u8>,
    width: u32,
    height: u32,
    frame_count: usize,
    fps: f64,
    threshold: f64,
) -> String {
    let frame_size = (width * height * 3) as usize;
    if data.len() < frame_size * frame_count {
        return err_json(&format!(
            "data too short: expected {} bytes, got {}",
            frame_size * frame_count,
            data.len()
        ));
    }

    let mut frames = Vec::with_capacity(frame_count);
    for i in 0..frame_count {
        let off = i * frame_size;
        let buf = match PixelBuffer::new(data[off..off + frame_size].to_vec(), width, height) {
            Ok(b) => b,
            Err(e) => return err_json(&e.to_string()),
        };
        frames.push(Frame {
            data: buf,
            index: i as u64,
            timestamp_ms: i as f64 / fps * 1000.0,
        });
    }

    let meta = VideoMeta {
        fps,
        width,
        height,
        total_frames: frames.len() as u64,
        duration_ms: frames.len() as f64 / fps * 1000.0,
        codec: "browser".into(),
    };

    let mut source = BufSource { frames, meta, index: 0 };
    let comparator = SsimComparator;

    let smoother: Box<dyn Smoother> = Box::new(
        tva_core::adapters::savgol::SavgolSmoother { window: 21, polyorder: 3 },
    );

    let config = PipelineConfig {
        duplicate_threshold: threshold,
        detect_tears: true,
        ..Default::default()
    };

    let mut sink = NullSink;
    match pipeline::analyze(&mut source, &config, &comparator, smoother.as_ref(), &mut sink) {
        Ok(report) => serde_json::to_string(&report).unwrap_or_else(|e| err_json(&e.to_string())),
        Err(e) => err_json(&e.to_string()),
    }
}

#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

fn err_json(msg: &str) -> String {
    format!(r#"{{"error":"{}"}}"#, msg.replace('"', "'"))
}
