import { experimental_transcribe as transcribe } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';

import { isSupportedMimetype } from '../mimetypes.js';
import type {
  TranscriptionProvider,
  TranscriptionRequest,
  TranscriptionResult,
} from '../types.js';

export type FetchImplementation = typeof globalThis.fetch;

export interface OpenAICompatibleTranscriptionConfig {
  /**
   * Explicit credential. Left undefined so subclasses can resolve it from the
   * environment at call time — construction must never fail on a missing key.
   */
  apiKey?: string;
  /** Model id posted to /audio/transcriptions. */
  model?: string;
  /**
   * Endpoint override. Undefined keeps the AI SDK's own resolution
   * (OPENAI_BASE_URL, else https://api.openai.com/v1) untouched.
   */
  baseUrl?: string;
  /** Injection seam; the AI SDK uses global fetch when this is undefined. */
  fetch?: FetchImplementation;
}

/** Historical default, unchanged since the route was written. */
export const DEFAULT_TRANSCRIPTION_MODEL = 'whisper-1';

/**
 * Shared implementation for any endpoint speaking the OpenAI audio API.
 * Mirrors the LLM side's BaseProvider/adapters split in ../../providers.
 */
export abstract class OpenAICompatibleTranscriptionProvider implements TranscriptionProvider {
  abstract readonly name: string;

  protected readonly config: OpenAICompatibleTranscriptionConfig;

  constructor(config: OpenAICompatibleTranscriptionConfig = {}) {
    this.config = config;
  }

  get model(): string {
    return this.config.model ?? DEFAULT_TRANSCRIPTION_MODEL;
  }

  get baseUrl(): string | undefined {
    return this.config.baseUrl;
  }

  supportsMimetype(mimetype: string): boolean {
    return isSupportedMimetype(mimetype);
  }

  /** Resolved per request so an unset key surfaces on use, not at boot. */
  protected abstract resolveApiKey(): string;

  async transcribe({ audio, language }: TranscriptionRequest): Promise<TranscriptionResult> {
    const openai = createOpenAI({
      apiKey: this.resolveApiKey(),
      ...(this.config.baseUrl ? { baseURL: this.config.baseUrl } : {}),
      ...(this.config.fetch ? { fetch: this.config.fetch } : {}),
    });

    // The upload mimetype is deliberately not forwarded: the AI SDK sniffs the
    // media type from the bytes, which is what this route has always done.
    const result = await transcribe({
      model: openai.transcription(this.model),
      audio: new Uint8Array(audio),
      ...(language ? { providerOptions: { openai: { language } } } : {}),
    });

    return {
      text: result.text,
      language: result.language ?? language ?? 'en',
      duration: result.durationInSeconds ?? 0,
      provider: this.name,
    };
  }
}
