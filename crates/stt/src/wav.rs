//! Port of `realtime/wav.ts`.

/// Wraps headerless PCM16 in a minimal 44-byte canonical WAV header.
///
/// The batch providers speak the OpenAI audio API, which takes a file rather
/// than a raw sample stream, so synthesis puts a header on the realtime PCM16
/// before every tick.
pub fn pcm16_to_wav(pcm: &[u8], sample_rate: u32, channels: u16) -> Vec<u8> {
    const BITS_PER_SAMPLE: u16 = 16;
    let block_align = channels * (BITS_PER_SAMPLE / 8);
    let byte_rate = sample_rate * u32::from(block_align);
    // A WAV chunk size is 32-bit; anything larger is clamped rather than wrapped.
    let data_len = u32::try_from(pcm.len()).unwrap_or(u32::MAX);

    let mut out = Vec::with_capacity(44 + pcm.len());
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&data_len.saturating_add(36).to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes()); // fmt chunk size for PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // audio format: PCM
    out.extend_from_slice(&channels.to_le_bytes());
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&byte_rate.to_le_bytes());
    out.extend_from_slice(&block_align.to_le_bytes());
    out.extend_from_slice(&BITS_PER_SAMPLE.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    out.extend_from_slice(pcm);
    out
}
