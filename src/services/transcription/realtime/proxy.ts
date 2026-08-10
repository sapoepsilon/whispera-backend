import type { WebSocket } from 'ws';

import type {
  RealtimeFrame,
  RealtimeSessionListeners,
  RealtimeTranscriptionSession,
} from './types.js';

/**
 * Application close codes. 4000-4999 is the range reserved for private use, so
 * these can never collide with a protocol code the engine might send.
 */
export const CLOSE_BAD_REQUEST = 4400;
export const CLOSE_UNAUTHORIZED = 4401;
export const CLOSE_UNKNOWN_SERVER = 4404;
/** RFC 6455 1011: the proxy hit a condition it could not fulfil. */
export const CLOSE_UPSTREAM_FAILED = 1011;
/** RFC 6455 1013: try again later — used when a peer cannot drain its queue. */
export const CLOSE_BACKPRESSURE = 1013;

/** Queue depth at which the *other* side is told to stop talking. */
export const DEFAULT_HIGH_WATER_BYTES = 4 * 1024 * 1024;
/** Queue depth at which it may resume. */
export const DEFAULT_LOW_WATER_BYTES = 1 * 1024 * 1024;
/** How often a paused direction re-checks whether its destination has drained. */
export const DEFAULT_DRAIN_POLL_MS = 25;
/** A peer that never drains is a wedged peer; give up rather than leak. */
export const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;

const OPEN = 1;

export interface RealtimeProxyLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface RealtimeProxyOptions {
  highWaterMarkBytes?: number;
  lowWaterMarkBytes?: number;
  drainPollMs?: number;
  drainTimeoutMs?: number;
  logger?: RealtimeProxyLogger;
  /** Included in every log line so one session can be followed end to end. */
  context?: Record<string, unknown>;
  /**
   * Opt-in observers for the synthesized-delta feature (`DeltaSynthesizer`).
   * The bridge stays byte-opaque by default — these are undefined unless a
   * server's config turns synthesis on — and even then they only get to look:
   * they cannot alter, delay or drop a frame the bridge is relaying.
   */
  observeClientFrame?: (frame: RealtimeFrame) => void;
  observeEngineFrame?: (frame: RealtimeFrame) => void;
  /** Called once, when the session tears down — an opt-in feature's cue to stop its own timers. */
  onDisposed?: () => void;
}

/**
 * Close codes a server is allowed to put on the wire. 1005 and 1006 are
 * synthesised locally by the WebSocket implementation and must never be sent —
 * which is exactly what an engine that vanishes mid-session hands us.
 */
export function sanitiseCloseCode(code: number): number {
  if (code >= 3000 && code <= 4999) return code;
  if (code === 1000 || (code >= 1001 && code <= 1003) || (code >= 1007 && code <= 1011)) {
    return code;
  }
  return CLOSE_UPSTREAM_FAILED;
}

/** The engine's own error envelope, so a client needs only one error path. */
export function realtimeErrorFrame(code: string, message: string): string {
  return JSON.stringify({
    type: 'error',
    error: { type: 'invalid_request_error', code, message, param: null, event_id: null },
  });
}

/**
 * Pauses the source while the destination's queue is over the high-water mark
 * and resumes it once drained, so a slow peer throttles the fast one instead of
 * growing an unbounded buffer in this process.
 */
class FlowGuard {
  private paused = false;
  private timer: NodeJS.Timeout | undefined;
  private pausedAt = 0;

  constructor(
    private readonly source: { pause(): void; resume(): void },
    private readonly bufferedBytes: () => number,
    private readonly limits: { high: number; low: number; pollMs: number; timeoutMs: number },
    private readonly onStuck: () => void,
  ) {}

  afterSend(): void {
    if (this.paused || this.bufferedBytes() <= this.limits.high) return;

    this.paused = true;
    this.pausedAt = Date.now();
    this.source.pause();
    this.timer = setInterval(() => this.check(), this.limits.pollMs);
    // Never hold the event loop open for a socket that is already going away.
    this.timer.unref?.();
  }

  private check(): void {
    if (this.bufferedBytes() <= this.limits.low) {
      this.release();
      this.source.resume();
      return;
    }
    if (Date.now() - this.pausedAt >= this.limits.timeoutMs) {
      this.release();
      this.onStuck();
    }
  }

  private release(): void {
    this.paused = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  stop(): void {
    this.release();
  }
}

/**
 * Joins one authenticated client socket to one engine session.
 *
 * Constructed *before* the engine is dialled, because a client that hangs up
 * during the upstream handshake still has to be handled: the bridge remembers
 * it was disposed and closes the session the moment it arrives, so a dropped
 * client can never leak an engine connection.
 *
 * Frames are relayed verbatim in both directions — the proxy does not parse,
 * rewrite or validate the Realtime protocol, which is what lets a different
 * engine be swapped in behind the same route.
 */
export class RealtimeBridge {
  private session: RealtimeTranscriptionSession | undefined;
  private disposed = false;
  private upstreamGuard: FlowGuard | undefined;
  private downstreamGuard: FlowGuard | undefined;
  /** Frames the client sent before the engine was ready, in arrival order. */
  private pending: RealtimeFrame[] = [];
  private pendingBytes = 0;

  private readonly limits: { high: number; low: number; pollMs: number; timeoutMs: number };
  private readonly log: RealtimeProxyLogger | undefined;
  private readonly context: Record<string, unknown>;
  private readonly observeClientFrame: ((frame: RealtimeFrame) => void) | undefined;
  private readonly observeEngineFrame: ((frame: RealtimeFrame) => void) | undefined;
  private readonly onDisposedCallback: (() => void) | undefined;

  constructor(
    private readonly client: WebSocket,
    options: RealtimeProxyOptions = {},
  ) {
    this.limits = {
      high: options.highWaterMarkBytes ?? DEFAULT_HIGH_WATER_BYTES,
      low: options.lowWaterMarkBytes ?? DEFAULT_LOW_WATER_BYTES,
      pollMs: options.drainPollMs ?? DEFAULT_DRAIN_POLL_MS,
      timeoutMs: options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS,
    };
    this.log = options.logger;
    this.context = options.context ?? {};
    this.observeClientFrame = options.observeClientFrame;
    this.observeEngineFrame = options.observeEngineFrame;
    this.onDisposedCallback = options.onDisposed;

    // The read side is deliberately left running while the engine is dialled.
    // Pausing it would look tidier, but `ws` does not resume a paused socket in
    // order to close it, so a client that hangs up mid-handshake would go
    // unnoticed until the close timer fired — the exact leak this class exists
    // to prevent. Early frames are held in a bounded queue instead.
    this.client.on('message', this.onClientMessage);
    this.client.once('close', this.onClientClose);
    this.client.once('error', this.onClientError);
  }

  /** Handed to `RealtimeTranscriptionProvider.connect()`. */
  get listeners(): RealtimeSessionListeners {
    return {
      onFrame: (frame) => this.onEngineFrame(frame),
      onError: (error) => {
        this.log?.error({ ...this.context, err: error }, 'realtime engine session error');
      },
      onClose: (code, reason) => {
        this.log?.info({ ...this.context, code, reason }, 'realtime engine closed the session');
        this.dispose(code, reason || 'Engine closed the session');
      },
    };
  }

  /** True once either side has hung up. */
  get closed(): boolean {
    return this.disposed;
  }

  /** Starts relaying. Call once `connect()` resolves. */
  attach(session: RealtimeTranscriptionSession): void {
    // The client gave up while we were dialling — hang up on the engine we just
    // opened rather than holding it for nobody.
    if (this.disposed) {
      session.close(1000, 'Client disconnected');
      return;
    }

    this.session = session;

    // Anything the client said while we were dialling, in the order it said it.
    for (const frame of this.pending) session.send(frame);
    this.pending = [];
    this.pendingBytes = 0;

    this.upstreamGuard = new FlowGuard(
      this.client,
      () => session.bufferedBytes,
      this.limits,
      () => this.dispose(CLOSE_BACKPRESSURE, 'Transcription engine is not keeping up'),
    );
    this.downstreamGuard = new FlowGuard(
      session,
      () => this.client.bufferedAmount,
      this.limits,
      () => this.dispose(CLOSE_BACKPRESSURE, 'Client is not keeping up'),
    );

    this.client.resume();
  }

  /**
   * Refuses the session before an engine was ever reached: tells the client why
   * in the engine's own error shape, then closes.
   */
  fail(code: number, reason: string, errorCode: string): void {
    if (this.client.readyState === OPEN) {
      try {
        this.client.send(realtimeErrorFrame(errorCode, reason));
      } catch {
        // Client already gone; the close below is still worth attempting.
      }
    }
    this.dispose(code, reason);
  }

  /** Tears both halves down. Idempotent. */
  dispose(code = 1000, reason = ''): void {
    if (this.disposed) return;
    this.disposed = true;
    this.onDisposedCallback?.();

    this.upstreamGuard?.stop();
    this.downstreamGuard?.stop();
    this.client.off('message', this.onClientMessage);
    this.pending = [];
    this.pendingBytes = 0;

    const safeCode = sanitiseCloseCode(code);
    const safeReason = reason.slice(0, 120);

    this.session?.close(safeCode, safeReason);
    this.session = undefined;

    // `ws.close()` waits for the peer's close frame before ending the socket,
    // and it does not undo a pause to read one. A socket parked by backpressure
    // would sit until the close timer expired, so wake it first.
    this.client.resume();

    if (this.client.readyState === OPEN) {
      try {
        this.client.close(safeCode, safeReason);
        return;
      } catch {
        // fall through to terminate
      }
    }
    this.client.terminate();
  }

  /**
   * Pushes a frame toward the client that the engine did not send — the hook
   * `DeltaSynthesizer` uses to deliver a synthesized delta. Bypasses the
   * downstream flow guard: these frames are small and infrequent by
   * construction, so it is not worth coupling synthesis to the backpressure
   * state of the engine's own frames.
   */
  sendSynthesizedFrame(frame: RealtimeFrame): void {
    if (this.disposed || this.client.readyState !== OPEN) return;
    this.client.send(frame.data, { binary: frame.isBinary });
  }

  private onEngineFrame(frame: RealtimeFrame): void {
    if (this.disposed || this.client.readyState !== OPEN) return;
    this.observeEngineFrame?.(frame);
    this.client.send(frame.data, { binary: frame.isBinary });
    this.downstreamGuard?.afterSend();
  }

  private readonly onClientMessage = (data: Buffer, isBinary: boolean): void => {
    if (this.disposed) return;
    const frame: RealtimeFrame = { data: isBinary ? data : data.toString(), isBinary };
    this.observeClientFrame?.(frame);

    const session = this.session;
    if (session === undefined) {
      this.pending.push(frame);
      this.pendingBytes += isBinary ? data.length : Buffer.byteLength(String(frame.data));
      // A client that floods before the engine answers must not be allowed to
      // grow this queue without bound.
      if (this.pendingBytes > this.limits.high) {
        this.dispose(CLOSE_BACKPRESSURE, 'Too much audio sent before the engine was ready');
      }
      return;
    }

    if (!session.open) return;
    session.send(frame);
    this.upstreamGuard?.afterSend();
  };

  private readonly onClientClose = (code: number, reason: Buffer): void => {
    this.log?.info(
      { ...this.context, code, reason: reason.toString() },
      'realtime client disconnected; closing engine session',
    );
    // A normal client hangup must never be reported to the engine as a failure.
    this.dispose(1000, 'Client disconnected');
  };

  private readonly onClientError = (error: Error): void => {
    this.log?.warn({ ...this.context, err: error }, 'realtime client socket error');
    this.dispose(CLOSE_UPSTREAM_FAILED, 'Client socket error');
  };
}
