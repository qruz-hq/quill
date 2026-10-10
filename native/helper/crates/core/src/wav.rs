//! The WAV file an `audio` event hands over, and reading one back for
//! `transcribe-file` (sections 2.2, 4).

use std::io;
use std::path::Path;

use crate::pcm::to_i16;

/// A canonical 16-bit mono PCM WAV: the plain 44-byte header, format tag 1.
pub fn encode(samples: &[f32], rate: u32) -> Vec<u8> {
    let data_bytes = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + samples.len() * 2);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_bytes).to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&(rate * 2).to_le_bytes()); // byte rate
    out.extend_from_slice(&2u16.to_le_bytes()); // block align
    out.extend_from_slice(&16u16.to_le_bytes()); // bits
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_bytes.to_le_bytes());
    for s in samples {
        out.extend_from_slice(&to_i16(*s).to_le_bytes());
    }
    out
}

pub fn write(path: &Path, samples: &[f32], rate: u32) -> io::Result<()> {
    std::fs::write(path, encode(samples, rate))
}

/// Decoded audio, downmixed to mono, at the file's own rate.
#[derive(Debug, Clone, PartialEq)]
pub struct Audio {
    pub rate: u32,
    pub channels: u16,
    pub samples: Vec<f32>,
}

#[derive(Debug, thiserror::Error)]
pub enum WavError {
    #[error("{0}")]
    Io(#[from] io::Error),
    #[error("not a RIFF/WAVE file")]
    NotWav,
    #[error("no fmt chunk before the data")]
    NoFormat,
    #[error("no data chunk")]
    NoData,
    #[error("unsupported WAV encoding (format {format}, {bits} bit)")]
    Unsupported { format: u16, bits: u16 },
}

pub fn read(path: &Path) -> Result<Audio, WavError> {
    decode(&std::fs::read(path)?)
}

/// Reads integer PCM (8, 16, 24, 32 bit) and 32-bit float, any channel count.
/// Unknown chunks are skipped; a data chunk longer than the file is cut short.
pub fn decode(bytes: &[u8]) -> Result<Audio, WavError> {
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(WavError::NotWav);
    }
    let u16_at = |at: usize| u16::from_le_bytes([bytes[at], bytes[at + 1]]);
    let u32_at = |at: usize| u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]]);

    let mut format: Option<(u16, u16, u32, u16)> = None; // tag, channels, rate, bits
    let mut at = 12;
    while at + 8 <= bytes.len() {
        let id = &bytes[at..at + 4];
        let size = u32_at(at + 4) as usize;
        let body = at + 8;
        if id == b"fmt " {
            if size < 16 || body + 16 > bytes.len() {
                return Err(WavError::NotWav);
            }
            let mut tag = u16_at(body);
            // WAVE_FORMAT_EXTENSIBLE keeps the real tag in the sub-format GUID.
            if tag == 0xfffe && size >= 26 && body + 26 <= bytes.len() {
                tag = u16_at(body + 24);
            }
            format = Some((tag, u16_at(body + 2), u32_at(body + 4), u16_at(body + 14)));
        } else if id == b"data" {
            let (tag, channels, rate, bits) = format.ok_or(WavError::NoFormat)?;
            let end = body.saturating_add(size).min(bytes.len());
            let samples = decode_samples(&bytes[body..end], tag, bits)?;
            let channels = channels.max(1);
            return Ok(Audio { rate, channels, samples: crate::resample::downmix(&samples, channels) });
        }
        at = body.saturating_add(size).saturating_add(size % 2);
    }
    Err(WavError::NoData)
}

fn decode_samples(data: &[u8], tag: u16, bits: u16) -> Result<Vec<f32>, WavError> {
    Ok(match (tag, bits) {
        (1, 8) => data.iter().map(|b| (f32::from(*b) - 128.0) / 128.0).collect(),
        (1, 16) => data.chunks_exact(2).map(|b| f32::from(i16::from_le_bytes([b[0], b[1]])) / 32768.0).collect(),
        (1, 24) => data
            .chunks_exact(3)
            .map(|b| (i32::from_le_bytes([0, b[0], b[1], b[2]]) >> 8) as f32 / 8_388_608.0)
            .collect(),
        (1, 32) => data
            .chunks_exact(4)
            .map(|b| i32::from_le_bytes([b[0], b[1], b[2], b[3]]) as f32 / 2_147_483_648.0)
            .collect(),
        (3, 32) => data.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect(),
        (format, bits) => return Err(WavError::Unsupported { format, bits }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_is_the_plain_forty_four_bytes() {
        let wav = encode(&[0.0, 1.0, -1.0], 16_000);
        assert_eq!(wav.len(), 44 + 6);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(u32::from_le_bytes(wav[4..8].try_into().unwrap()), 36 + 6);
        assert_eq!(&wav[8..16], b"WAVEfmt ");
        assert_eq!(u32::from_le_bytes(wav[16..20].try_into().unwrap()), 16);
        assert_eq!(u16::from_le_bytes(wav[20..22].try_into().unwrap()), 1);
        assert_eq!(u16::from_le_bytes(wav[22..24].try_into().unwrap()), 1);
        assert_eq!(u32::from_le_bytes(wav[24..28].try_into().unwrap()), 16_000);
        assert_eq!(u32::from_le_bytes(wav[28..32].try_into().unwrap()), 32_000);
        assert_eq!(u16::from_le_bytes(wav[32..34].try_into().unwrap()), 2);
        assert_eq!(u16::from_le_bytes(wav[34..36].try_into().unwrap()), 16);
        assert_eq!(&wav[36..40], b"data");
        assert_eq!(u32::from_le_bytes(wav[40..44].try_into().unwrap()), 6);
        assert_eq!(&wav[44..], &crate::pcm::pcm16_bytes(&[0.0, 1.0, -1.0])[..]);
    }

    #[test]
    fn round_trips_within_one_step() {
        let samples: Vec<f32> = (0..1000).map(|n| ((n as f32) * 0.05).sin() * 0.8).collect();
        let audio = decode(&encode(&samples, 16_000)).unwrap();
        assert_eq!((audio.rate, audio.channels, audio.samples.len()), (16_000, 1, 1000));
        for (a, b) in samples.iter().zip(&audio.samples) {
            assert!((a - b).abs() < 1.0 / 16_000.0);
        }
    }

    #[test]
    fn writes_and_reads_a_file() {
        let path = std::env::temp_dir().join(format!("quill-core-test-{}.wav", uuid::Uuid::new_v4()));
        write(&path, &[0.25; 320], 16_000).unwrap();
        let audio = read(&path).unwrap();
        std::fs::remove_file(&path).unwrap();
        assert_eq!(audio.samples.len(), 320);
        assert!(matches!(read(&path), Err(WavError::Io(_))));
    }

    #[test]
    fn skips_unknown_chunks_and_downmixes_stereo() {
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF\0\0\0\0WAVE");
        wav.extend_from_slice(b"LIST\x03\0\0\0abc\0"); // odd size, padded
        wav.extend_from_slice(b"fmt \x10\0\0\0");
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&44_100u32.to_le_bytes());
        wav.extend_from_slice(&(44_100u32 * 4).to_le_bytes());
        wav.extend_from_slice(&4u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data\x08\0\0\0");
        for v in [16384i16, 0, -16384, -16384] {
            wav.extend_from_slice(&v.to_le_bytes());
        }
        let audio = decode(&wav).unwrap();
        assert_eq!((audio.rate, audio.channels), (44_100, 2));
        assert_eq!(audio.samples, vec![0.25, -0.5]);
    }

    #[test]
    fn reads_float_and_rejects_the_rest() {
        let mut wav = encode(&[], 16_000);
        wav[20] = 3; // IEEE float
        wav[34] = 32;
        wav.extend_from_slice(&0.5f32.to_le_bytes());
        wav[40] = 4;
        assert_eq!(decode(&wav).unwrap().samples, vec![0.5]);
        wav[20] = 7; // mu-law
        assert!(matches!(decode(&wav), Err(WavError::Unsupported { format: 7, .. })));
    }

    #[test]
    fn rejects_what_is_not_a_wav() {
        assert!(matches!(decode(b""), Err(WavError::NotWav)));
        assert!(matches!(decode(b"FORM\0\0\0\0AIFF junk junk"), Err(WavError::NotWav)));
        assert!(matches!(decode(b"RIFF\0\0\0\0WAVE"), Err(WavError::NoData)));
        assert!(matches!(decode(b"RIFF\0\0\0\0WAVEdata\x02\0\0\0\0\0"), Err(WavError::NoFormat)));
    }

    #[test]
    fn a_truncated_data_chunk_is_cut_short() {
        let mut wav = encode(&[0.5; 10], 16_000);
        wav.truncate(44 + 7);
        assert_eq!(decode(&wav).unwrap().samples.len(), 3);
    }
}
