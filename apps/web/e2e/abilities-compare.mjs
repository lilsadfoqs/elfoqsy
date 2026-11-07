// The Abilities view beside the prototype's own page, both at 1920 × 1080 (the brief of 21 October: "match the prototype exactly").
//   node e2e/abilities-compare.mjs <dir> [proto|live] [ability to select]
// Writes proto.png (the prototype rendered from brief-abilities/prototypes), ours.png (the view with the prototype's nine abilities,
// the first selected as in the prototype's picture, or with the abilities she has now: `live`) and their boxes as JSON, so a
// difference is a number and not an impression. No daemon, Jira, GitHub or Claude traffic: the scripted daemon stands in.
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createStack } from './harness.mjs';
import { scenario, T0 } from './scenario.mjs';
import { abilityEvents, agentSkillEvents, protoEvents } from './abilities.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(process.argv[2] ?? 'abilities-compare');
const mode = process.argv[3] ?? 'proto';
mkdirSync(out, { recursive: true });

const stack = await createStack();
const engine = await stack.vite.ssrLoadModule('@elfoqsy/state');
const s = scenario();
const n = s.narrative();
const d = s.design().filter((e) => e.type !== 'ticket.synced' && !String(e.type).startsWith('conversation') && e.type !== 'elfoqsy.message');
let q = 0;
const lab = [...n.base, ...n.mid, ...d].map((e) => ({ ...e, seq: ++q, id: `E${q}` }));
const clock = T0 + 30 * 60_000;
const today = engine.todayConversation(clock);
const fixed = (page) => page.clock.setFixedTime(new Date(clock));

let events;
if (mode === 'proto') events = [...lab, ...protoEvents(lab.length, today)];
else {
  const base = abilityEvents(lab.length, today);
  let seq = lab.length + base.length;
  const hersDir = join(here, '..', '..', '..', 'docs', 'reports', 'abilities', 'her-skills');
  const hers = readdirSync(hersDir).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(join(hersDir, f), 'utf8')));
  const viewOf = (a) => ({ name: a.name, version: a.version, title: a.title, titleVi: a.titleVi, tool: a.tool, steps: a.steps.map((st) => ({ text: st.text, ...(st.code ? { code: st.code } : {}), kind: st.read ? 'read' : st.effect ? 'effect' : 'note' })), finder: a.finder, baselineSteps: a.baseline.steps, baselineFailed: a.baseline.failed, baselineQuestions: a.baseline.questions, source: a.source });
  const ev = (type, payload, k) => ({ seq: ++seq, id: `LV${seq}`, ts: new Date(clock + k * 1000).toISOString(), source: 'orchestrator', type, payload });
  events = [...lab, ...base, ...agentSkillEvents(lab.length + base.length, today, clock).slice(0, 2), ...hers.flatMap((a, i) => [ev('ability.learned', viewOf(a), 10 + i), ev('ability.origin', { name: a.name, version: a.version, foundAt: a.createdAt, cases: a.baseline.cases, from: a.baseline.from }, 10 + i)])];
  events = events.map((e, i) => ({ ...e, seq: i + 1, id: `X${i + 1}` }));
}

// Ours.
const page = await stack.open('/left', events, undefined, 'reduce', fixed);
await new Promise((r) => setTimeout(r, 1200));
await page.locator('button.conversation', { hasText: today.title }).click();
await page.locator('.hers-notice .ability-card--mini').first().click();
await page.locator('.abilities').waitFor();
if (mode === 'proto') await page.locator('.abilities-grid .ability-card[data-ability="proto-request-logs-staging"]').click();
if (process.argv[4]) {
  await page.locator(`.abilities-grid .ability-card[data-ability="${process.argv[4]}"]`).evaluate((e) => e.scrollIntoView({ block: 'nearest' }));
  await page.locator(`.abilities-grid .ability-card[data-ability="${process.argv[4]}"]`).click();
}
await page.mouse.move(1000, 1060);
await new Promise((r) => setTimeout(r, 900));
await page.screenshot({ path: join(out, `ours-${mode}.png`) });
await page.addStyleTag({ content: '.abilities-grid .ability-top, .abilities-grid .ability-bottom, .abilities-grid .ability-shade, .abilities-grid .ability-recheck, .abilities-detail .ability-top, .abilities-detail .ability-bottom, .abilities-detail .ability-shade { display: none !important; }' });
await page.screenshot({ path: join(out, `ours-${mode}-bare.png`) });
const boxes = await page.evaluate(() => {
  const r = (el) => { const b = el.getBoundingClientRect(); return { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1) }; };
  const q = (sel) => [...document.querySelectorAll(sel)].map(r);
  return {
    title: q('.abilities-head h1'), filters: q('.abilities-filter'), grid: q('.abilities-grid .ability-card'), logos: q('.abilities-grid .ability-logo-wrap'),
    detail: q('.abilities-detail .ability-card--detail'), numbers: q('.abilities-number'), steps: q('.abilities-step'), stepText: q('.abilities-step-text'), chips: q('.abilities-step code'), origin: q('.abilities-origin'),
  };
});
writeFileSync(join(out, `ours-${mode}.json`), JSON.stringify(boxes, null, 1));
await page.close();

// The prototype.
if (mode === 'proto') {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const p = await browser.newPage({ viewport: { width: 1920, height: 1080 }, reducedMotion: 'reduce' });
  // The brief's folder is not tracked: it is in the main checkout, beside the worktrees.
  const mainCheckout = resolve(execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: here, encoding: 'utf8' }).trim(), '..');
  const proto = [resolve(here, '..', '..', '..'), mainCheckout].map((r) => join(r, 'brief-abilities', 'prototypes', 'Abilities.dc.html')).find(existsSync);
  await p.goto(`file://${proto}`);
  await p.waitForTimeout(2500);
  await p.evaluate(() => document.fonts.ready);
  await p.screenshot({ path: join(out, 'proto.png') });
  await p.addStyleTag({ content: 'div[style*="top: 16px"][style*="left: 16px"], div[style*="bottom: 18px"], div[style*="linear-gradient"] { display: none !important; }' });
  await p.screenshot({ path: join(out, 'proto-bare.png') });
  const protoBoxes = await p.evaluate(() => {
    const r = (el) => { const b = el.getBoundingClientRect(); return { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1) }; };
    const q = (sel) => [...document.querySelectorAll(sel)].map(r);
    const byFont = (px) => [...document.querySelectorAll(`span[style*="font-size: ${px}px"]`)];
    return {
      title: q('h1'), filters: q('span[style*="height: 40px"][style*="border-radius: 20px"]'), grid: q('div[style*="width: 232px"][style*="height: 325px"]'), logos: q('div[style*="width: 209"]'),
      detail: q('div[style*="width: 250px"][style*="height: 350px"]'), numbers: byFont(30).map((e) => r(e.parentElement)), steps: q('div[style*="min-height: 36px"]'), chips: q('code'),
      stepText: [...document.querySelectorAll('div[style*="min-height: 36px"] > span[style*="font-size: 15px"]')].map(r),
    };
  });
  writeFileSync(join(out, 'proto.json'), JSON.stringify(protoBoxes, null, 1));
  await browser.close();
}
await stack.close();
console.log(`written to ${out}`);
