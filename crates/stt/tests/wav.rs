//! Port of tests/services/transcription/wav.test.ts.

use whispera_stt::pcm16_to_wav;

struct Parsed {
    sample_rate: u32,
    channels: u16,
    data: Vec<u8>,
}

fn u16_le(b: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([b[at], b[at + 1]])
}

fn u32_le(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}

/// Mirrors the chunk-walk the e2e fixture reader uses.
fn read_back(buffer: &[u8]) -> Parsed {
    let mut offset = 12;
    let (mut sample_rate, mut channels, mut data) = (0, 0, None);
    while offset + 8 <= buffer.len() {
        let id = &buffer[offset..offset + 4];
        let size = u32_le(buffer, offset + 4) as usize;
        let end = (offset + 8 + size).min(buffer.len());
        let body = &buffer[offset + 8..end];
        if id == b"fmt " {
            channels = u16_le(body, 2);
            sample_rate = u32_le(body, 4);
        }
        if id == b"data" {
            data = Some(body.to_vec());
        }
        offset += 8 + size + (size % 2);
    }
    Parsed {
        sample_rate,
        channels,
        data: data.expect("no data chunk found"),
    }
}

fn pcm(samples: &[i16]) -> Vec<u8> {
    samples.iter().flat_map(|s| s.to_le_bytes()).collect()
}

#[test]
fn produces_a_44_byte_header_followed_by_the_pcm_verbatim() {
    let pcm = pcm(&[1, -1, 32767, -32768]);
    let wav = pcm16_to_wav(&pcm, 24_000, 1);

    assert_eq!(wav.len(), 44 + pcm.len());
    assert_eq!(&wav[0..4], b"RIFF");
    assert_eq!(&wav[8..12], b"WAVE");
    assert_eq!(&wav[44..], &pcm[..]);
}

#[test]
fn round_trips_sample_rate_channel_count_and_the_audio_bytes() {
    let pcm = pcm(&[100, 200, 300, 400]);
    let parsed = read_back(&pcm16_to_wav(&pcm, 24_000, 1));

    assert_eq!(parsed.sample_rate, 24_000);
    assert_eq!(parsed.channels, 1);
    assert_eq!(parsed.data, pcm);
}

#[test]
fn handles_an_empty_buffer_without_producing_a_malformed_header() {
    let wav = pcm16_to_wav(&[], 24_000, 1);

    assert_eq!(wav.len(), 44);
    assert!(read_back(&wav).data.is_empty());
}
