//! The completion chime (chat.js playDoneChime): A5, then E6 with a quiet A6
//! over it, each a sine with a fast attack and an exponential fade. Rendered
//! once to a WAV and played with afplay, so no audio stack is linked in.

use std::path::PathBuf;
use std::sync::OnceLock;

const RATE: u32 = 44_100;

fn render() -> Vec<i16> {
    let notes = [(880.0_f32, 0.0_f32, 0.55_f32, 0.12_f32), (1318.5, 0.09, 0.7, 0.1), (1760.0, 0.09, 0.45, 0.025)];
    let lead = 0.02;
    let total = lead + 0.09 + 0.7 + 0.15;
    let len = (total * RATE as f32) as usize;
    let mut out = vec![0f32; len];
    for (freq, at, dur, peak) in notes {
        let start = lead + at;
        for (i, sample) in out.iter_mut().enumerate() {
            let t = i as f32 / RATE as f32 - start;
            if t < 0. || t > dur + 0.1 {
                continue;
            }
            // exponentialRampToValueAtTime from 0.0001: up to the peak in
            // 20ms, then down to 0.0001 by `dur`.
            let gain = if t < 0.02 {
                0.0001 * (peak / 0.0001_f32).powf(t / 0.02)
            } else if t < dur {
                peak * (0.0001 / peak).powf((t - 0.02) / (dur - 0.02))
            } else {
                0.0001
            };
            *sample += (2. * std::f32::consts::PI * freq * t).sin() * gain;
        }
    }
    out.iter().map(|s| (s * 0.5 * i16::MAX as f32).clamp(i16::MIN as f32, i16::MAX as f32) as i16).collect()
}

fn wav(samples: &[i16]) -> Vec<u8> {
    let data = samples.len() as u32 * 2;
    let mut b = Vec::with_capacity(44 + data as usize);
    b.extend_from_slice(b"RIFF");
    b.extend_from_slice(&(36 + data).to_le_bytes());
    b.extend_from_slice(b"WAVEfmt ");
    b.extend_from_slice(&16u32.to_le_bytes());
    b.extend_from_slice(&1u16.to_le_bytes());
    b.extend_from_slice(&1u16.to_le_bytes());
    b.extend_from_slice(&RATE.to_le_bytes());
    b.extend_from_slice(&(RATE * 2).to_le_bytes());
    b.extend_from_slice(&2u16.to_le_bytes());
    b.extend_from_slice(&16u16.to_le_bytes());
    b.extend_from_slice(b"data");
    b.extend_from_slice(&data.to_le_bytes());
    for s in samples {
        b.extend_from_slice(&s.to_le_bytes());
    }
    b
}

fn chime_file() -> Option<PathBuf> {
    static FILE: OnceLock<Option<PathBuf>> = OnceLock::new();
    FILE.get_or_init(|| {
        let path = std::env::temp_dir().join("lizard-studio-chime.wav");
        std::fs::write(&path, wav(&render())).ok().map(|_| path)
    })
    .clone()
}

pub fn play_chime() {
    std::thread::spawn(|| {
        if let Some(path) = chime_file() {
            let _ = std::process::Command::new("/usr/bin/afplay").arg(path).status();
        }
    });
}
