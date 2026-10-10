//! Float to 16-bit PCM, and the `chunk` stream built on it (sections 4, 5.3).

use base64::engine::general_purpose::STANDARD;
use base64::Engine;

/// `trunc(clamp(x, -1, 1) * 32767)`, the one conversion the WAV writer and the
/// chunker share, so a recording's chunks equal its WAV byte for byte.
#[inline]
pub fn to_i16(sample: f32) -> i16 {
    if sample.is_nan() {
        return 0;
    }
    (sample.clamp(-1.0, 1.0) * 32767.0) as i16
}

/// The samples as a 16-bit WAV carries them: `to_i16`, read back as
/// `value / 32768`. The reference helper transcribed a recording by writing
/// that WAV and running whisper over the file, so this is what whisper heard,
/// and what it hears again when main sends the handed-over WAV back with
/// `transcribe-file`. Feeding whisper the same numbers keeps the local engine,
/// the reference and the fallback on the same text for the same recording.
pub fn as_wav_carries(samples: &[f32]) -> Vec<f32> {
    samples.iter().map(|s| f32::from(to_i16(*s)) / 32768.0).collect()
}

/// Little-endian PCM16 bytes.
pub fn pcm16_bytes(samples: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(samples.len() * 2);
    for s in samples {
        out.extend_from_slice(&to_i16(*s).to_le_bytes());
    }
    out
}

/// Remembers how much of a growing recording has been sent as chunks.
#[derive(Debug, Default)]
pub struct Chunker {
    sent: usize,
}

impl Chunker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Standard base64 of everything in `recording` not yet sent, or `None`
    /// when nothing new arrived (there is never an empty chunk).
    pub fn flush(&mut self, recording: &[f32]) -> Option<String> {
        if self.sent >= recording.len() {
            return None;
        }
        let b64 = STANDARD.encode(pcm16_bytes(&recording[self.sent..]));
        self.sent = recording.len();
        Some(b64)
    }
}

/// Strict standard base64 (padding required, no whitespace) of UTF-8 text, as
/// carried by `insert`. `None` for anything else, and for empty text.
pub fn decode_text(b64: &str) -> Option<String> {
    let bytes = STANDARD.decode(b64).ok()?;
    let text = String::from_utf8(bytes).ok()?;
    (!text.is_empty()).then_some(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_like_the_reference() {
        assert_eq!(to_i16(0.0), 0);
        assert_eq!(to_i16(1.0), 32767);
        assert_eq!(to_i16(-1.0), -32767);
        assert_eq!(to_i16(2.5), 32767);
        assert_eq!(to_i16(-7.0), -32767);
        // Truncation, not rounding.
        assert_eq!(to_i16(0.5), 16383);
        assert_eq!(to_i16(-0.5), -16383);
        assert_eq!(to_i16(f32::NAN), 0);
    }

    #[test]
    fn whisper_hears_what_the_wav_would_hold() {
        let samples = [0.0, 1.0, -1.0, 0.5, -0.5, 2.5, 0.000_01, f32::NAN];
        let heard = as_wav_carries(&samples);
        assert_eq!(heard, [0.0, 32767.0 / 32768.0, -32767.0 / 32768.0, 16383.0 / 32768.0, -16383.0 / 32768.0, 32767.0 / 32768.0, 0.0, 0.0]);
        // And it is exactly what reading the written WAV back gives.
        let bytes = pcm16_bytes(&samples);
        let read: Vec<f32> = bytes.chunks_exact(2).map(|b| f32::from(i16::from_le_bytes([b[0], b[1]])) / 32768.0).collect();
        assert_eq!(heard, read);
    }

    #[test]
    fn bytes_are_little_endian() {
        assert_eq!(pcm16_bytes(&[1.0, -1.0, 0.0]), vec![0xff, 0x7f, 0x01, 0x80, 0x00, 0x00]);
    }

    #[test]
    fn chunks_concatenate_to_the_whole_recording() {
        let recording: Vec<f32> = (0..5000).map(|n| ((n as f32) * 0.01).sin()).collect();
        let mut chunker = Chunker::new();
        let mut bytes = Vec::new();
        for end in [0, 1, 1, 1600, 3200, 3201, 5000, 5000] {
            match chunker.flush(&recording[..end]) {
                Some(b64) => {
                    assert!(!b64.is_empty());
                    bytes.extend(STANDARD.decode(b64).unwrap());
                }
                None => assert!(end == 0 || bytes.len() == end * 2),
            }
        }
        assert_eq!(bytes, pcm16_bytes(&recording));
    }

    #[test]
    fn insert_text_is_strict() {
        assert_eq!(decode_text("aGVsbG8K").as_deref(), Some("hello\n"));
        assert_eq!(decode_text("w6ljb3V0ZQ==").as_deref(), Some("écoute"));
        assert_eq!(decode_text(""), None);
        assert_eq!(decode_text("!!!"), None);
        assert_eq!(decode_text("aGVsbG8"), None); // padding is required
        assert_eq!(decode_text("aGVs bG8K"), None);
        assert_eq!(decode_text("/w=="), None); // 0xff is not UTF-8
    }
}
