// The daemon's OTLP receiver (http/json): where every Elfoqsy session's Claude Code binary exports its traces and log
// events (env.ts). It listens on 127.0.0.1 only, on a free port, so nothing leaves the machine and nothing else can
// reach it; what it receives goes to the store, redacted there. Metrics are not asked for (env.ts) and dropped if sent.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { OtlpLogs, OtlpTraces, TelemetryStore } from './store';

/** A batch larger than this is refused (the binary caps each content field at CONTENT_MAX). */
export const MAX_BODY = 32 * 1024 * 1024;

export interface Receiver {
  url: string;
  /**
   * Waits for the last exports of sessions that are ending: until nothing has come for `quietMs` and nothing is being
   * received, or `maxMs` at most. A session's binary flushes its spans when it ends (within 2 s, its own cap), so the
   * daemon closes its sessions first, drains, then closes.
   */
  drain(quietMs?: number, maxMs?: number): Promise<void>;
  close(): Promise<void>;
}

export function startReceiver(store: Pick<TelemetryStore, 'ingestTraces' | 'ingestLogs'>, onError: (message: string) => void = () => undefined): Promise<Receiver> {
  let lastAt = 0;
  let receiving = 0;
  const server: Server = createServer((req, res) => {
    lastAt = Date.now();
    receiving++;
    res.once('close', () => {
      receiving--;
      lastAt = Date.now();
    });
    const reply = (status: number) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end('{}');
    };
    if (req.method !== 'POST') return reply(405);
    const path = (req.url ?? '').split('?')[0];
    if (path !== '/v1/traces' && path !== '/v1/logs' && path !== '/v1/metrics') return reply(404);
    if (!String(req.headers['content-type'] ?? '').includes('json')) return reply(415);
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) req.destroy();
      else chunks.push(c);
    });
    req.on('end', () => {
      if (path === '/v1/metrics') return reply(200);
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as OtlpTraces & OtlpLogs;
        if (path === '/v1/traces') store.ingestTraces(body);
        else store.ingestLogs(body);
        reply(200);
      } catch (error) {
        onError(`telemetry: a ${path} batch was not stored: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300));
        reply(400);
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        drain: async (quietMs = 1200, maxMs = 3000) => {
          const until = Date.now() + maxMs;
          lastAt = Math.max(lastAt, Date.now()); // a session that just closed may not have sent yet: a quiet period at least
          while (Date.now() < until && (receiving > 0 || Date.now() - lastAt < quietMs)) await new Promise((r) => setTimeout(r, 50));
        },
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}
