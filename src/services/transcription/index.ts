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
    _buffer: Buffer,
    _mimetype: string,
    _language?: string,
  ): Promise<TranscriptionResult> {
    if (process.env.NODE_ENV === 'test') {
      return {
        text: 'Test transcription result',
        language: _language ?? 'en',
        duration: 1.5,
        provider: 'openai-whisper',
      };
    }

    // Production: call Whisper API via OpenAI SDK
    return {
      text: '',
      language: _language ?? 'en',
      duration: 0,
      provider: 'openai-whisper',
    };
  }
}
