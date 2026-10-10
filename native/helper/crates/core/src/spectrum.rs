//! The 28-band input meter (section 5.5), the same maths as the Swift
//! `Spectrum` class: 512-sample periodic Hann frames, bands spaced by pitch
//! from 90 Hz to 7.6 kHz, each band its loudest bin in dB relative to a
//! full-scale sine, mapped from -62 dB (empty) to -16 dB (full).

use std::sync::Arc;

use realfft::num_complex::Complex;
use realfft::{RealFftPlanner, RealToComplex};

pub const BANDS: usize = 28;
pub const FRAME: usize = 512;
pub const LOW_HZ: f64 = 90.0;
pub const HIGH_HZ: f64 = 7_600.0;
pub const FLOOR_DB: f32 = 62.0;
pub const RANGE_DB: f32 = 46.0;

/// One per capture. Not shared between a recording and a mic test.
pub struct Spectrum {
    fft: Arc<dyn RealToComplex<f32>>,
    window: Vec<f32>,
    pending: Vec<f32>,
    frame: Vec<f32>,
    bins: Vec<Complex<f32>>,
    scratch: Vec<Complex<f32>>,
    edges: [usize; BANDS + 1],
}

/// Band edges as FFT bin numbers; band `b` covers `edges[b]..edges[b + 1]`.
pub fn band_edges() -> [usize; BANDS + 1] {
    let mut edges = [0usize; BANDS + 1];
    for (i, edge) in edges.iter_mut().enumerate() {
        let hz = LOW_HZ * (HIGH_HZ / LOW_HZ).powf(i as f64 / BANDS as f64);
        *edge = (hz * FRAME as f64 / f64::from(crate::SAMPLE_RATE)).round() as usize;
    }
    for i in 1..edges.len() {
        if edges[i] <= edges[i - 1] {
            edges[i] = edges[i - 1] + 1;
        }
    }
    edges
}

impl Default for Spectrum {
    fn default() -> Self {
        Self::new()
    }
}

impl Spectrum {
    pub fn new() -> Self {
        let fft = RealFftPlanner::<f32>::new().plan_fft_forward(FRAME);
        let window = (0..FRAME)
            .map(|n| (0.5 * (1.0 - (2.0 * std::f64::consts::PI * n as f64 / FRAME as f64).cos())) as f32)
            .collect();
        Self {
            bins: fft.make_output_vec(),
            scratch: fft.make_scratch_vec(),
            frame: vec![0.0; FRAME],
            pending: Vec::with_capacity(FRAME * 4),
            window,
            edges: band_edges(),
            fft,
        }
    }

    /// Takes one capture buffer (16 kHz mono). Returns the bands once at least
    /// 512 samples are pending: the newest 512 are analysed and everything
    /// pending is dropped, so frames never overlap and one buffer gives at
    /// most one frame.
    pub fn feed(&mut self, samples: &[f32]) -> Option<Vec<f32>> {
        self.pending.extend_from_slice(samples);
        if self.pending.len() < FRAME {
            return None;
        }
        let newest = &self.pending[self.pending.len() - FRAME..];
        for ((out, sample), w) in self.frame.iter_mut().zip(newest).zip(&self.window) {
            *out = sample * w;
        }
        self.pending.clear();
        if self.fft.process_with_scratch(&mut self.frame, &mut self.bins, &mut self.scratch).is_err() {
            return None;
        }

        // An unscaled DFT of a full-scale sine through this window peaks at
        // FRAME / 4, so that power is the 0 dB reference.
        let reference = (FRAME as f32 / 4.0) * (FRAME as f32 / 4.0);
        let half = FRAME / 2;
        let mut bands = Vec::with_capacity(BANDS);
        for band in 0..BANDS {
            let from = self.edges[band].min(half - 1);
            let to = self.edges[band + 1].max(from + 1).min(half);
            let peak = self.bins[from..to].iter().fold(0.0f32, |p, c| p.max(c.norm_sqr()));
            let db = 10.0 * (peak / reference).max(1e-12).log10();
            let value = (db + FLOOR_DB) / RANGE_DB;
            bands.push(if value.is_finite() { value.clamp(0.0, 1.0) } else { 0.0 });
        }
        Some(bands)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(hz: f32, amplitude: f32, count: usize) -> Vec<f32> {
        (0..count).map(|n| amplitude * (2.0 * std::f32::consts::PI * hz * n as f32 / 16_000.0).sin()).collect()
    }

    fn band_of(bin: usize) -> usize {
        let edges = band_edges();
        (0..BANDS).find(|&b| edges[b] <= bin && bin < edges[b + 1]).unwrap()
    }

    #[test]
    fn edges_match_the_documented_bins() {
        assert_eq!(
            band_edges(),
            [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16, 19, 23, 26, 31, 36, 43, 50, 58, 68, 80, 94, 110, 129, 151,
             177, 208, 243]
        );
    }

    #[test]
    fn needs_a_full_frame() {
        let mut s = Spectrum::new();
        assert!(s.feed(&[0.1; 300]).is_none());
        assert!(s.feed(&[0.1; 211]).is_none());
        assert_eq!(s.feed(&[0.1; 1]).map(|b| b.len()), Some(BANDS));
        // Everything pending was dropped with that frame.
        assert!(s.feed(&[0.1; 511]).is_none());
    }

    #[test]
    fn one_buffer_gives_at_most_one_frame() {
        let mut s = Spectrum::new();
        assert!(s.feed(&[0.0; 4096]).is_some());
        assert!(s.feed(&[0.0; 100]).is_none());
    }

    #[test]
    fn silence_is_empty() {
        let mut s = Spectrum::new();
        assert_eq!(s.feed(&[0.0; FRAME]).unwrap(), vec![0.0; BANDS]);
    }

    #[test]
    fn a_full_scale_tone_is_zero_decibels() {
        // 1 kHz sits exactly on bin 32, so nothing leaks beyond its neighbours.
        let mut s = Spectrum::new();
        let bands = s.feed(&sine(1000.0, 1.0, FRAME)).unwrap();
        let hit = band_of(32);
        assert_eq!(bands[hit], 1.0);
        // The Hann window puts half the amplitude (-6 dB) in bins 31 and 33.
        let far: Vec<f32> = bands.iter().enumerate().filter(|(b, _)| b.abs_diff(hit) > 1).map(|(_, v)| *v).collect();
        assert!(far.iter().all(|v| *v == 0.0), "{bands:?}");
    }

    #[test]
    fn a_tenth_of_full_scale_is_minus_twenty() {
        let mut s = Spectrum::new();
        let bands = s.feed(&sine(1000.0, 0.1, FRAME)).unwrap();
        let expected = (-20.0 + FLOOR_DB) / RANGE_DB;
        assert!((bands[band_of(32)] - expected).abs() < 1e-3, "{} vs {expected}", bands[band_of(32)]);
    }

    #[test]
    fn the_floor_is_minus_sixty_two() {
        let mut s = Spectrum::new();
        let just_above = s.feed(&sine(1000.0, 10f32.powf(-60.0 / 20.0), FRAME)).unwrap();
        assert!(just_above[band_of(32)] > 0.0 && just_above[band_of(32)] < 0.06);
        let below = s.feed(&sine(1000.0, 10f32.powf(-64.0 / 20.0), FRAME)).unwrap();
        assert_eq!(below[band_of(32)], 0.0);
    }

    #[test]
    fn uses_the_newest_samples() {
        let mut s = Spectrum::new();
        let mut buffer = sine(1000.0, 1.0, FRAME);
        buffer.extend(std::iter::repeat_n(0.0, FRAME));
        assert_eq!(s.feed(&buffer).unwrap(), vec![0.0; BANDS]);
    }

    #[test]
    fn low_and_high_tones_land_in_the_outer_bands() {
        let mut s = Spectrum::new();
        let low = s.feed(&sine(93.75, 1.0, FRAME)).unwrap(); // bin 3
        assert_eq!(low[0], 1.0);
        let high = s.feed(&sine(7500.0, 1.0, FRAME)).unwrap(); // bin 240
        assert_eq!(high[BANDS - 1], 1.0);
        assert_eq!(high[0], 0.0);
    }
}
