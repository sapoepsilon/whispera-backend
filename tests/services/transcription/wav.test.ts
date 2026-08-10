import { describe, it, expect } from 'vitest';

import { pcm16ToWav } from '../../../src/services/transcription/realtime/wav.js';

/** Mirrors the chunk-walk the e2e fixture reader uses, so both agree on the format. */
function readBack(buffer: Buffer): { sampleRate: number; channels: number; data: Buffer } {
  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let data: Buffer | undefined;

  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = buffer.subarray(offset + 8, offset + 8 + size);

    if (id === 'fmt ') {
      channels = body.readUInt16LE(2);
      sampleRate = body.readUInt32LE(4);
    }
    if (id === 'data') data = body;

    offset += 8 + size + (size % 2);
  }

  if (!data) throw new Error('no data chunk found');
  return { sampleRate, channels, data };
}

describe('pcm16ToWav', () => {
  it('produces a 44-byte header followed by the PCM verbatim', () => {
    const pcm = Buffer.from(Int16Array.from([1, -1, 32767, -32768]).buffer);
    const wav = pcm16ToWav(pcm, 24_000, 1);

    expect(wav.length).toBe(44 + pcm.length);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.subarray(44)).toEqual(pcm);
  });

  it('round-trips sample rate, channel count and the audio bytes', () => {
    const pcm = Buffer.from(Int16Array.from([100, 200, 300, 400]).buffer);
    const wav = pcm16ToWav(pcm, 24_000, 1);

    const parsed = readBack(wav);
    expect(parsed.sampleRate).toBe(24_000);
    expect(parsed.channels).toBe(1);
    expect(parsed.data).toEqual(pcm);
  });

  it('handles an empty buffer without producing a malformed header', () => {
    const wav = pcm16ToWav(Buffer.alloc(0), 24_000, 1);

    expect(wav.length).toBe(44);
    expect(readBack(wav).data.length).toBe(0);
  });
});
