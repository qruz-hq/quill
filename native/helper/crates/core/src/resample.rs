//! Any capture format to 16 kHz mono floats (section 5.1).
//!
//! A streaming windowed-sinc resampler: no dependency, any integer input rate,
//! and the same output whether the input arrives in one piece or in callback
//! sized buffers, because every output sample is placed on an exact rational
//! position in the input stream.

/// Zero crossings of the sinc on each side of its centre.
const ZERO_CROSSINGS: f64 = 24.0;
/// Pass band edge as a fraction of the lower of the two Nyquist frequencies.
const CUTOFF: f64 = 0.90;
/// Kernel table steps per input sample.
const TABLE_STEPS: usize = 256;

/// Averages interleaved frames down to one channel.
pub fn downmix(interleaved: &[f32], channels: u16) -> Vec<f32> {
    let channels = usize::from(channels.max(1));
    if channels == 1 {
        return interleaved.to_vec();
    }
    interleaved.chunks_exact(channels).map(|frame| frame.iter().sum::<f32>() / channels as f32).collect()
}

/// Mono in, mono out, from `in_rate` to `out_rate`.
pub struct Resampler {
    in_rate: u64,
    out_rate: u64,
    /// Kernel half width in input samples.
    half: usize,
    /// `kernel(x)` for x from 0 to `half`, `TABLE_STEPS` per input sample.
    table: Vec<f32>,
    /// Input samples from absolute index `base` on. Index 0 of the stream is
    /// preceded by `half` zeros, so `base` starts negative.
    buffer: Vec<f32>,
    base: i64,
    /// Number of output samples produced so far.
    produced: u64,
}

impl Resampler {
    pub fn new(in_rate: u32, out_rate: u32) -> Self {
        let in_rate = u64::from(in_rate.max(1));
        let out_rate = u64::from(out_rate.max(1));
        let passthrough = in_rate == out_rate;
        // Cut below whichever Nyquist is lower: the output's when going down.
        let fc = CUTOFF * (out_rate as f64 / in_rate as f64).min(1.0);
        let half = if passthrough { 0 } else { (ZERO_CROSSINGS / fc).ceil() as usize };
        let mut table = Vec::new();
        if !passthrough {
            let len = half * TABLE_STEPS + 2;
            table.reserve(len);
            for i in 0..len {
                let x = i as f64 / TABLE_STEPS as f64;
                table.push(kernel(x, fc, half as f64) as f32);
            }
        }
        Self { in_rate, out_rate, half, table, buffer: vec![0.0; half], base: -(half as i64), produced: 0 }
    }

    /// To the helper's 16 kHz.
    pub fn to_16k(in_rate: u32) -> Self {
        Self::new(in_rate, crate::SAMPLE_RATE)
    }

    pub fn is_passthrough(&self) -> bool {
        self.in_rate == self.out_rate
    }

    /// Feeds input and appends whatever output is now computable to `out`. The
    /// last `half` input samples wait for their successors; [`flush`] ends the
    /// stream.
    ///
    /// [`flush`]: Resampler::flush
    pub fn process(&mut self, input: &[f32], out: &mut Vec<f32>) {
        if self.is_passthrough() {
            out.extend_from_slice(input);
            return;
        }
        self.buffer.extend_from_slice(input);
        let available = self.base + self.buffer.len() as i64; // one past the newest input index
        let half = self.half as i64;
        loop {
            // Output n sits at input position n * in / out, kept exact.
            let num = self.produced * self.in_rate;
            let whole = (num / self.out_rate) as i64;
            if whole + half + 1 > available {
                break;
            }
            let frac = (num % self.out_rate) as f64 / self.out_rate as f64;
            let first = whole - half + 1; // leftmost input under the kernel
            let offset = (first - self.base) as usize;
            let taps = &self.buffer[offset..offset + 2 * self.half];
            let mut acc = 0.0f32;
            for (j, sample) in taps.iter().enumerate() {
                // Distance from the output position to this input sample.
                let distance = (frac - (first + j as i64 - whole) as f64).abs();
                let at = distance * TABLE_STEPS as f64;
                let i = at as usize;
                let t = (at - i as f64) as f32;
                let k = self.table[i] + (self.table[i + 1] - self.table[i]) * t;
                acc += sample * k;
            }
            out.push(acc);
            self.produced += 1;
        }
        // Forget input that no later output can reach.
        let next_whole = (self.produced * self.in_rate / self.out_rate) as i64;
        let keep_from = (next_whole - half + 1).max(self.base);
        let drop = (keep_from - self.base) as usize;
        if drop > 0 {
            self.buffer.drain(..drop.min(self.buffer.len()));
            self.base += drop as i64;
        }
    }

    /// Ends the stream: the tail that was waiting for more input comes out.
    pub fn flush(&mut self, out: &mut Vec<f32>) {
        if self.is_passthrough() {
            return;
        }
        let padding = vec![0.0; self.half + 1];
        self.process(&padding, out);
    }
}

/// Blackman-windowed sinc with unity gain at DC.
fn kernel(x: f64, fc: f64, half: f64) -> f64 {
    if x >= half {
        return 0.0;
    }
    let sinc = if x.abs() < 1e-9 { 1.0 } else { (std::f64::consts::PI * fc * x).sin() / (std::f64::consts::PI * fc * x) };
    let w = std::f64::consts::PI * x / half;
    let window = 0.42 + 0.5 * w.cos() + 0.08 * (2.0 * w).cos();
    fc * sinc * window
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(hz: f64, rate: u32, count: usize) -> Vec<f32> {
        (0..count).map(|n| (2.0 * std::f64::consts::PI * hz * n as f64 / f64::from(rate)).sin() as f32).collect()
    }

    fn rms(samples: &[f32]) -> f64 {
        (samples.iter().map(|s| f64::from(*s) * f64::from(*s)).sum::<f64>() / samples.len() as f64).sqrt()
    }

    fn convert(input: &[f32], rate: u32) -> Vec<f32> {
        let mut r = Resampler::to_16k(rate);
        let mut out = Vec::new();
        r.process(input, &mut out);
        r.flush(&mut out);
        out
    }

    #[test]
    fn sixteen_kilohertz_passes_through_untouched() {
        let input = sine(440.0, 16_000, 1000);
        let mut r = Resampler::to_16k(16_000);
        assert!(r.is_passthrough());
        let mut out = Vec::new();
        r.process(&input[..300], &mut out);
        r.process(&input[300..], &mut out);
        r.flush(&mut out);
        assert_eq!(out, input);
    }

    #[test]
    fn output_length_follows_the_ratio() {
        for rate in [8_000u32, 22_050, 44_100, 48_000, 96_000] {
            let out = convert(&vec![0.0; rate as usize], rate);
            let off = out.len() as i64 - 16_000;
            assert!(off.abs() <= 2, "{rate} Hz gave {} samples", out.len());
        }
    }

    #[test]
    fn keeps_the_level_and_pitch_of_a_voice_band_tone() {
        for rate in [8_000u32, 44_100, 48_000] {
            for hz in [200.0, 1000.0, 3000.0] {
                let out = convert(&sine(hz, rate, rate as usize), rate);
                // Skip the edges, where the kernel hangs over the ends.
                let body = &out[800..out.len() - 800];
                assert!((rms(body) - std::f64::consts::FRAC_1_SQRT_2).abs() < 0.01, "{hz} Hz at {rate}: {}", rms(body));
                // Same tone generated at 16 kHz directly: sample for sample.
                let expected = sine(hz, 16_000, out.len());
                let worst = body.iter().zip(&expected[800..]).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
                assert!(worst < 0.01, "{hz} Hz at {rate}: off by {worst}");
            }
        }
    }

    #[test]
    fn rejects_what_would_alias() {
        // 12 kHz cannot exist at 16 kHz; unfiltered it would fold down to 4 kHz.
        let out = convert(&sine(12_000.0, 48_000, 48_000), 48_000);
        let body = &out[800..out.len() - 800];
        assert!(rms(body) < 0.002, "alias at {}", rms(body));
        let out = convert(&sine(15_000.0, 44_100, 44_100), 44_100);
        assert!(rms(&out[800..out.len() - 800]) < 0.002);
    }

    #[test]
    fn buffer_sizes_do_not_change_the_result() {
        let input = sine(700.0, 44_100, 44_100);
        let whole = convert(&input, 44_100);
        for size in [1usize, 7, 441, 1024, 4096] {
            let mut r = Resampler::to_16k(44_100);
            let mut out = Vec::new();
            for piece in input.chunks(size) {
                r.process(piece, &mut out);
            }
            r.flush(&mut out);
            assert_eq!(out, whole, "buffers of {size}");
        }
    }

    #[test]
    fn memory_stays_bounded() {
        let mut r = Resampler::to_16k(48_000);
        let mut out = Vec::new();
        for _ in 0..200 {
            r.process(&[0.1; 480], &mut out);
            out.clear();
        }
        assert!(r.buffer.len() < 2 * r.half + 480 + 8, "kept {}", r.buffer.len());
    }

    #[test]
    fn downmix_averages_frames() {
        assert_eq!(downmix(&[1.0, 0.0, 0.5, 0.5, -1.0, 1.0], 2), vec![0.5, 0.5, 0.0]);
        assert_eq!(downmix(&[0.3, 0.6], 1), vec![0.3, 0.6]);
        assert_eq!(downmix(&[0.25, 0.5, 0.75, 1.0], 3), vec![0.5]); // a trailing partial frame is dropped
    }
}
