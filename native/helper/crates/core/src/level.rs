//! The loudness meter behind `level` and `mic-test-level` (section 5.5).

/// RMS of one buffer in dBFS (floor 1e-7), mapped so that -55 dBFS and below
/// is 0 and full scale is 1. An empty buffer is 0.
pub fn level(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum: f32 = samples.iter().map(|s| s * s).sum();
    let rms = (sum / samples.len() as f32).sqrt();
    let db = 20.0 * rms.max(1e-7).log10();
    let norm = (db + 55.0) / 55.0;
    if norm.is_finite() { norm.clamp(0.0, 1.0) } else { 0.0 }
}

/// Largest absolute sample: the silence check of section 5.3 reads this.
pub fn peak(samples: &[f32]) -> f32 {
    samples.iter().fold(0.0f32, |p, s| p.max(s.abs()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn silence_is_zero_and_full_scale_is_one() {
        assert_eq!(level(&[]), 0.0);
        assert_eq!(level(&[0.0; 160]), 0.0);
        assert_eq!(level(&[1.0; 160]), 1.0);
        assert_eq!(level(&[-1.0, 1.0, -1.0, 1.0]), 1.0);
    }

    #[test]
    fn maps_decibels_linearly() {
        // -27.5 dBFS is the middle of the meter.
        let amp = 10f32.powf(-27.5 / 20.0);
        assert!((level(&[amp; 512]) - 0.5).abs() < 1e-4);
        // -55 dBFS is the floor, anything quieter stays there.
        let floor = 10f32.powf(-55.0 / 20.0);
        assert!(level(&[floor; 512]) < 1e-4);
        assert_eq!(level(&[floor / 10.0; 512]), 0.0);
    }

    #[test]
    fn never_reports_nan() {
        assert_eq!(level(&[f32::NAN; 8]), 0.0);
        assert!(level(&[f32::INFINITY; 8]) <= 1.0);
    }

    #[test]
    fn peak_is_the_largest_magnitude() {
        assert_eq!(peak(&[]), 0.0);
        assert_eq!(peak(&[0.1, -0.7, 0.3]), 0.7);
    }
}
