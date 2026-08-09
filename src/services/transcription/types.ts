/**
 * The contract POST /transcribe depends on: audio bytes in, transcript out,
 * plus the format check the route performs before it spends the upload.
 *
 * Nothing wider is exposed on purpose — the route must stay unaware of which
 * implementation the factory handed it.
 */
export interface TranscriptionRequest {
  /** Raw upload bytes, exactly as read off the multipart body. */
  audio: Buffer;
  /** Client-declared mimetype of the upload. */
  mimetype: string;
  /** Optional `language` form field forwarded from the request. */
  language?: string;
}

export interface TranscriptionResult {
  text: string;
  language: string;
  duration: number;
  /** Identifier surfaced to clients in the response body. */
  provider: string;
}

export interface TranscriptionProvider {
  /** Value reported as `provider` on every result this instance produces. */
  readonly name: string;
  /** Rejected uploads never reach transcribe(), so this must be cheap. */
  supportsMimetype(mimetype: string): boolean;
  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult>;
}
