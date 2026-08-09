import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';

/**
 * A stand-in for speaches, close enough to the real thing to exercise the proxy
 * without a LAN.
 *
 * It mirrors the behaviours the live server was observed to have: it greets with
 * `session.created`, answers `session.update` with `session.updated`, speaks only
 * text JSON, and — like speaches — refuses the upgrade on the trailing-slash form
 * of the path, which is what makes the path handling worth testing at all.
 */
export interface FakeRealtimeServer {
  /** OpenAI-compatible root to configure a server with, e.g. http://127.0.0.1:1234/v1 */
  baseUrl: string;
  /** Every upgrade path the server was asked for, in order. */
  paths: string[];
  /** Authorization headers seen on the upgrade requests. */
  authHeaders: (string | undefined)[];
  /** Frames received from the proxy, in order. */
  received: string[];
  /** Currently connected sockets. */
  sockets: WebSocket[];
  /** Push a frame to every connected client. */
  emit(payload: unknown): void;
  /** Hang up on every connected client with the given code. */
  dropAll(code?: number, reason?: string): void;
  close(): Promise<void>;
}

export interface FakeRealtimeServerOptions {
  /** Answer the upgrade with this HTTP status instead of accepting it. */
  refuseWithStatus?: number;
  /** Called for each frame; return a value to send it straight back. */
  onMessage?: (raw: string, socket: WebSocket) => unknown | undefined;
}

export async function startFakeRealtimeServer(
  options: FakeRealtimeServerOptions = {},
): Promise<FakeRealtimeServer> {
  const http = createServer();
  const wss = new WebSocketServer({ noServer: true });

  const paths: string[] = [];
  const authHeaders: (string | undefined)[] = [];
  const received: string[] = [];
  const sockets: WebSocket[] = [];

  http.on('upgrade', (request, socket, head) => {
    const path = request.url ?? '';
    paths.push(path);
    authHeaders.push(request.headers.authorization);

    if (options.refuseWithStatus) {
      socket.write(`HTTP/1.1 ${options.refuseWithStatus} Refused\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      return;
    }

    // speaches answers HTTP 500 on the slashed form of the realtime path; the
    // proxy must never dial it.
    if (path.startsWith('/v1/realtime/')) {
      socket.write('HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      sockets.push(ws);
      ws.on('close', () => {
        const index = sockets.indexOf(ws);
        if (index >= 0) sockets.splice(index, 1);
      });

      ws.on('message', (data: Buffer) => {
        const raw = data.toString();
        received.push(raw);

        const reply = options.onMessage?.(raw, ws);
        if (reply !== undefined) {
          ws.send(JSON.stringify(reply));
          return;
        }

        try {
          if (JSON.parse(raw).type === 'session.update') {
            ws.send(JSON.stringify({ type: 'session.updated', event_id: 'event_fake' }));
          }
        } catch {
          ws.send(JSON.stringify({ type: 'error', error: { message: 'invalid JSON' } }));
        }
      });

      ws.send(JSON.stringify({ type: 'session.created', session: { id: 'sess_fake' } }));
    });
  });

  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  if (address === null || typeof address === 'string') {
    throw new Error('fake realtime server did not bind a TCP port');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    paths,
    authHeaders,
    received,
    sockets,
    emit(payload: unknown) {
      const frame = JSON.stringify(payload);
      for (const ws of [...sockets]) ws.send(frame);
    },
    dropAll(code = 1011, reason = 'engine went away') {
      for (const ws of [...sockets]) ws.close(code, reason);
    },
    async close() {
      for (const ws of [...sockets]) ws.terminate();
      wss.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

/** Resolves once the condition holds, polling cheaply. */
export async function waitFor(
  condition: () => boolean,
  timeoutMs = 5_000,
  label = 'condition',
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${label} did not hold within ${timeoutMs}ms`);
}
