import { WebSocket } from 'ws';

import { resolvePlatformApiKey } from '../../billing/bypass.js';
import { NO_AUTH_PLACEHOLDER_API_KEY } from '../providers/custom-base-url.js';
import type {
  RealtimeConnectOptions,
  RealtimeFrame,
  RealtimeSessionListeners,
  RealtimeTranscriptionProvider,
  RealtimeTranscriptionSession,
} from './types.js';

/** Engine identity reported for anything speaking the OpenAI Realtime API. */
export const OPENAI_REALTIME_PROVIDER_NAME = 'openai-realtime';

/** Long enough for a cold LXC, short enough that a dead host fails visibly. */
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

export interface OpenAIRealtimeProviderConfig {
  /** OpenAI-compatible root, e.g. http://192.168.50.140:8000/v1. */
  baseUrl: string;
  /** Path appended to the root for the upgrade. See DEFAULT_REALTIME_PATH. */
  realtimePath: string;
  apiKey?: string;
}

/** Query keys the proxy owns; a client cannot override them. */
const RESERVED_QUERY_KEYS: ReadonlySet<string> = new Set(['model', 'server', 'token']);

export function toWebSocketUrl(baseUrl: string, realtimePath: string): URL {
  const path = realtimePath.startsWith('/') ? realtimePath : `/${realtimePath}`;
  const url = new URL(`${baseUrl.replace(/\/+$/, '')}${path}`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url;
}

class OpenAIRealtimeSession implements RealtimeTranscriptionSession {
  readonly provider = OPENAI_REALTIME_PROVIDER_NAME;

  constructor(private readonly socket: WebSocket) {}

  get open(): boolean {
    return this.socket.readyState === WebSocket.OPEN;
  }

  get bufferedBytes(): number {
    return this.socket.bufferedAmount;
  }

  send(frame: RealtimeFrame): void {
    if (!this.open) return;
    this.socket.send(frame.data, { binary: frame.isBinary });
  }

  pause(): void {
    this.socket.pause();
  }

  resume(): void {
    this.socket.resume();
  }

  close(code = 1000, reason = ''): void {
    // A socket still handshaking cannot be closed politely, and leaving it to
    // finish would leak the upstream connection the client no longer wants.
    if (this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.terminate();
      return;
    }
    if (this.socket.readyState !== WebSocket.OPEN) return;
    try {
      this.socket.close(code, reason);
    } catch {
      this.socket.terminate();
    }
  }
}

/**
 * Dials any endpoint speaking the OpenAI Realtime API — speaches on the LAN,
 * api.openai.com, or a gateway in front of either.
 *
 * Deliberately offers no subprotocol: speaches accepts a `Sec-WebSocket-Protocol`
 * offer but echoes none back, which makes a conformant client abort the
 * connection.
 */
export class OpenAIRealtimeTranscriptionProvider implements RealtimeTranscriptionProvider {
  readonly name = OPENAI_REALTIME_PROVIDER_NAME;

  constructor(private readonly config: OpenAIRealtimeProviderConfig) {
    if (!config.baseUrl) {
      throw new Error('A base URL is required for the realtime transcription provider');
    }
  }

  /** Never throws: an auth-free self-hosted engine is a legitimate deployment. */
  private resolveApiKey(): string {
    return (
      this.config.apiKey ??
      resolvePlatformApiKey(process.env.OPENAI_API_KEY) ??
      NO_AUTH_PLACEHOLDER_API_KEY
    );
  }

  buildUrl(options: RealtimeConnectOptions): URL {
    const url = toWebSocketUrl(this.config.baseUrl, this.config.realtimePath);
    url.searchParams.set('model', options.model);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (RESERVED_QUERY_KEYS.has(key)) continue;
      url.searchParams.set(key, value);
    }
    return url;
  }

  connect(
    options: RealtimeConnectOptions,
    listeners: RealtimeSessionListeners,
  ): Promise<RealtimeTranscriptionSession> {
    const url = this.buildUrl(options);
    const socket = new WebSocket(url, {
      headers: {
        authorization: `Bearer ${this.resolveApiKey()}`,
        // Required by api.openai.com; ignored by speaches.
        'openai-beta': 'realtime=v1',
      },
      handshakeTimeout: options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
    });

    return new Promise<RealtimeTranscriptionSession>((resolve, reject) => {
      let settled = false;

      const failHandshake = (error: Error) => {
        if (settled) return;
        settled = true;
        socket.removeAllListeners();
        // Tearing down a socket that is still handshaking makes `ws` emit its
        // own "closed before the connection was established" error. With no
        // listener that becomes an uncaught exception, so absorb it — the real
        // reason is already on its way to the caller via reject().
        socket.on('error', () => {});
        socket.terminate();
        reject(error);
      };

      socket.once('unexpected-response', (_request, response) => {
        failHandshake(
          new Error(
            `Realtime engine refused the WebSocket upgrade with HTTP ${response.statusCode}` +
              `${response.statusMessage ? ` ${response.statusMessage}` : ''}.`,
          ),
        );
      });

      socket.once('error', (error: Error) => {
        // After the handshake the socket is the caller's problem, not the
        // promise's — `ws` always follows an error with a close event.
        if (settled) {
          listeners.onError(error);
          return;
        }
        failHandshake(error);
      });

      socket.once('close', (code: number, reason: Buffer) => {
        if (!settled) {
          failHandshake(
            new Error(`Realtime engine closed the connection during handshake (code ${code}).`),
          );
          return;
        }
        listeners.onClose(code, reason.toString());
      });

      socket.once('open', () => {
        settled = true;
        socket.on('message', (data: Buffer, isBinary: boolean) => {
          listeners.onFrame({ data: isBinary ? data : data.toString(), isBinary });
        });
        resolve(new OpenAIRealtimeSession(socket));
      });
    });
  }
}
