import { experimental_transcribe as transcribe } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';

const SUPPORTED_MIMETYPES = new Set([
  'audio/wav',
  'audio/x-wav',
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4',
  'audio/x-m4a',
  'audio/m4a',
  'audio/webm',
  'audio/ogg',
]);

const MIMETYPE_TO_EXT: Record<string, string> = {
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'mp4',
  'audio/x-m4a': 'm4a',
  'audio/m4a': 'm4a',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
};

export interface TranscriptionResult {
  text: string;
  language: string;
  duration: number;
  provider: string;
}

export class TranscriptionService {
  isSupportedMimetype(mimetype: string): boolean {
    return SUPPORTED_MIMETYPES.has(mimetype);
  }

  async transcribe(
    buffer: Buffer,
    mimetype: string,
    language?: string,
  ): Promise<TranscriptionResult> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY environment variable is required for transcription');
    }

    const openai = createOpenAI({ apiKey });

    const result = await transcribe({
      model: openai.transcription('whisper-1'),
      audio: new Uint8Array(buffer),
      ...(language
        ? { providerOptions: { openai: { language } } }
        : {}),
    });

    return {
      text: result.text,
      language: result.language ?? language ?? 'en',
      duration: result.durationInSeconds ?? 0,
      provider: 'openai-whisper',
    };
  }
}
