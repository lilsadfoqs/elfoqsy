// The panes in boxes of chosen sizes, as PNGs and a list of what is wrong with each (P1, criterion 5).
//   node e2e/lab.mjs <dir> pane:w:h [pane:w:h ...]
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkPane } from './panecheck.mjs';
import { createStack } from './harness.mjs';
import { scenario, T0 } from './scenario.mjs';

const [dir, ...specs] = process.argv.slice(2);
const out = resolve(dir);
mkdirSync(out, { recursive: true });
const stack = await createStack();
const s = scenario();
const n = s.narrative();
const events = [...n.base, ...n.mid, ...s.design().filter((e) => e.type !== 'ticket.synced' && !String(e.type).startsWith('conversation') && e.type !== 'elfoqsy.message')];
let seq = 0;
const renumbered = events.map((e) => ({ ...e, seq: ++seq, id: `E${seq}` }));
const fixed = (page) => page.clock.setFixedTime(new Date(T0 + 30 * 60_000));
let bad = 0;
for (const spec of specs) {
  const [pane, w, h] = spec.split(':');
  const page = await stack.open(`/panes?pane=${pane}&w=${w}&h=${h}`, renumbered, undefined, 'reduce', fixed);
  await new Promise((r) => setTimeout(r, 900));
  const problems = await checkPane(page, `${pane} ${w}x${h}`);
  await page.locator('.lab-box').screenshot({ path: `${out}/${pane}-${w}x${h}.png` });
  console.log(`${problems.length ? '×' : '✓'} ${pane} ${w}x${h}`);
  for (const p of problems) console.log(`    ${p}`);
  bad += problems.length ? 1 : 0;
  await page.close();
}
await stack.close();
if (stack.errors.length) console.log('page errors:', stack.errors.join('\n'));
process.exit(bad ? 1 : 0);
