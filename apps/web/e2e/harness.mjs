// The browser harness shared by the browser tests and the baseline script: a scripted event server stands in for the daemon
// (its welcome, its replay, then events on cue, and every frame the page sends), Vite serves the screens, and Chrome drives
// them headless through playwright-core. Neither the daemon nor Claude is involved, and nothing leaves the host.
//
// CHROME_PATH names the browser; /usr/bin/google-chrome otherwise.
// E2E_SEED=<number> makes Math.random in every page a seeded sequence, so her portrait (picked at random) and anything else drawn from
// it is the same in two runs: the pictures of two versions of the code can then be compared pixel by pixel (compare.py).
import { createServer as createHttp } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { WebSocketServer } from 'ws';
import { T0 } from './scenario.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/** A free port on 127.0.0.1. */
export function freePort() {
  return new Promise((done) => {
    const s = createHttp().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => done(port));
    });
  });
}

/** The daemon's side of the socket, scripted: replay what it holds, then whatever the test pushes. */
export class ScriptedDaemon {
  constructor(port) {
    this.events = [];
    this.frames = [];
    this.logId = 'e2e-0';
    this.clients = new Set();
    // The windows streaming now: an intent one of them relays goes to the others, as the daemon's socket server does (P2).
    this.streaming = new Set();
    // Its HTTP side serves Jira attachments as the daemon would (v1.4): a small image for any id.
    this.http = createHttp((req, res) => {
      if (req.url?.startsWith('/jira/attachments/')) {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
      } else {
        res.writeHead(404);
        res.end();
      }
    }).listen(port, '127.0.0.1');
    this.server = new WebSocketServer({ server: this.http, path: '/ws' });
    this.server.on('connection', (socket) => {
      this.clients.add(socket);
      socket.on('close', () => {
        this.clients.delete(socket);
        this.streaming.delete(socket);
      });
      socket.on('message', (data) => {
        const frame = JSON.parse(String(data));
        this.frames.push(frame);
        this.onFrame?.(frame);
        if (frame.t === 'hello') {
          socket.send(JSON.stringify({ t: 'events', events: this.events.filter((e) => e.seq > frame.fromSeq) }));
          socket.send(JSON.stringify({ t: 'live' }));
          this.streaming.add(socket);
        }
        // What the daemon does with the layout (P2): his arrangement is an event both windows fold; the tester's is refused.
        if (frame.t === 'layout_set') {
          if (frame.test) socket.send(JSON.stringify({ t: 'error', message: 'Only alex arranges his screens.' }));
          else {
            const seq = (this.events.at(-1)?.seq ?? 0) + 1;
            this.push({ seq, id: `L${seq}`, ts: new Date(this.now()).toISOString(), source: 'orchestrator', type: 'layout.changed', payload: { layout: frame.layout, by: 'you' } });
          }
        }
        if (frame.t === 'relay') for (const other of this.streaming) if (other !== socket) other.send(JSON.stringify({ t: 'relay', intent: frame.intent }));
      });
      socket.send(JSON.stringify({ t: 'welcome', mode: 'simulate', logId: this.logId, headSeq: this.events.at(-1)?.seq ?? 0, serverTime: new Date(this.now()).toISOString(), jiraSite: 'https://acme.atlassian.net' }));
    });
  }
  now() {
    return T0 + 30 * 60_000;
  }
  /** A fresh log for the next test: a page that connects starts again from seq 0. */
  reset(events) {
    this.events = events;
    this.frames = [];
    // A test may answer frames as the daemon would (v1.4.1's real-use script).
    this.onFrame = undefined;
    this.logId = `e2e-${Math.random().toString(36).slice(2)}`;
  }
  push(...events) {
    this.events.push(...events);
    for (const c of this.clients) c.send(JSON.stringify({ t: 'events', events }));
  }
  close() {
    for (const c of this.clients) c.terminate();
    return new Promise((done) => this.server.close(() => this.http.close(done)));
  }
}


/** The daemon's stand-in, Vite and Chrome, and `open(path, events, viewport, reducedMotion)` for a page on a fresh log. */
export async function createStack() {
  const daemonPort = await freePort();
  const webPort = await freePort();
  const daemon = new ScriptedDaemon(daemonPort);
  process.env.DAEMON_PORT = String(daemonPort);
  const vite = await createServer({ root: resolve(here, '..'), configFile: resolve(here, '..', 'vite.config.ts'), logLevel: 'error', server: { port: webPort, strictPort: true, host: '127.0.0.1' } });
  await vite.listen();
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const base = `http://127.0.0.1:${webPort}`;
  const errors = [];

  async function open(path, events, viewport = { width: 1920, height: 1080 }, reducedMotion = 'reduce', before) {
    // events null: another window on the log the daemon holds (the two screens of one workstation, P2).
    if (events) daemon.reset(events);
    const page = await browser.newPage({ viewport, reducedMotion });
    page.on('pageerror', (e) => errors.push(`${path}: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`${path}: ${m.text()}`);
    });
    if (process.env.E2E_SEED) {
      await page.addInitScript((seed) => {
        let s = seed >>> 0;
        Math.random = () => {
          s = (s + 0x6d2b79f5) >>> 0;
          let t = s;
          t = Math.imul(t ^ (t >>> 15), t | 1);
          t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
      }, Number(process.env.E2E_SEED));
    }
    // before(page): what has to be set before the page loads (a fixed clock, a permission).
    if (before) await before(page);
    await page.goto(`${base}${path}`);
    await page.evaluate(() => document.fonts.ready);
    return page;
  }


  async function close() {
    await browser.close();
    await vite.close();
    await daemon.close();
  }
  return { daemon, vite, browser, base, errors, open, close };
}
