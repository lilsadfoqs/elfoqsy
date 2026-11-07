// HTTP and WebSocket server, bound to 127.0.0.1 only. The socket streams the event log: replay from
// the client's seq, then live. Alex's messages and answers come back up the same socket.
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import type { DaemonMode, ServerFrame } from '@elfoqsy/contracts';
import { clientFrameSchema } from '@elfoqsy/contracts';
import type { EventLog } from './eventLog';
import { ATTACHMENT_MAX_BYTES, AttachmentError, type AttachmentStore } from './attachments';
import { IntakeError, type Intake } from './intake';

const REPLAY_BATCH = 500;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export interface ServerOptions {
  log: EventLog;
  intake: Intake;
  mode: DaemonMode;
  jiraSite: string;
  port: number;
  attachments?: AttachmentStore;
  /** A Jira attachment of a ticket the daemon has read; null for any other id. */
  jiraAttachment?: (id: string) => Promise<{ bytes: Buffer; mediaType: string; filename: string } | null>;
}

export interface RunningServer {
  url: string;
  close(): Promise<void>;
}

/**
 * Browsers always send Origin on a WebSocket upgrade. Only pages served from this machine may connect,
 * so a random website open in another tab cannot read the sprint or answer an approval.
 * Non-browser clients (the tail tool, tests) send no Origin.
 */
function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    return LOCAL_HOSTS.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/** A request a page on another site could have made: refused for anything that reads or writes his data. */
const crossSite = (headers: Record<string, string | string[] | undefined>): boolean =>
  !isAllowedOrigin(headers.origin as string | undefined) || headers['sec-fetch-site'] === 'cross-site';

export async function startServer({ log, intake, mode, jiraSite, port, attachments, jiraAttachment }: ServerOptions): Promise<RunningServer> {
  const app = Fastify({ logger: false, bodyLimit: ATTACHMENT_MAX_BYTES });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  app.get('/health', async () => ({ ok: true, mode, logId: log.logId, headSeq: log.headSeq() }));

  if (attachments) {
    // A file or screenshot for a message: the raw bytes, with its name in X-File-Name.
    app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: ATTACHMENT_MAX_BYTES }, (_req, body, done) => done(null, body));
    app.post('/attachments', async (req, reply) => {
      if (crossSite(req.headers)) return reply.code(403).send({ error: 'Forbidden.' });
      const name = decodeURIComponent(String(req.headers['x-file-name'] ?? 'attachment'));
      try {
        return attachments.save(name, String(req.headers['content-type'] ?? ''), req.body as Buffer);
      } catch (error) {
        if (error instanceof AttachmentError) return reply.code(400).send({ error: error.message });
        throw error;
      }
    });
    app.get<{ Params: { id: string } }>('/attachments/:id', async (req, reply) => {
      if (crossSite(req.headers)) return reply.code(403).send({ error: 'Forbidden.' });
      const found = attachments.get(req.params.id);
      if (!found) return reply.code(404).send({ error: 'Not found.' });
      const { attachment, file } = found;
      const inline = attachment.mediaType.startsWith('image/');
      return reply
        .header('content-type', attachment.mediaType)
        .header('x-content-type-options', 'nosniff')
        .header('content-security-policy', "default-src 'none'")
        .header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(attachment.name)}`)
        .send(readFileSync(file));
    });
  }

  if (jiraAttachment) {
    // Read from Jira with his credentials, for the ticket view: images shown inline, every other file downloaded, and
    // nothing in them may run here (untrusted).
    app.get<{ Params: { id: string } }>('/jira/attachments/:id', async (req, reply) => {
      if (crossSite(req.headers)) return reply.code(403).send({ error: 'Forbidden.' });
      const found = await jiraAttachment(req.params.id).catch(() => null);
      if (!found) return reply.code(404).send({ error: 'Not found.' });
      const inline = /^image\/(png|jpeg|gif|webp|bmp|svg\+xml)$/.test(found.mediaType);
      return reply
        .header('content-type', found.mediaType)
        .header('x-content-type-options', 'nosniff')
        .header('content-security-policy', "default-src 'none'; sandbox")
        .header('cache-control', 'private, max-age=3600')
        .header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(found.filename)}`)
        .send(found.bytes);
    });
  }

  app.server.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path !== '/ws' || !isAllowedOrigin(req.headers.origin)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => serve(ws));
  });

  // The windows streaming now, so an intent one sends (P2: "open this ticket" for a pane on the other screen) reaches the others.
  const windows = new Set<(frame: ServerFrame) => void>();

  function serve(ws: WebSocket): void {
    const send = (frame: ServerFrame): void => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
    };
    let unsubscribe: (() => void) | undefined;

    send({
      t: 'welcome',
      mode,
      logId: log.logId,
      headSeq: log.headSeq(),
      serverTime: new Date().toISOString(),
      jiraSite,
    });

    ws.on('message', (data: RawData) => {
      const parsed = safeParse(data);
      if (!parsed) {
        send({ t: 'error', message: 'Invalid frame.' });
        return;
      }
      if (parsed.t === 'hello') {
        if (unsubscribe) {
          send({ t: 'error', message: 'Already streaming.' });
          return;
        }
        // Replay and subscribe in one synchronous block, so no append can fall between the two.
        for (let after = parsed.fromSeq; ; ) {
          const batch = log.readFrom(after, REPLAY_BATCH);
          if (!batch.length) break;
          send({ t: 'events', events: batch });
          after = batch[batch.length - 1]!.seq;
        }
        send({ t: 'live' });
        unsubscribe = log.subscribe((event) => send({ t: 'events', events: [event] }));
        windows.add(send);
        return;
      }
      if (parsed.t === 'relay') {
        // A view action, not an event: passed on as it came, to every other window, and kept nowhere.
        for (const other of windows) if (other !== send) other({ t: 'relay', intent: parsed.intent });
        return;
      }
      try {
        intake.handle(parsed);
      } catch (error) {
        send({ t: 'error', message: error instanceof IntakeError ? error.message : 'Could not handle that.' });
        if (!(error instanceof IntakeError)) console.error(error);
      }
    });

    ws.on('close', () => {
      windows.delete(send);
      unsubscribe?.();
    });
  }

  await app.listen({ host: '127.0.0.1', port });
  const { port: actualPort } = app.server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${actualPort}`,
    async close() {
      for (const client of wss.clients) client.terminate();
      wss.close();
      await app.close();
    },
  };
}

function safeParse(data: RawData) {
  try {
    const result = clientFrameSchema.safeParse(JSON.parse(data.toString()));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}
