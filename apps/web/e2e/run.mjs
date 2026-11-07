// Browser tests for the screens (v1.3, item 1 and the design checks): a scripted event server stands in for the daemon
// (its welcome, its replay, then events on cue, and every frame the page sends), Vite serves the screens, and Chrome
// drives them headless through playwright-core. Neither the daemon nor Claude is involved, and nothing leaves the host.
//
//   pnpm --filter @elfoqsy/web e2e                     the tests
//   pnpm --filter @elfoqsy/web e2e -- --screens <dir>  also the v3 screens as PNGs, for comparing with the designs
//   pnpm --filter @elfoqsy/web e2e -- --only P2        only the tests whose name has these words (or any of several, as 'P2|C real use')
//
// CHROME_PATH names the browser; /usr/bin/google-chrome otherwise.
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { captureStates } from './baseline-states.mjs';
import { PANES as PANE_IDS, approach, carryAcross, leaveWindow, paneBox, readWindow, takeGrip, zonePoint } from './arrange.mjs';
import { createStack } from './harness.mjs';
import { checkPane } from './panecheck.mjs';
import { compareDirs } from './pixels.mjs';
import { detail, scenario, T0 } from './scenario.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
// --screens is taken from where the command was typed: pnpm runs this from apps/web, and says where it started in INIT_CWD.
const screensAt = args.includes('--screens') ? resolve(process.env.INIT_CWD ?? process.cwd(), args[args.indexOf('--screens') + 1]) : undefined;

const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : undefined;
const results = [];
async function test(name, fn) {
  if (only && !only.split('|').some((o) => name.includes(o))) return;
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - started });
    console.log(`  ✓ ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`  × ${name}\n    ${String(error?.stack ?? error).split('\n').slice(0, 6).join('\n    ')}`);
  }
}

/** Polls until fn returns something truthy, or fails with what was last seen. */
async function until(what, fn, ms = 5000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for ${what}; last saw ${JSON.stringify(last)}`);
}

const { daemon, vite, browser, errors, open } = await createStack();

/** Clicks a control inside a scrolling log once its scroll into view has settled, as a person scrolling to it would. */
async function press(locator) {
  await locator.scrollIntoViewIfNeeded();
  await new Promise((r) => setTimeout(r, 150));
  await locator.click();
}

/** The runs shown in panes, in layout order, and the focused one. */
const panes = (page) =>
  page.evaluate(() => ({
    runs: [...document.querySelectorAll('section.pane')].map((p) => p.getAttribute('data-run')),
    focused: document.querySelector('section.pane--focused')?.getAttribute('data-run') ?? null,
  }));

const s = scenario();

console.log('Item 1: panes');

await test("a new agent's terminal opens by itself, beside the focused one, without taking focus", async () => {
  const page = await open('/right', s.oneAgent());
  await until('the first pane', async () => (await panes(page)).runs.includes('r1') && (await panes(page)).focused === 'r1');
  daemon.push(...s.newAgent('r2', 2, 'SHOP-3492'));
  const after = await until('a pane for r2', async () => {
    const p = await panes(page);
    return p.runs.includes('r2') && p;
  });
  assert.deepEqual(after, { runs: ['r1', 'r2'], focused: 'r1' });
  await page.close();
});

await test('with no room left, it takes over the pane focused least recently; clicking an agent on the map focuses its pane, opening it (and the terminals) if needed', async () => {
  const page = await open('/right', s.oneAgent());
  await until('the first pane', async () => (await panes(page)).focused === 'r1');
  let n = 1;
  // Fill the column: each new agent splits the focused pane until no split fits.
  let before = 0;
  for (;;) {
    n += 1;
    daemon.push(...s.newAgent(`r${n}`, n, `SHOP-${3000 + n}`));
    const now = await until(`a pane for r${n}`, async () => {
      const p = await panes(page);
      return p.runs.includes(`r${n}`) && p;
    });
    if (now.runs.length === before) break; // it took over a pane: the column was full
    before = now.runs.length;
    assert.ok(n < 12, 'the column never filled');
  }
  // The last one took over a pane rather than splitting: which one? Start again knowing the panes, then focus in order.
  const full = await panes(page);
  const order = full.runs.filter((r) => r !== 'r1');
  for (const r of order) await page.click(`section.pane[data-run="${r}"] .pbody`);
  await page.click('section.pane[data-run="r1"] .pbody');
  const leastRecent = order[0];
  n += 1;
  daemon.push(...s.newAgent(`r${n}`, n, `SHOP-${3000 + n}`));
  const replaced = await until(`a pane for r${n}`, async () => {
    const p = await panes(page);
    return p.runs.includes(`r${n}`) && p;
  });
  assert.equal(replaced.runs.length, full.runs.length, 'no new pane: it took one over');
  assert.ok(!replaced.runs.includes(leastRecent), `the least recently focused pane (${leastRecent}) was taken over`);
  assert.equal(replaced.focused, 'r1', 'focus stays where it was');

  // The map: the agent whose pane was taken over has none now; a click on its circle opens it again, focused.
  const box = await page.locator(`button.map-agent[data-run="${leastRecent}"]`).boundingBox();
  assert.ok(box, `agent ${leastRecent} is on the map`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const reopened = await until(`a focused pane for ${leastRecent}`, async () => {
    const p = await panes(page);
    return p.focused === leastRecent && p;
  });
  assert.ok(reopened.runs.includes(leastRecent));
  // An agent that has a pane: a click only moves focus there.
  const other = reopened.runs.find((r) => r !== leastRecent && r !== 'r1');
  const at = await page.locator(`button.map-agent[data-run="${other}"]`).boundingBox();
  await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2);
  const moved = await until(`focus on ${other}`, async () => {
    const p = await panes(page);
    return p.focused === other && p;
  });
  assert.deepEqual(moved.runs, reopened.runs, 'no pane changed');
  // And from the keyboard: Tab to an agent's button, Enter.
  await page.focus('button.map-agent[data-run="r1"]');
  await page.keyboard.press('Enter');
  await until('focus on r1', async () => (await panes(page)).focused === 'r1');
  // With the terminals hidden, a click on an agent opens them and focuses its pane.
  await page.click('button[aria-label="Hide the agent terminals"]');
  await until('the terminals hidden', async () => (await page.locator('section.pane').count()) === 0);
  // The map takes the room the terminals left: click once the agent has stopped moving.
  const agent = page.locator(`button.map-agent[data-run="${other}"]`);
  let hidden = await agent.boundingBox();
  await until('the map settled', async () => {
    await new Promise((r) => setTimeout(r, 150));
    const now = await agent.boundingBox();
    const still = now && hidden && Math.abs(now.x - hidden.x) < 0.5 && Math.abs(now.y - hidden.y) < 0.5;
    hidden = now;
    return still;
  });
  await page.mouse.click(hidden.x + hidden.width / 2, hidden.y + hidden.height / 2);
  let seen;
  await until(`the terminals back, focused on ${other}`, async () => {
    seen = await panes(page);
    return seen.focused === other;
  }).catch((error) => {
    throw new Error(`${error.message}; the panes were ${JSON.stringify(seen)}`);
  });
  await page.close();
});

console.log('Item 2, 3, 4 and 6: the v3 screens');

await test('draws the right screen in v3: headers with step dots and ⋯, prose, light lines, a group chip, the verdict line, her answer, a question in its pane', async () => {
  const page = await open('/right', s.design());
  await until('four panes', async () => (await panes(page)).runs.length === 4);
  if (screensAt) {
    mkdirSync(screensAt, { recursive: true });
    await page.screenshot({ path: join(screensAt, '01-right-2x2-v3.png') });
  }
  const pane = page.locator('section.pane[data-run="r2"]');
  assert.equal(await pane.locator('.phead-title').textContent(), 'SHOP-2091');
  assert.equal(await pane.locator('.pdot').count(), 4);
  assert.equal(await pane.locator('.pdots-name').textContent(), 'Fix');
  assert.ok((await pane.locator('.grp-chip').first().textContent()).includes('reads and searches'));
  assert.equal(await pane.locator('.vl-head b').textContent(), 'VALID');
  assert.ok((await pane.locator('.ans').textContent()).includes('Elfoqsy answered for you'));
  assert.equal(await pane.locator('.pfoot-input').getAttribute('placeholder'), 'Message agent 2');
  // The group opens on click and shows its lines.
  await pane.locator('.grp-chip').first().click();
  assert.ok((await pane.locator('.grp-lines .ln3').count()) >= 3);
  // Split, timeline, pause and close are in the ⋯ menu.
  await pane.locator('.phead-more').click();
  // The ⋯ menu is a floating layer, drawn over the screen (v1.4.1).
  const items = await page.locator('.pmenu button').allTextContents();
  assert.ok(items.includes('Show the run timeline') && items.includes('Close this pane') && items.some((t) => t.startsWith('Pause agent')));
  await page.keyboard.press('Escape');
  // A question for him shows in its pane with its options.
  const q = page.locator('section.pane[data-run="r5"] .qcard');
  assert.ok((await q.textContent()).includes('needs you'));
  assert.equal(await q.locator('.qcard-option').count(), 2);
  await page.close();
});

await test('sends his answer from a pane, and a change of her answer, as frames to the daemon', async () => {
  const page = await open('/right', s.design());
  await until('four panes', async () => (await panes(page)).runs.length === 4);
  await press(page.locator('section.pane[data-run="r5"] .qcard-option').first());
  await until('the answer frame', async () => daemon.frames.find((f) => f.t === 'answer'));
  assert.deepEqual(
    daemon.frames.find((f) => f.t === 'answer'),
    { t: 'answer', approvalId: 'a5', decision: 'answered', answer: 'Per API key' },
  );
  const r2 = page.locator('section.pane[data-run="r2"]');
  await press(r2.locator('.ans-change'));
  await press(r2.locator('.ans-options button').first());
  await until('the change frame', async () => daemon.frames.find((f) => f.t === 'change_decision'));
  assert.deepEqual(daemon.frames.find((f) => f.t === 'change_decision'), { t: 'change_decision', decisionId: 'd1', to: 'No' });
  await page.close();
});

await test('draws one pane at full size as in screenshots 03 and 04, its group closed and open', async () => {
  const page = await open('/right', s.design(), { width: 1920, height: 1080 });
  await until('panes', async () => (await panes(page)).runs.length === 4);
  // Close the other three, so one pane fills the column.
  for (const r of ['r3', 'r4', 'r5']) {
    await page.locator(`section.pane[data-run="${r}"] .phead-more`).click();
    await page.locator('.pmenu button', { hasText: 'Close this pane' }).click();
  }
  await until('one pane', async () => (await panes(page)).runs.length === 1);
  const pane = page.locator('section.pane[data-run="r2"]');
  const font = await pane.locator('.prose').first().evaluate((el) => {
    const cs = getComputedStyle(el);
    return { size: cs.fontSize, leading: Number.parseFloat(cs.lineHeight) / Number.parseFloat(cs.fontSize), width: el.getBoundingClientRect().width, ch: Number.parseFloat(cs.maxWidth) };
  });
  assert.equal(font.size, '16px');
  assert.ok(Math.abs(font.leading - 1.7) < 0.01, `line height ${font.leading}`);
  if (screensAt) {
    await pane.screenshot({ path: join(screensAt, '03-terminal-v3-pane.png') });
    await pane.locator('.grp-chip').first().click();
    await pane.screenshot({ path: join(screensAt, '04-terminal-v3-group-open.png') });
  }
  await page.close();
});

await test('draws the question card and the digest in chat as in screenshot 05; ticking the precedent goes with his answer', async () => {
  const page = await open('/left', s.design());
  const card = page.locator('.block--card .qcard').last();
  await until('the card', async () => (await card.count()) > 0);
  assert.ok((await page.locator('.digest-head').first().textContent()).startsWith('I decided 4 things while you were away'));
  assert.equal(await page.locator('.digest .decision-row').count(), 4);
  assert.ok((await card.locator('.qcard-option--suggested').textContent()).includes('Elfoqsy suggests'));
  assert.equal(await card.locator('.qcard-sources-toggle').textContent(), '3 sources');
  if (screensAt) await page.locator('.thread').screenshot({ path: join(screensAt, '05-chat-question-card-and-digest.png') });
  await card.locator('.qcard-precedent input').check();
  await card.locator('.qcard-option').nth(1).click();
  await until('the answer frame', async () => daemon.frames.find((f) => f.t === 'answer'));
  assert.deepEqual(daemon.frames.find((f) => f.t === 'answer'), { t: 'answer', approvalId: 'a2', decision: 'answered', answer: 'Change v1 too', precedent: true });
  await page.close();
});

await test("opens the delegation sheet from Elfoqsy's column; his settings go to the daemon as frames (item 7), and so does opening the digest", async () => {
  const page = await open('/left', s.design());
  await page.locator('button[aria-label="What Elfoqsy decides for you"]').click();
  const sheet = page.locator('.sheet');
  await until('the sheet', async () => (await sheet.count()) > 0);
  assert.equal(await sheet.locator('.deleg li').count(), 13);
  assert.equal(await sheet.locator('[aria-label="Staging writes"] [aria-checked="true"]').textContent(), 'Ask me');
  await sheet.locator('[aria-label="Staging writes"] button', { hasText: 'Decide and tell me' }).click();
  await sheet.locator('.stepper button[aria-label="One more"]').click();
  await until('both frames', async () => daemon.frames.some((f) => f.t === 'setting') && daemon.frames.some((f) => f.t === 'delegation'));
  assert.deepEqual(daemon.frames.find((f) => f.t === 'delegation'), { t: 'delegation', category: 'staging_write', setting: 'decide_and_tell' });
  assert.deepEqual(daemon.frames.find((f) => f.t === 'setting'), { t: 'setting', key: 'maxAgents', value: 7 });
  if (screensAt) await page.screenshot({ path: join(screensAt, 'left-delegation-sheet.png') });
  // The digest, any time (v1.3.1): one frame, in the open conversation or Today's.
  await sheet.locator('.sheet-close').click();
  if (screensAt) await page.locator('.elf').screenshot({ path: join(screensAt, 'left-elfoqsy-column.png') });
  await page.locator('button[aria-label="What Elfoqsy decided"]').click();
  await until('the digest frame', async () => daemon.frames.some((f) => f.t === 'digest'));
  const digest = daemon.frames.find((f) => f.t === 'digest');
  assert.ok(Object.keys(digest).every((k) => k === 't' || k === 'conversationId'), JSON.stringify(digest));
  await page.close();
});

await test('has no coloured stripe beside a card, block or row on either screen (item 4)', async () => {
  for (const path of ['/right', '/left']) {
    const page = await open(path, s.design());
    await page.waitForTimeout(800);
    const stripes = await page.evaluate(() => {
      const found = [];
      for (const el of document.querySelectorAll('body *')) {
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        for (const side of ['Left', 'Right']) {
          const w = Number.parseFloat(cs[`border${side}Width`]);
          if (w > 0 && cs[`border${side}Style`] !== 'none' && (w > 1 || Number.parseFloat(cs.borderTopWidth) === 0) && cs.borderRadius !== '50%' && !el.matches('.elf, .mark--spin')) {
            // A divider between columns is a 1px neutral hairline; a stripe is coloured or thicker.
            if (w > 1 || cs[`border${side}Color`] !== cs.borderTopColor) found.push(`${el.className}: border-${side.toLowerCase()} ${w}px ${cs[`border${side}Color`]}`);
          }
        }
        for (const m of cs.boxShadow.matchAll(/inset\s+(-?\d+(?:\.\d+)?)px/g)) {
          if (Math.abs(Number(m[1])) > 0) found.push(`${el.className}: inset side shadow ${cs.boxShadow}`);
        }
        for (const pseudo of ['::before', '::after']) {
          const ps = getComputedStyle(el, pseudo);
          if (ps.content !== 'none' && ps.position === 'absolute' && Number.parseFloat(ps.width) <= 6 && Number.parseFloat(ps.height) > 12) found.push(`${el.className}${pseudo}: a narrow bar`);
        }
      }
      return found;
    });
    assert.deepEqual(stripes, [], `${path}`);
    await page.close();
  }
});

console.log('Milestone 17: the full ticket');

/** Opens a sprint ticket from the map, as he would. */
async function openTicket(page, key) {
  await page.locator(`button.ticket:has(.ticket-circle[aria-label^="${key},"])`).click();
  await until(`${key} open`, async () => (await page.locator('.tv-key a').textContent().catch(() => '')) === key);
}

await test('shows SHOP-3538 as Jira does (screenshots 20 to 22): header, fields, empty fields, rich text, links, Confluence', async () => {
  const page = await open('/left', s.tickets());
  await openTicket(page, 'SHOP-3538');
  await until('the watch frame', async () => daemon.frames.some((f) => f.t === 'watch_ticket' && f.key === 'SHOP-3538'));
  const head = await page.locator('.tv-head').innerText();
  for (const part of ['Parent', 'SHOP-3534', 'Checkout Performance (Phase 1)', 'OPEN', 'Blocker', '8 pt', 'Blocked by 2', 'Inventory Sync Worker', 'Created 8 Oct 2026 by Quinn Bauer']) assert.ok(head.includes(part), `the header has ${part}: ${head}`);
  const facts = await page.locator('.tv-body > .tv-fields .tv-label').allInnerTexts();
  assert.deepEqual(facts, ['Assignee', 'Reporter', 'Sprint', 'Labels']);
  assert.match(await page.locator('.tv-body > .tv-fields').innerText(), /SHOP Sprint 52\s+Release Manager: Morgan Diaz/);
  assert.equal((await page.locator('.tv-empty summary').innerText()).trim(), '4 empty fields');
  const sections = await page.locator('.tv-section > h3').allInnerTexts();
  assert.deepEqual(sections.slice(0, 5), ['Description', 'Solution', 'Impact', 'Acceptance criteria', 'Design']);
  assert.ok(sections.includes('Linked work items') && sections.includes('Confluence'), sections.join(', '));
  // The Description's headings and inline code, and its plain-text keys as links into Elfoqsy.
  assert.equal(await page.locator('.tv-rich .adf-h3').first().innerText(), 'Why');
  assert.equal(await page.locator('.tv-rich code').first().innerText(), 'shop-worker/src/inventory_sync');
  assert.ok((await page.locator('.tv-rich .adf-key', { hasText: 'CORE-18632' }).count()) > 0);
  assert.ok((await page.locator('.tv-rich .confluence-chip', { hasText: 'Checkout V2 :: Requirements' }).count()) > 0);
  if (screensAt) await page.screenshot({ path: join(screensAt, '20-ticket-open-top.png') });
  await page.locator('.tv-empty summary').click();
  assert.equal(await page.locator('.tv-empty .tv-label').count(), 4);
  if (screensAt) await page.screenshot({ path: join(screensAt, '21-ticket-empty-fields-open.png') });
  // Linked work items grouped by Jira's wording, one row each in the same columns.
  assert.deepEqual(await page.locator('.issue-group-name').allInnerTexts(), ['is blocked by', 'Relates']);
  const rows = await page.locator('.issue-row').evaluateAll((els) => els.map((e) => [e.querySelector('a').textContent, e.children[2].getBoundingClientRect().left]));
  assert.deepEqual(rows.map((r) => r[0]), ['SHOP-3543', 'SHOP-3537', 'CORE-18632', 'SHOP-3559']);
  assert.equal(new Set(rows.map((r) => Math.round(r[1]))).size, 1, 'the status chips line up');
  assert.equal(await page.locator('.issue-row svg.priority').count(), 4, 'every row has a priority');
  assert.ok((await page.locator('.tv-page .confluence-chip', { hasText: 'Checkout V2 :: Planning' }).count()) === 1);
  await page.locator('.issue-group-name', { hasText: 'is blocked by' }).scrollIntoViewIfNeeded();
  await page.locator('.tv-body').evaluate((el) => el.scrollBy(0, -40));
  if (screensAt) await page.screenshot({ path: join(screensAt, '22-ticket-scrolled-to-links.png') });
  await page.close();
});

await test('opens a ticket outside the sprint by its key, reads it, and shows what Jira gives', async () => {
  const page = await open('/left', s.tickets());
  await openTicket(page, 'SHOP-3538');
  await page.locator('.tv-rich .adf-key', { hasText: 'CORE-18632' }).first().click();
  await until('the watch frame for CORE-18632', async () => daemon.frames.some((f) => f.t === 'watch_ticket' && f.key === 'CORE-18632'));
  await until('reading', async () => (await page.locator('.tv-reading').innerText().catch(() => '')).includes('Reading CORE-18632 from Jira'));
  assert.equal(await page.locator('.tv-count').innerText(), 'not in sprint');
  const bug = { ...detail('SHOP-2430'), key: 'CORE-18632' };
  daemon.push({ seq: 1000, id: 'E1000', ts: new Date(daemon.now()).toISOString(), source: 'jira', type: 'ticket.detail', payload: bug });
  await until('the bug read', async () => (await page.locator('.tv-section > h3').allInnerTexts()).includes('Root cause description'));
  // Its attachments: the image inline, the rest as rows with Open.
  assert.ok((await page.locator('.tv-image img').count()) >= 1);
  assert.ok((await page.locator('.tv-file a', { hasText: 'Open' }).count()) >= 1);
  assert.ok((await page.locator('.tv-comment').count()) === 7);
  // Escape goes back to the map.
  await page.keyboard.press('Escape');
  await until('the map', async () => (await page.locator('.ticket-view').count()) === 0);
  await page.close();
});

console.log('Milestone 18: editing');

/** An event as the daemon would send it now. */
let pushed = 2000;
const now = (type, payload) => ({ seq: ++pushed, id: `E${pushed}`, ts: new Date(daemon.now()).toISOString(), source: 'jira', type, payload });
const lastFrame = (op) => daemon.frames.filter((f) => f.t === 'jira_edit' && f.change.op === op).at(-1);

await test("edits Solution in place, and shows theirs instead of saving over Quinn Bauer's change (screenshot 25, criterion 7)", async () => {
  const page = await open('/left', s.tickets());
  await openTicket(page, 'SHOP-3538');
  await page.locator('.tv-section:has(h3:text-is("Solution")) button.tv-add').click();
  const editor = page.locator('.ed .ed-content');
  await editor.waitFor();
  assert.deepEqual(await page.locator('.ed-toolbar [aria-label]').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label'))), ['Bold', 'Italic', 'Inline code', 'Link', 'Bullet list', 'Numbered list', 'Table', 'Code block']);
  await page.keyboard.press('Control+b');
  await page.keyboard.type('Inventory Sync Worker');
  await page.keyboard.press('Control+b');
  await page.keyboard.type(' consumes ');
  await page.keyboard.press('Control+e');
  await page.keyboard.type('InventorySyncCommand');
  await page.keyboard.press('Control+e');
  await page.keyboard.type(' and keeps a Redis ledger per file:');
  await page.keyboard.press('Enter');
  await page.locator('.ed-tool[aria-label="Numbered list"]').click();
  await page.keyboard.type('copy to the Platform bucket and verify size and sha256');
  await page.keyboard.press('Enter');
  await page.keyboard.type('emit FileSynced');
  await page.keyboard.press('Enter');
  await page.keyboard.type('delete the temporary copy after 10 minutes');
  await page.locator('.ed-foot button', { hasText: 'Save' }).click();
  const sent = await until('the edit frame', async () => lastFrame('field'));
  assert.equal(sent.key, 'SHOP-3538');
  assert.equal(sent.change.fieldId, 'customfield_16727');
  assert.equal(sent.change.base, null);
  const doc = sent.change.value;
  assert.equal(doc.type, 'doc');
  assert.deepEqual(doc.content[0].content.slice(0, 3), [
    { type: 'text', text: 'Inventory Sync Worker', marks: [{ type: 'strong' }] },
    { type: 'text', text: ' consumes ' },
    { type: 'text', text: 'InventorySyncCommand', marks: [{ type: 'code' }] },
  ]);
  assert.equal(doc.content[1].type, 'orderedList');
  assert.equal(doc.content[1].content.length, 3);
  // Quinn Bauer changed it meanwhile: nothing was saved; his version comes back.
  daemon.push(now('jira.edit_conflict', { editId: sent.editId, key: 'SHOP-3538', fieldId: 'customfield_16727', theirs: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Commit, verify, then release.' }] }] }, by: 'Quinn Bauer', at: new Date(daemon.now()).toISOString() }));
  await until('the conflict note', async () => (await page.locator('.ed-note').innerText()).includes('Quinn Bauer changed Solution while you were editing'));
  if (screensAt) await page.screenshot({ path: join(screensAt, '25-editing-solution-conflict.png') });
  await page.locator('.ed-foot button', { hasText: 'See theirs' }).click();
  assert.match(await page.locator('.ed-theirs').innerText(), /Commit, verify, then release\./);
  // Saving over theirs is his choice, and never one click: Save asks once (his answer 7), and nothing is sent until Replace.
  const frames = () => daemon.frames.filter((f) => f.t === 'jira_edit').length;
  const before = frames();
  await page.locator('.ed-foot button', { hasText: 'Save' }).click();
  const ask = page.locator('.ed-foot .replace-ask');
  await ask.waitFor();
  assert.equal((await ask.innerText()).replace(/\s+/g, ' '), 'Replace Quinn Bauer’s version? Keep editing Replace');
  if (screensAt) await page.screenshot({ path: join(screensAt, '25-replace-their-version.png') });
  await page.keyboard.press('Control+Enter');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(frames(), before, 'neither Save nor Ctrl Enter writes over theirs');
  await ask.locator('button', { hasText: 'Keep editing' }).click();
  assert.equal(await ask.count(), 0);
  assert.equal(await page.locator('.ed-foot button', { hasText: 'Save' }).count(), 1);
  await page.locator('.ed-foot button', { hasText: 'Save' }).click();
  await ask.locator('button', { hasText: 'Replace' }).click();
  // The frame says what he saw.
  const again = await until('the second edit frame', async () => (lastFrame('field')?.editId !== sent.editId ? lastFrame('field') : null));
  assert.equal(frames(), before + 1);
  assert.deepEqual(again.change.base, { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Commit, verify, then release.' }] }] });
  await page.close();
});

await test("asks once before an edited title replaces Morgan Diaz's newer one; Enter alone never does (his answer 7)", async () => {
  const page = await open('/left', s.tickets());
  await openTicket(page, 'SHOP-3538');
  await page.locator('.title-edit').click();
  const input = page.locator('input[aria-label="Title"]');
  await input.fill('Inventory Sync Worker: commit the stock, then release the hold');
  await input.press('Enter');
  const sent = await until('the title frame', async () => lastFrame('field'));
  daemon.push(now('jira.edit_conflict', { editId: sent.editId, key: 'SHOP-3538', fieldId: 'summary', theirs: 'Inventory Sync Worker: commit, verify, release', by: 'Morgan Diaz', at: new Date(daemon.now()).toISOString() }));
  await until('the conflict note', async () => (await page.locator('.title-form .fc-conflict').innerText().catch(() => '')).includes('Morgan Diaz changed the title'));
  await input.press('Enter');
  const ask = page.locator('.title-form .replace-ask');
  await ask.waitFor();
  assert.match(await ask.innerText(), /^Replace Morgan Diaz’s version\?/);
  await input.press('Enter');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(lastFrame('field').editId, sent.editId, 'Enter again sent nothing');
  await ask.locator('button', { hasText: 'Replace' }).click();
  const again = await until('the replacing frame', async () => (lastFrame('field').editId !== sent.editId ? lastFrame('field') : null));
  assert.deepEqual(again.change, { op: 'field', fieldId: 'summary', value: 'Inventory Sync Worker: commit the stock, then release the hold', base: 'Inventory Sync Worker: commit, verify, release' });
  await page.close();
});

await test('offers only the transitions Jira returns, and asks for the fields a transition screen requires (criterion 5)', async () => {
  const page = await open('/left', s.tickets());
  await openTicket(page, 'SHOP-3538');
  await page.locator('.status-menu > button').click();
  await until('the transitions read', async () => daemon.frames.some((f) => f.t === 'jira_transitions' && f.key === 'SHOP-3538'));
  daemon.push(
    now('ticket.transitions', {
      key: 'SHOP-3538',
      transitions: [
        { id: '11', name: 'Start analysis', to: { name: 'IN ANALYZE', category: 'indeterminate' }, fields: [] },
        { id: '21', name: 'Start progress', to: { name: 'IN PROGRESS', category: 'indeterminate' }, fields: [] },
        { id: '91', name: 'Won’t do', to: { name: 'DROPPED', category: 'done' }, fields: [{ id: 'resolution', name: 'Resolution', required: true, schema: { type: 'resolution', system: 'resolution' }, allowedValues: [{ id: '10000', name: 'Won’t Do' }, { id: '10001', name: 'Duplicate' }] }] },
      ],
    }),
  );
  await until('the menu', async () => (await page.locator('.status-item').count()) === 3);
  assert.deepEqual(await page.locator('.status-item').allInnerTexts(), ['Start analysis\nIN ANALYZE', 'Start progress\nIN PROGRESS', 'Won’t do\nDROPPED']);
  if (screensAt) await page.locator('.ticket-view').screenshot({ path: join(screensAt, '25-status-menu.png') });
  // A transition with a screen asks for its required field first.
  await page.locator('.status-item', { hasText: 'Won’t do' }).click();
  await page.locator('.status-screen select').selectOption({ label: 'Duplicate' });
  await page.locator('.status-screen button', { hasText: 'Move to DROPPED' }).click();
  const t = await until('the transition frame', async () => lastFrame('transition'));
  assert.deepEqual(t.change, { op: 'transition', transitionId: '91', fields: { resolution: { id: '10001' } } });
  await page.close();
});

await test("marks others' changes as they happen and Elfoqsy's edits with Undo; his labels and comments go to Jira (criterion 6)", async () => {
  const page = await open('/left', s.tickets());
  await openTicket(page, 'SHOP-3538');
  // Quinn Bauer changes the labels in Jira; the next read brings it with who did it.
  daemon.push(now('ticket.detail', { key: 'SHOP-3538', id: detail('SHOP-3538').id, fields: { labels: ['checkout-v2', 'checkout-v2.1'] }, changes: [{ fieldId: 'labels', name: 'Labels', by: 'Quinn Bauer', at: new Date(daemon.now()).toISOString() }], updated: '2026-10-14T10:00:00.000+0700', fetchedAt: new Date(daemon.now()).toISOString() }));
  await until('the change mark', async () => (await page.locator('.tv-value--changed').innerText().catch(() => '')).includes('Quinn Bauer'));
  assert.match(await page.locator('.tv-value--changed').innerText(), /checkout-v2\.1/);
  // On the sprint map, too, for a few seconds.
  await page.keyboard.press('Escape');
  await until('the map mark', async () => (await page.locator('.ticket-change').innerText().catch(() => '')).includes('Quinn Bauer: Labels'));
  await openTicket(page, 'SHOP-3538');
  // Elfoqsy filled Solution through the proxy: her mark, and Undo.
  daemon.push(
    now('change.recorded', { recordId: 'rec-1', actionId: 'act-1', runId: 'elfoqsy', target: "SHOP-3538's Solution", before: 'Empty.', undo: { proxy: 'jira', summary: "Put SHOP-3538's Solution back", request: { action: 'set_field', key: 'SHOP-3538', field: 'customfield_16727', value: null } } }),
    now('jira.edited', { key: 'SHOP-3538', by: 'elfoqsy', what: 'field', fieldId: 'customfield_16727', ok: true, actionId: 'act-1', recordId: 'rec-1', runId: 'elfoqsy' }),
    now('ticket.detail', { key: 'SHOP-3538', id: detail('SHOP-3538').id, fields: { customfield_16727: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Filled by Elfoqsy from the brief.' }] }] } }, updated: '2026-10-14T10:01:00.000+0700', fetchedAt: new Date(daemon.now()).toISOString() }),
  );
  const mark = page.locator('.tv-section:has(h3:text-is("Solution")) .ws-mark');
  await until('her mark', async () => (await mark.innerText().catch(() => '')).startsWith('Elfoqsy, '));
  if (screensAt) await page.screenshot({ path: join(screensAt, '25-changes-as-they-happen.png') });
  await mark.locator('button', { hasText: 'Undo' }).click();
  await until('the undo frame', async () => daemon.frames.some((f) => f.t === 'undo' && f.recordId === 'rec-1'));
  // His labels: one more, saved over the value he saw.
  await page.locator('.fact-edit[aria-label="Edit Labels"]').click();
  await page.locator('.fc-multi input').fill('p04');
  await page.locator('.fc-multi input').press('Enter');
  await page.locator('.fc-actions button', { hasText: 'Save' }).click();
  const labels = await until('the labels frame', async () => lastFrame('field'));
  assert.deepEqual(labels.change, { op: 'field', fieldId: 'labels', value: ['checkout-v2', 'checkout-v2.1', 'p04'], base: ['checkout-v2', 'checkout-v2.1'] });
  // A comment that mentions Quinn Bauer.
  await page.locator('.tv-section:has(h3:text-is("Comments")) button.tv-add').click();
  await page.keyboard.type('Thanks ');
  await page.keyboard.type('@Thu');
  await page.locator('.ed-mention', { hasText: 'Quinn Bauer' }).click();
  await page.keyboard.type('the ledger works.');
  await page.locator('.tv-section:has(h3:text-is("Comments")) .ed-foot button', { hasText: 'Save' }).click();
  const comment = await until('the comment frame', async () => lastFrame('comment_add'));
  const inline = comment.change.body.content[0].content;
  assert.deepEqual(inline.find((n) => n.type === 'mention').attrs, { id: 'acc-1', text: '@Quinn Bauer', accessLevel: '' });
  await page.close();
});

console.log('Milestone 19: switching and creating');

/** SHOP's create screen, captured from Jira with reads only, as the daemon logs it (ticket.createmeta). */
const createmeta = JSON.parse(readFileSync(resolve(here, '..', '..', 'daemon', 'test', 'fixtures', 'jira', 'createmeta-SHOP.json'), 'utf8'));
const screenOf = (typeId) =>
  createmeta.fields[typeId].map((f) => ({ id: f.fieldId, name: f.name, required: f.required && !f.hasDefaultValue, ...(f.schema ? { schema: f.schema } : {}), ...(f.allowedValues ? { allowedValues: f.allowedValues.map((v) => ({ ...(v.id ? { id: String(v.id) } : {}), ...(v.name ? { name: v.name } : {}), ...(v.value ? { value: v.value } : {}) })) } : {}) }));
const BUG = createmeta.types.find((t) => t.name === 'Bug').id;
const MAJOR = createmeta.fields[BUG].find((f) => f.fieldId === 'priority').allowedValues.find((v) => v.name === 'Major').id;

/** Every inline code element on the page: white mono on the selected surface, padded (criterion 11). */
async function inlineCodeAsAgreed(page, where) {
  const codes = await page.locator('code').evaluateAll((els) =>
    els
      .filter((e) => !e.closest('pre') && e.getClientRects().length)
      .map((e) => {
        const c = getComputedStyle(e);
        return { text: e.textContent.slice(0, 30), color: c.color, background: c.backgroundColor, padding: c.paddingLeft, mono: c.fontFamily.includes('JetBrains Mono') };
      }),
  );
  assert.ok(codes.length > 0, `${where}: some inline code to check`);
  for (const c of codes) assert.deepEqual({ ...c, text: undefined }, { text: undefined, color: 'rgb(255, 255, 255)', background: 'rgb(31, 38, 38)', padding: '7px', mono: true }, `${where}: ${c.text}`);
  return codes.length;
}

await test('opens the dial when hovered, names every dot and gives each its title; the arrows name where they go (B+, screenshot 23, criterion 10)', async () => {
  const page = await open('/left', s.tickets(), undefined, 'no-preference');
  await openTicket(page, 'SHOP-3538');
  const box = page.locator('.tv-dial-box');
  // At rest: only the open ticket is named.
  const shown = () => page.locator('.dial-num').evaluateAll((els) => els.filter((e) => getComputedStyle(e).opacity === '1').map((e) => e.textContent));
  assert.deepEqual(await shown(), ['3538']);
  assert.equal(await box.evaluate((e) => getComputedStyle(e).transitionDuration), '0.16s');
  await box.hover({ position: { x: 12, y: 12 } });
  await until('grown', async () => (await box.evaluate((e) => getComputedStyle(e).transform)) === 'matrix(1.7, 0, 0, 1.7, 0, 0)');
  await new Promise((r) => setTimeout(r, 250));
  assert.deepEqual((await shown()).sort(), ['1164', '18891', '2091', '3049', '3472', '3538', '3546']);
  // Over the header: the grown dial is on top of the title.
  const title = await page.locator('.tv-title').boundingBox();
  const grown = await box.boundingBox();
  assert.ok(grown.width > 540 && grown.x + grown.width > title.x, 'it grows over the header');
  if (screensAt) await page.screenshot({ path: join(screensAt, '23-dial-b-plus-on-hover.png') });
  // A dot's own hover: its title and workflow status.
  await page.locator('.dial-dot[aria-label^="SHOP-3049,"]').hover();
  const tip = page.locator('[data-layer="tooltip"]');
  await until('the tip', async () => tip.isVisible());
  assert.equal(await tip.innerText(), 'SHOP-3049\nRefund status change\nBLOCKED, 5 points');
  if (screensAt) await page.screenshot({ path: join(screensAt, '23-dial-dot-title.png'), clip: { x: grown.x - 8, y: grown.y - 8, width: grown.width + 260, height: grown.height + 16 } });
  // The arrows name the tickets they go to, in the arrow keys' order.
  const nav = (await page.locator('.tv-nav').innerText()).replace(/\s+/g, ' ').trim();
  const [prev, next] = [await page.locator('.tv-nav button').first().getAttribute('aria-label'), await page.locator('.tv-nav button').last().getAttribute('aria-label')];
  assert.equal(nav, `${prev.split('-').pop()} 1 of 7 ${next.split('-').pop()}`);
  await page.mouse.move(1500, 900);
  await until('back to its size', async () => (await box.evaluate((e) => getComputedStyle(e).transform)) === 'none');
  await page.keyboard.press('ArrowRight');
  await until('the next ticket', async () => (await page.locator('.tv-key a').textContent()) === next.replace('Next ticket, ', ''));
  await page.close();
});

await test('grows without animating for reduced motion, and still names every dot', async () => {
  const page = await open('/left', s.tickets());
  await openTicket(page, 'SHOP-3538');
  const box = page.locator('.tv-dial-box');
  assert.equal(await box.evaluate((e) => getComputedStyle(e).transitionDuration), '0s');
  await box.hover({ position: { x: 12, y: 12 } });
  assert.equal(await box.evaluate((e) => getComputedStyle(e).transform), 'matrix(1.7, 0, 0, 1.7, 0, 0)');
  assert.equal(await page.locator('.dial-num').evaluateAll((els) => els.filter((e) => getComputedStyle(e).opacity === '1').length), 7);
  await page.close();
});

await test('finds tickets with Ctrl K by key or words, in the sprint and outside it, and opens one with Enter (C, screenshot 24, criterion 10)', async () => {
  const page = await open('/left', s.tickets());
  await page.locator('.orbit').waitFor();
  await page.keyboard.press('Control+K');
  const input = page.locator('.find input');
  await until('the search open and focused', async () => input.evaluate((e) => e === document.activeElement).catch(() => false));
  // The sprint answers at once by key digits.
  await input.fill('3049');
  await until('the sprint match', async () => (await page.locator('.find-row').count()) === 1);
  assert.match(await page.locator('.find-row').innerText(), /SHOP-3049\s+Refund status change\s+BLOCKED\s+Sprint 52/);
  // Words: Jira is asked (a tier-0 read), and its answer comes with tickets outside the sprint.
  await input.fill('temporary store');
  const asked = await until('the search frame', async () => daemon.frames.find((f) => f.t === 'search_tickets' && f.query === 'temporary store'));
  assert.equal(asked.test, undefined);
  daemon.push(
    now('ticket.search', {
      query: 'temporary store',
      results: [
        { key: 'SHOP-3537', summary: '[Checkout V2] Initialize the reservation store and the hold by cart id', type: 'Story', status: { name: 'IN PROGRESS', category: 'indeterminate' }, inSprint: true, sprint: 'SHOP Sprint 52' },
        { key: 'CORE-18632', summary: 'Stream uploads into the Acme Shop temporary store', type: 'Story', status: { name: 'OPEN', category: 'new' }, inSprint: false },
        { key: 'SHOP-3543', summary: '[Checkout V2] Phase 1 infrastructure: reservation store, workflow cluster, Kafka topics', type: 'Task', status: { name: 'WORK-DONE', category: 'done' }, inSprint: true, sprint: 'SHOP Sprint 52' },
      ],
    }),
  );
  await until('three results', async () => (await page.locator('.find-row').count()) === 3);
  assert.deepEqual(await page.locator('.find-row .tag-outline').allInnerTexts(), ['Sprint 52', 'not in sprint', 'Sprint 52']);
  assert.deepEqual(await page.locator('.find-row .type-icon').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label'))), ['Story', 'Story', 'Task']);
  if (screensAt) await page.screenshot({ path: join(screensAt, '24-find-ctrl-k.png') });
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await until('CORE-18632 open', async () => daemon.frames.some((f) => f.t === 'watch_ticket' && f.key === 'CORE-18632'));
  assert.equal(await page.locator('.find').count(), 0);
  assert.equal(await page.locator('.tv-count').innerText(), 'not in sprint');
  // The search button under the expand button; its shortcut shows on hover only.
  const keys = page.locator('[data-layer="tooltip"]');
  assert.equal(await keys.count(), 0);
  await page.locator('.tv-find').hover();
  await until('the shortcut on hover', async () => keys.isVisible());
  assert.equal((await keys.innerText()).replace(/\s+/g, ' '), 'Find a ticket Ctrl K');
  await page.locator('.tv-find').click();
  await input.waitFor();
  await page.keyboard.press('Escape');
  await until('closed', async () => (await page.locator('.find').count()) === 0);
  await page.close();
});

/** Agent 6's draft in the conversation, with her line (screenshot 26, right). */
const drafted = (draftId, type = 'Bug') => [
  now('ticket.drafted', {
    draftId,
    by: 'agent',
    runId: 'r6',
    conversationId: 'c9',
    draft: {
      project: 'SHOP',
      type,
      summary: 'Inventory sync: reconcile job misses holds released mid-commit',
      description: '## Why\nWhen the worker dies between delete and ledger update, the reconcile job sees no leftover.',
      priority: 'Major',
      storyPoints: 3,
      sprint: { id: 33774, name: 'SHOP Sprint 52' },
      labels: ['checkout-v2'],
      links: [{ linkType: 'Relates', direction: 'outward', other: 'SHOP-3538' }],
    },
  }),
  now('elfoqsy.message', { messageId: `m-${draftId}`, role: 'elfoqsy', text: 'Agent 6 found a second defect while working SHOP-3538. I drafted the ticket; it waits for you.', conversationId: 'c9', blocks: [{ type: 'draft', ref: draftId }] }),
];
/** The daemon's answers to the create-screen reads the card and the form ask for. */
async function answerCreatemeta() {
  await until('the types read', async () => daemon.frames.some((f) => f.t === 'jira_createmeta' && f.project === 'SHOP' && !f.typeId));
  daemon.push(now('ticket.createmeta', { project: 'SHOP', types: createmeta.types }));
  await until('the Bug screen read', async () => daemon.frames.some((f) => f.t === 'jira_createmeta' && f.typeId === BUG));
  daemon.push(now('ticket.createmeta', { project: 'SHOP', types: createmeta.types, typeId: BUG, fields: screenOf(BUG) }));
}

await test('creates a drafted ticket only when he presses Create, from the form he opened with Edit first (screenshot 26, criterion 9)', async () => {
  const page = await open('/left', s.tickets());
  daemon.push(...drafted('draft-1'));
  const card = page.locator('.draft');
  await card.waitFor();
  assert.match(await card.innerText(), /New Bug · SHOP\s+waiting for you\s+Inventory sync: reconcile job misses holds released mid-commit\s+Major\s+3 pt\s+Sprint 52\s+Relates SHOP-3538\s+checkout-v2\s+Create in Jira\s+Edit first\s+Discard/);
  await answerCreatemeta();
  await until('Create in Jira ready', async () => card.locator('button', { hasText: 'Create in Jira' }).isEnabled());
  if (screensAt) await card.screenshot({ path: join(screensAt, '26-draft-card.png') });
  await card.locator('button', { hasText: 'Edit first' }).click();
  const form = page.locator('form.create');
  await form.waitFor();
  assert.equal(await form.locator('.create-field:has(.create-label:text-is("Project")) input').inputValue(), 'SHOP');
  assert.equal(await form.locator('.create-field:has(.create-label:text-is("Type")) select').inputValue(), BUG);
  assert.equal(await form.locator('.create-field:has(.create-label:text-is("Priority")) select').inputValue(), 'Major');
  assert.equal(await form.locator('.create-field:has(.create-label:text-is("Summary")) input').inputValue(), 'Inventory sync: reconcile job misses holds released mid-commit');
  assert.match(await form.locator('.ed-content').innerText(), /Why\s+When the worker dies between delete and ledger update/);
  assert.equal(await form.locator('.create-field:has(.create-label:text-is("Sprint")) select').inputValue(), '33774');
  assert.equal(await form.locator('.create-field:has(.create-label:text-is("Story points")) input').inputValue(), '3');
  assert.deepEqual((await form.locator('.create-chips .label-chip').allInnerTexts()).map((t) => t.replace(/\s+/g, '')), ['checkout-v2×']);
  assert.match(await form.locator('.create-links').innerText(), /Relates\s+SHOP-3538/);
  if (screensAt) await page.screenshot({ path: join(screensAt, '26-creating-a-ticket.png') });
  // Enter in a field creates nothing; nothing went to Jira yet.
  await form.locator('.create-field:has(.create-label:text-is("Summary")) input').press('Enter');
  await form.locator('.create-field:has(.create-label:text-is("Story points")) input').fill('5');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(daemon.frames.filter((f) => f.t === 'jira_create').length, 0);
  await form.locator('button', { hasText: 'Create' }).last().click();
  const created = await until('the create frame', async () => daemon.frames.find((f) => f.t === 'jira_create'));
  assert.equal(created.project, 'SHOP');
  assert.equal(created.typeId, BUG);
  assert.equal(created.draftId, 'draft-1');
  assert.equal(created.test, undefined);
  assert.deepEqual(created.links, [{ linkType: 'Relates', direction: 'outward', other: 'SHOP-3538' }]);
  const { description, ...fields } = created.fields;
  assert.deepEqual(fields, { summary: 'Inventory sync: reconcile job misses holds released mid-commit', priority: { id: MAJOR }, customfield_16486: 5, customfield_10521: 33774, labels: ['checkout-v2'] });
  assert.equal(description.content[0].type, 'heading');
  // Jira's answer: the new ticket opens here, and the card says it was created.
  daemon.push(
    now('ticket.created', { createId: created.createId, key: 'SHOP-9001', draftId: 'draft-1', checks: { links: true, sprint: false } }),
    now('ticket.draft_closed', { draftId: 'draft-1', how: 'created', key: 'SHOP-9001', by: 'you' }),
  );
  await until('SHOP-9001 open', async () => (await page.locator('.tv-key a').textContent().catch(() => '')) === 'SHOP-9001');
  assert.equal(await page.locator('.tv-created-warn').innerText(), 'Created, but Jira did not keep its sprint. Set it below.');
  assert.match(await card.innerText(), /Created as SHOP-9001/);
  assert.equal(await card.locator('.draft-wait').count(), 0);
  await page.close();
});

await test("creates a draft as it is with Create in Jira, discards another, and offers neither to the tester (criterion 9)", async () => {
  const page = await open('/left', s.tickets());
  daemon.push(...drafted('draft-2'), ...drafted('draft-3'));
  await answerCreatemeta();
  const [two, three] = [page.locator('.draft').nth(0), page.locator('.draft').nth(1)];
  await until('Create in Jira ready', async () => two.locator('button', { hasText: 'Create in Jira' }).isEnabled());
  await three.locator('button', { hasText: 'Discard' }).click();
  await until('the discard frame', async () => daemon.frames.some((f) => f.t === 'discard_draft' && f.draftId === 'draft-3'));
  assert.equal(daemon.frames.filter((f) => f.t === 'jira_create').length, 0);
  await two.locator('button', { hasText: 'Create in Jira' }).click();
  const created = await until('the create frame', async () => daemon.frames.find((f) => f.t === 'jira_create'));
  assert.equal(created.draftId, 'draft-2');
  assert.equal(created.fields.description.type, 'doc');
  assert.equal(daemon.frames.filter((f) => f.t === 'jira_create').length, 1);
  await page.close();
  // The tester sees the card, never its buttons in use.
  const tester = await open('/left?tester', [...s.tickets(), ...drafted('draft-4')]);
  const card = tester.locator('.draft');
  await card.waitFor();
  for (const name of ['Create in Jira', 'Edit first', 'Discard']) assert.equal(await card.locator('button', { hasText: name }).isDisabled(), true, name);
  assert.match(await card.innerText(), /Only alex creates tickets\./);
  await tester.close();
});

await test('lists what happened in Jira while he was away, in her voice (screenshot 27)', async () => {
  const page = await open('/left', s.tickets());
  const at = (h, m) => new Date(Date.UTC(2026, 9, 14, h, m)).toISOString();
  daemon.push(
    now('jira.news', {
      newsId: 'news-1',
      since: at(2, 12),
      conversationId: 'c9',
      items: [
        { kind: 'mention', who: 'Quinn Bauer', what: 'mentioned you in', key: 'SHOP-3559', at: at(3, 41) },
        { kind: 'transition', who: 'Morgan Diaz', what: 'moved to IN PROGRESS', key: 'SHOP-3543', at: at(3, 20) },
        { kind: 'comment', who: 'Jordan Park', what: 'commented on', key: 'SHOP-2091', at: at(2, 58) },
        { kind: 'change', who: 'Quinn Bauer', what: 'changed priority to Blocker on', key: 'SHOP-3538', at: at(2, 30) },
      ],
    }),
    now('elfoqsy.message', { messageId: 'm-news', role: 'elfoqsy', text: 'Welcome back. Four things happened in Jira; one mentions you.', conversationId: 'c9', blocks: [{ type: 'jira_news', ref: 'news-1' }] }),
  );
  const news = page.locator('.block.digest:has(.news-row)');
  await news.waitFor();
  assert.match(await news.locator('.digest-head').innerText(), /^In Jira since \d\d:\d\d\s+your tickets and mentions$/);
  const rows = (await news.locator('.news-row').allInnerTexts()).map((r) => r.replace(/\s+/g, ' ').trim());
  assert.deepEqual(rows.map((r) => r.replace(/ \d\d:\d\d$/, '')), ['QB Quinn Bauer mentioned you in SHOP-3559', 'MD Morgan Diaz moved to IN PROGRESS SHOP-3543', 'JP Jordan Park commented on SHOP-2091', 'QB Quinn Bauer changed priority to Blocker on SHOP-3538']);
  if (screensAt) await page.locator('.thread').screenshot({ path: join(screensAt, '27-jira-news-in-digest.png') });
  await news.locator('.news-key', { hasText: 'SHOP-3538' }).click();
  await until('SHOP-3538 open', async () => (await page.locator('.tv-key a').textContent().catch(() => '')) === 'SHOP-3538');
  await page.close();
});

await test('renders inline code everywhere as agreed in v1.2: white mono on the selected surface, padded (criterion 11)', async () => {
  const page = await open('/left', [...s.tickets(), ...[1].map(() => ({ seq: 900, id: 'E900', ts: new Date(T0 + 7000).toISOString(), source: 'simulator', type: 'elfoqsy.message', payload: { messageId: 'm-code', role: 'elfoqsy', text: 'The timeout is read in `shop-worker/src/export/cache.ts` and set by `RESULT_TIMEOUT_MS`.', conversationId: 'c9' } }))]);
  await page.locator('.thread').waitFor();
  const chat = await inlineCodeAsAgreed(page, 'the conversation');
  await openTicket(page, 'SHOP-3538');
  const ticket = await inlineCodeAsAgreed(page, 'the ticket view and the conversation');
  assert.ok(ticket > chat, 'the ticket adds its own');
  // Inside the editor too.
  await page.locator('.tv-section:has(h3:text-is("Solution")) button.tv-add').click();
  await page.keyboard.type('Use ');
  await page.keyboard.press('Control+E');
  await page.keyboard.type('ledger.confirm()');
  await inlineCodeAsAgreed(page, 'the editor');
  if (screensAt) await page.screenshot({ path: join(screensAt, '28-inline-code-left.png') });
  await page.close();
  const right = await open('/right', s.design());
  await until('four panes', async () => (await panes(right)).runs.length === 4);
  await inlineCodeAsAgreed(right, 'the terminals');
  await right.close();
});

await test('keeps the map view as it was (screenshot 28)', async () => {
  const page = await open('/left', s.tickets());
  await page.locator('.orbit').waitFor();
  assert.equal(await page.locator('.orbit button.ticket').count(), 7);
  if (screensAt) await page.screenshot({ path: join(screensAt, '28-left-screen-map-view-unchanged.png') });
  await page.close();
});

console.log('v1.4.1: floating layers, History, click to edit');

/**
 * The floating layers on the page, and what is wrong with them (docs/ui-spec.md "Floating layers"): more than one open
 * at a time (a tooltip inside its own layer aside), two that overlap (the same aside), one off the screen, or one
 * stacked other than its token says.
 */
async function checkLayers(page, where) {
  const layers = await page.evaluate(() => {
    const stage = document.querySelector('.stage').getBoundingClientRect();
    const k = stage.width / 1920;
    return [...document.querySelectorAll('[data-layer]')]
      .filter((e) => {
        const b = e.getBoundingClientRect();
        const cs = getComputedStyle(e);
        return b.width > 0 && b.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
      })
      .map((e) => {
        const b = e.getBoundingClientRect();
        return { kind: e.dataset.layer, id: e.dataset.layerId, parent: e.dataset.layerParent ?? null, x: (b.left - stage.left) / k, y: (b.top - stage.top) / k, w: b.width / k, h: b.height / k, z: getComputedStyle(e).zIndex };
      });
  });
  const Z = { dial: '10', tooltip: '20', menu: '30', search: '40' };
  const problems = [];
  const top = layers.filter((l) => !l.parent || !layers.some((p) => p.id === l.parent));
  if (top.length > 1) problems.push(`${top.length} layers open at once: ${top.map((l) => l.kind).join(', ')}`);
  for (const l of layers) {
    if (l.x < -0.5 || l.y < -0.5 || l.x + l.w > 1920.5 || l.y + l.h > 1080.5) problems.push(`${l.kind} off screen at ${Math.round(l.x)},${Math.round(l.y)} ${Math.round(l.w)}×${Math.round(l.h)}`);
    if (l.z !== Z[l.kind]) problems.push(`${l.kind} stacked at ${l.z}`);
  }
  for (const a of layers)
    for (const b of layers) {
      if (a.id >= b.id || a.parent === b.id || b.parent === a.id) continue;
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) problems.push(`${a.kind} over ${b.kind}`);
    }
  // No tooltip of the browser's own (his answer 5): every one is a tooltip layer.
  const native = await page.evaluate(() => [...document.querySelectorAll('[title], svg title')].map((e) => e.outerHTML.slice(0, 80)));
  for (const n of native) problems.push(`a browser tooltip: ${n}`);
  assert.deepEqual(problems, [], `floating layers ${where}`);
  return layers;
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const focused = (page) => page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.className ?? null);

await test('opens one floating layer at a time; each closes on a click outside and on Escape, giving focus back (v1.4.1 item 1)', async () => {
  const page = await open('/left', s.tickets());
  await openTicket(page, 'SHOP-3538');
  await until('transitions asked', async () => true);
  daemon.onFrame = (f) => {
    if (f.t === 'jira_transitions') daemon.push(now('ticket.transitions', { key: f.key, transitions: [{ id: '21', name: 'Start progress', to: { name: 'IN PROGRESS', category: 'indeterminate' }, fields: [] }] }));
  };
  const box = page.locator('.tv-dial-box');
  const chip = page.locator('.status-menu > button');
  // The status menu, then the dial hovered: the menu closes as the dial opens.
  await chip.click();
  await page.locator('[data-layer="menu"] .status-item').waitFor();
  await checkLayers(page, 'with the status menu');
  await box.hover({ position: { x: 12, y: 12 } });
  await until('the dial grown', async () => (await box.getAttribute('class')).includes('tv-dial-box--grown'));
  assert.equal(await page.locator('[data-layer="menu"]').count(), 0, 'the menu closed when the dial opened');
  await page.locator('.dial-dot[aria-label^="SHOP-3049,"]').hover();
  await page.locator('[data-layer="tooltip"]').waitFor();
  await checkLayers(page, 'with the grown dial and a dot’s tooltip');
  // Ctrl K over all of it: a centred dialog on a dimmed backdrop; the dial shrinks and the tooltip goes.
  await page.keyboard.press('Control+K');
  const dialog = page.locator('[data-layer="search"]');
  await dialog.waitFor();
  const layers = await checkLayers(page, 'with the search dialog');
  assert.deepEqual(layers.map((l) => l.kind), ['search']);
  const d = layers[0];
  assert.ok(Math.abs(d.x + d.w / 2 - 960) <= 1, `centred: ${d.x}+${d.w}/2`);
  assert.equal(await page.locator('.layer-backdrop').count(), 1);
  if (screensAt) await page.screenshot({ path: join(screensAt, '141-search-dialog.png') });
  // A press on the backdrop closes it.
  await page.mouse.click(60, 1000);
  await until('the dialog closed', async () => (await dialog.count()) === 0);
  assert.equal(await page.locator('.layer-backdrop').count(), 0);
  // The status menu: a click outside closes it; Escape closes it and gives focus back to the chip.
  await page.mouse.move(1500, 900);
  await chip.click();
  await page.locator('[data-layer="menu"]').waitFor();
  await page.mouse.click(1500, 70);
  await until('closed by a click outside', async () => (await page.locator('[data-layer="menu"]').count()) === 0);
  await chip.focus();
  await page.keyboard.press('Enter');
  await page.locator('[data-layer="menu"]').waitFor();
  await page.keyboard.press('Escape');
  await until('closed by Escape', async () => (await page.locator('[data-layer="menu"]').count()) === 0);
  assert.equal(await page.locator('.tv-key a').textContent(), 'SHOP-3538', 'Escape closed the menu, not the ticket');
  assert.ok(await chip.evaluate((e) => e === document.activeElement), 'focus back on the status chip');
  // Ctrl K from the composer: Escape gives focus back to the composer.
  const composer = page.locator('.composer textarea');
  await composer.click();
  await page.keyboard.press('Control+K');
  await dialog.waitFor();
  await page.keyboard.press('Escape');
  await until('closed', async () => (await dialog.count()) === 0);
  assert.ok(await composer.evaluate((e) => e === document.activeElement), `focus back in the composer, not ${await focused(page)}`);
  // The editor's text style menu: Escape closes the menu and leaves the editor open.
  await page.locator('.tv-section:has(h3:text-is("Solution")) button.tv-add').click();
  await page.locator('.ed-tool--text').click();
  await page.locator('[data-layer="menu"].ed-menu').waitFor();
  await checkLayers(page, 'with the style menu');
  await page.keyboard.press('Escape');
  await until('the style menu closed', async () => (await page.locator('.ed-menu').count()) === 0);
  assert.equal(await page.locator('.tv-section:has(h3:text-is("Solution")) .ed').count(), 1, 'the editor stays open');
  await page.locator('.ed-tool--text').click();
  await page.locator('.ed-menu').waitFor();
  await page.mouse.click(1500, 70);
  await until('the style menu closed by a click outside', async () => (await page.locator('.ed-menu').count()) === 0);
  await page.locator('.tv-section:has(h3:text-is("Solution")) .ed-foot button', { hasText: 'Cancel' }).click();
  // Her settings: a panel under its button, closed by Escape with focus back on the button.
  const settings = page.locator('.elf-settings[aria-label="What Elfoqsy decides for you"]');
  await settings.click();
  await page.locator('[data-layer="menu"].sheet').waitFor();
  await checkLayers(page, 'with her settings');
  await page.keyboard.press('Escape');
  await until('the settings closed', async () => (await page.locator('.sheet').count()) === 0);
  assert.ok(await settings.evaluate((e) => e === document.activeElement), 'focus back on the settings button');
  // Map tooltips are layers too.
  await page.keyboard.press('Escape');
  await page.locator('.orbit').waitFor();
  await page.locator('button.ticket:has(.ticket-circle[aria-label^="SHOP-1164,"])').hover();
  await page.locator('[data-layer="tooltip"]').waitFor();
  assert.match(await page.locator('[data-layer="tooltip"]').innerText(), /^SHOP-1164\nPer-step timeout\nIN ANALYZE, 2 points$/);
  await checkLayers(page, 'with a map tooltip');
  await page.close();
  // The right screen: the pane's ⋯ menu and the keyboard hint.
  const right = await open('/right', s.design());
  await until('four panes', async () => (await panes(right)).runs.length === 4);
  const more = right.locator('section.pane[data-run="r2"] .phead-more');
  await more.click();
  await right.locator('[data-layer="menu"].pmenu').waitFor();
  await checkLayers(right, 'with the pane menu');
  await right.mouse.click(960, 540);
  await until('the pane menu closed', async () => (await right.locator('.pmenu').count()) === 0);
  await more.click();
  await right.locator('.pmenu').waitFor();
  await right.keyboard.press('Escape');
  await until('closed by Escape', async () => (await right.locator('.pmenu').count()) === 0);
  assert.ok(await more.evaluate((e) => e === document.activeElement), 'focus back on ⋯');
  await right.locator('.hint-button').hover();
  await right.locator('[data-layer="tooltip"].hint-panel').waitFor();
  await checkLayers(right, 'with the keyboard hint');
  await right.close();
});

await test('selects text without editing: drag, double and triple clicks select; a plain click edits; a link opens (v1.4.1 item 3)', async () => {
  const page = await open('/left', s.tickets());
  await openTicket(page, 'SHOP-3538');
  const description = page.locator('.tv-section:has(h3:text-is("Description"))');
  const para = description.locator('.tv-rich p').first();
  await para.scrollIntoViewIfNeeded();
  const editing = () => description.locator('.ed').count();
  const selected = () => page.evaluate(() => String(window.getSelection()).trim());
  // A drag selects.
  const b = await para.boundingBox();
  await page.mouse.move(b.x + 4, b.y + 8);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + 8, { steps: 8 });
  await page.mouse.up();
  await pause(450);
  assert.equal(await editing(), 0, 'a drag does not edit');
  assert.ok((await selected()).length > 5, 'a drag selects');
  if (screensAt) await page.screenshot({ path: join(screensAt, '141-select-text.png') });
  // A double click selects a word; a triple click the paragraph.
  await para.dblclick({ position: { x: 40, y: 8 } });
  await pause(450);
  assert.equal(await editing(), 0, 'a double click does not edit');
  assert.ok((await selected()).length > 0, 'a double click selects a word');
  await para.click({ clickCount: 3, position: { x: 40, y: 8 } });
  await pause(450);
  assert.equal(await editing(), 0, 'a triple click does not edit');
  assert.ok((await selected()).length > 20, 'a triple click selects the paragraph');
  // A plain click edits (a moment later, as a person clicks again; sooner would be a fourth click).
  await pause(600);
  await para.click({ position: { x: 40, y: 8 } });
  await until('the editor', async () => (await editing()) === 1, 2000);
  await description.locator('.ed-foot button', { hasText: 'Cancel' }).click();
  // A link inside opens, and does not edit.
  await description.locator('.tv-rich .adf-key', { hasText: 'CORE-18632' }).first().click();
  await until('CORE-18632 open', async () => daemon.frames.some((f) => f.t === 'watch_ticket' && f.key === 'CORE-18632'));
  await page.keyboard.press('ArrowLeft');
  await openTicket(page, 'SHOP-3538').catch(async () => {
    await page.keyboard.press('Escape');
    await openTicket(page, 'SHOP-3538');
  });
  // A field value and the title: a double click selects, a plain click edits.
  const labels = page.locator('.fact-edit[aria-label="Edit Labels"]');
  await labels.dblclick();
  await pause(450);
  assert.equal(await page.locator('.fc').count(), 0, 'a double click on a value does not edit');
  assert.ok((await selected()).length > 0);
  await pause(600);
  await labels.click();
  await page.locator('.fc').waitFor({ timeout: 2000 });
  await page.locator('.fc-actions button', { hasText: 'Cancel' }).click();
  const title = page.locator('.title-edit');
  await title.dblclick({ position: { x: 60, y: 10 } });
  await pause(450);
  assert.equal(await page.locator('input[aria-label="Title"]').count(), 0, 'a double click on the title does not edit');
  await pause(600);
  await title.click({ position: { x: 60, y: 10 } });
  await page.locator('input[aria-label="Title"]').waitFor({ timeout: 2000 });
  await page.close();
});

await test('folds History to one line, and opened shows changes by people, grouped, a long text as a diff (v1.4.1 item 2)', async () => {
  const page = await open('/left', s.tickets());
  await openTicket(page, 'SHOP-3538');
  const history = page.locator('details.tv-history-box');
  await history.scrollIntoViewIfNeeded();
  assert.equal(await history.evaluate((e) => e.open), false);
  const line = (await history.locator('summary').innerText()).replace(/\s+/g, ' ').trim();
  assert.match(line, /^History · \d+ changes$/);
  const n = Number(/(\d+)/.exec(line)[1]);
  assert.ok(n < detail('SHOP-3538').history.flatMap((h) => h.items).length, `${n} after Rank is left out`);
  await history.locator('summary').click();
  const text = await history.innerText();
  assert.ok(!/Rank/.test(text), 'no Rank');
  const groups = await history.locator('.tv-history-group').evaluateAll((els) => els.map((e) => e.querySelector('.tv-history-who').textContent));
  for (let i = 1; i < groups.length; i++) assert.notEqual(groups[i], groups[i - 1], 'consecutive same-person same-day changes are one entry');
  const long = history.locator('li', { hasText: 'changed Description' }).first();
  assert.ok(!(await long.innerText()).includes('\n\n'), 'not both full texts');
  await long.locator('button', { hasText: 'Show diff' }).click();
  await long.locator('.tv-history-diff .diff-row').first().waitFor();
  assert.ok((await long.locator('.diff-row--add, .diff-row--del').count()) > 0);
  await long.scrollIntoViewIfNeeded();
  if (screensAt) await page.screenshot({ path: join(screensAt, '141-history.png') });
  await page.close();
});

await test("shows every control's tip as a tooltip layer, never the browser's: on screen, hidden by a press, never closing a panel (his answer 5)", async () => {
  const page = await open('/left', s.tickets());
  await page.locator('.composer').waitFor();
  const tip = page.locator('[data-layer="tooltip"]');
  const attach = page.locator('.composer .icon-button[aria-label="Attach a file or screenshot"]');
  await attach.hover();
  await until('the tip', async () => (await tip.innerText().catch(() => '')) === 'Attach a file or screenshot');
  await checkLayers(page, 'with a control’s tip');
  if (screensAt) await page.screenshot({ path: join(screensAt, '141-control-tip.png') });
  // A press hides it, as the browser's did.
  await page.mouse.down();
  await until('hidden by a press', async () => (await tip.count()) === 0);
  await page.mouse.up();
  // The status bar's pairs, by the edge of the screen: placed on it.
  await page.locator('.status-pair').first().hover();
  await until('the status tip', async () => /needs you|blocked/.test(await tip.innerText().catch(() => '')));
  await checkLayers(page, 'with the status bar tip');
  // With her settings open, a tip outside them does not show, and they stay open.
  await page.locator('.elf-settings[aria-label="What Elfoqsy decides for you"]').click();
  await page.locator('[data-layer="menu"].sheet').waitFor();
  await page.locator('.composer .send').hover({ force: true });
  await pause(300);
  assert.equal(await tip.count(), 0, 'no tip over an open panel');
  assert.equal(await page.locator('.sheet').count(), 1, 'the panel stays open');
  await checkLayers(page, 'with the panel open and a tip held back');
  await page.keyboard.press('Escape');
  // Keyboard focus on a control shows its tip too.
  await page.locator('.elf-settings[aria-label="What Elfoqsy decided"]').focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await until('the tip on focus', async () => (await tip.innerText().catch(() => '')).startsWith('What Elfoqsy decided'));
  await page.close();
  const right = await open('/right', s.design());
  await until('four panes', async () => (await panes(right)).runs.length === 4);
  await right.locator('section.pane[data-run="r2"] .pdots').hover();
  await until('the steps tip', async () => (await right.locator('[data-layer="tooltip"]').innerText().catch(() => '')).length > 0);
  await checkLayers(right, 'with a pane’s steps tip');
  await right.close();
});

await test('runs the real-use script: every step screenshotted, the floating layers checked after each (v1.4.1 item 4)', async () => {
  const started = Date.now();
  const page = await open('/left', s.tickets(), undefined, 'no-preference');
  const sprint = s.tickets().filter((e) => e.type === 'ticket.synced').map((e) => e.payload.ticket);
  const open7 = sprint.filter((t) => t.status !== 'Done');
  const base = detail('SHOP-2430');
  const served = new Set();
  // The daemon's side, as it would answer: each ticket read from Jira, its transitions, the search.
  daemon.onFrame = (f) => {
    if (f.t === 'watch_ticket' && !served.has(f.key) && f.key !== 'SHOP-3538') {
      served.add(f.key);
      const t = sprint.find((x) => x.key === f.key);
      if (t) daemon.push(now('ticket.detail', { ...base, key: f.key, id: `9${served.size}`, fields: { ...base.fields, summary: t.summary, status: { name: t.workflowStatus.name, statusCategory: { key: t.workflowStatus.category } } } }));
    } else if (f.t === 'jira_transitions') {
      daemon.push(now('ticket.transitions', { key: f.key, transitions: [{ id: '11', name: 'Start analysis', to: { name: 'IN ANALYZE', category: 'indeterminate' }, fields: [] }, { id: '21', name: 'Start progress', to: { name: 'IN PROGRESS', category: 'indeterminate' }, fields: [] }] }));
    } else if (f.t === 'search_tickets') {
      const q = f.query.toLowerCase();
      const results = sprint.filter((t) => t.key.toLowerCase().includes(q) || t.summary.toLowerCase().includes(q)).map((t) => ({ key: t.key, summary: t.summary, type: t.type, status: t.workflowStatus, inSprint: true, sprint: t.sprint }));
      daemon.push(now('ticket.search', { query: f.query, results }));
    }
  };
  let step = 0;
  let round = 0;
  const shots = [];
  const done = async (name) => {
    step++;
    await pause(350);
    let problem;
    await checkLayers(page, `round ${round + 1}, step ${step}: ${name}`).catch((e) => (problem = e));
    // Every step of the first round, and any later step that went wrong.
    if (screensAt && (round === 0 || problem)) {
      const file = `real-use-${round ? `r${round + 1}-` : ''}${String(step).padStart(2, '0')}-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`;
      shots.push(file);
      await page.screenshot({ path: join(screensAt, file) });
    }
    if (problem) throw problem;
    // A person reads before the next step.
    await pause(round === 0 ? 900 : 1200 + ((step * 337) % 1500));
  };
  const description = () => page.locator('.tv-section:has(h3:text-is("Description")) .tv-rich p').first();
  // One round of real use, on one ticket; the first is the script as asked, the rest go round the sprint.
  const oneRound = async (key) => {
    step = 0;
    if (round) {
      await page.keyboard.press('Escape');
      await pause(300);
    }
    await page.locator('.orbit').waitFor();
    await done('the sprint map');
    const others = open7.filter((t) => t.key !== key);
    await page.locator(`button.ticket:has(.ticket-circle[aria-label^="${others[round % others.length].key},"])`).hover();
    await page.locator('[data-layer="tooltip"]').waitFor();
    await done('hover a ticket on the map');
    await openTicket(page, key);
    await done(`open ${key}`);
    const box = page.locator('.tv-dial-box');
    await box.hover({ position: { x: 12, y: 12 } });
    await until('grown', async () => (await box.getAttribute('class')).includes('--grown'));
    await pause(300);
    await done('hover the dial');
    for (const t of [others[0], others[2], others[4]]) {
      await page.locator(`.dial-dot[aria-label^="${t.key},"]`).hover();
      await until(`${t.key}'s tooltip`, async () => (await page.locator('[data-layer="tooltip"]').innerText().catch(() => '')).startsWith(t.key));
      await done(`hover the dot of ${t.key}`);
    }
    await page.mouse.move(1500, 950);
    await until('shrunk', async () => !(await box.getAttribute('class')).includes('--grown'));
    await page.locator('.status-menu > button').click();
    await page.locator('[data-layer="menu"] .status-item').first().waitFor();
    await done('open the status menu');
    await page.mouse.click(1500, 70);
    await until('the menu closed', async () => (await page.locator('[data-layer="menu"]').count()) === 0);
    await done('click outside the status menu');
    await page.keyboard.press('Control+K');
    await page.locator('[data-layer="search"] input').waitFor();
    await page.keyboard.type(round % 2 ? 'per-step' : 'timeout', { delay: 60 });
    await page.locator('.find-row').first().waitFor();
    await done('open Ctrl K and type');
    await page.keyboard.press('Escape');
    await until('closed', async () => (await page.locator('[data-layer="search"]').count()) === 0);
    await description().waitFor();
    await description().scrollIntoViewIfNeeded();
    const pb = await description().boundingBox();
    await page.mouse.move(pb.x + 4, pb.y + 8);
    await page.mouse.down();
    await page.mouse.move(pb.x + pb.width * 0.7, pb.y + 8, { steps: 10 });
    await page.mouse.up();
    await pause(600);
    assert.equal(await page.locator('.tv-section:has(h3:text-is("Description")) .ed').count(), 0, 'selecting text does not edit');
    await done('select text in Description');
    const history = page.locator('details.tv-history-box');
    await history.scrollIntoViewIfNeeded();
    await history.locator('summary').click();
    await done('open History');
    if ((await history.locator('button', { hasText: 'Show diff' }).count()) > 0) {
      await history.locator('button', { hasText: 'Show diff' }).first().click();
      await done('show a diff in History');
    }
    await page.locator('.tv-body').evaluate((e) => e.scrollTo(0, 0));
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press('ArrowRight');
      await pause(500);
      await done(`next ticket with the arrow key (${i + 1})`);
    }
    await page.keyboard.press('ArrowLeft');
    await done('previous ticket with the arrow key');
    await page.keyboard.press('Control+K');
    await page.locator('[data-layer="search"] input').waitFor();
    await page.keyboard.type(key.split('-')[1], { delay: 60 });
    await page.locator('.find-row').first().waitFor();
    await page.keyboard.press('Enter');
    await until(`${key} again`, async () => (await page.locator('.tv-key a').textContent()) === key);
    await done(`switch to ${key} with Ctrl K`);
    // The first field with a value (an empty one is folded away).
    const fact = page.locator('.tv-body > .tv-fields .fact-edit').first();
    const factName = (await fact.getAttribute('aria-label')).replace('Edit ', '');
    await fact.click({ position: { x: 4, y: 6 } });
    await page.locator('.fc').waitFor();
    await done(`edit ${factName}`);
    await page.locator('.fc-actions button', { hasText: 'Cancel' }).click();
    await until('cancelled', async () => (await page.locator('.fc').count()) === 0);
    await done('cancel the edit');
    const solution = page.locator('.tv-section:has(h3:text-is("Solution"))');
    // Empty, it is "Add text"; filled, Enter on it edits (a click might land on a link in it).
    if ((await solution.locator('button.tv-add').count()) > 0) await solution.locator('button.tv-add').click();
    else {
      await solution.locator('.rich-read').focus();
      await page.keyboard.press('Enter');
    }
    await solution.locator('.ed').waitFor();
    await solution.locator('.ed-tool--text').click();
    await page.locator('.ed-menu').waitFor();
    await done('edit Solution and open its text styles');
    await page.keyboard.press('Escape');
    await solution.locator('.ed-foot button', { hasText: 'Cancel' }).click();
    await done('close the menu and cancel the edit');
    assert.equal(daemon.frames.filter((f) => f.t === 'jira_edit').length, 0, 'nothing was written');
  };
  // One round always; with --real-use-minutes N, rounds round the sprint until N minutes have passed.
  const minutes = args.includes('--real-use-minutes') ? Number(args[args.indexOf('--real-use-minutes') + 1]) : 0;
  let steps = 0;
  do {
    await oneRound(round === 0 ? 'SHOP-3538' : open7[round % open7.length].key);
    steps += step;
    round++;
  } while (Date.now() - started < minutes * 60_000);
  results.realUse = { rounds: round, steps, seconds: Math.round((Date.now() - started) / 1000), shots };
  console.log(`    real-use script: ${round} round${round === 1 ? '' : 's'}, ${steps} steps in ${results.realUse.seconds} s, floating layers checked after each`);
  if (screensAt) writeFileSync(join(screensAt, 'real-use.json'), `${JSON.stringify(results.realUse, null, 1)}\n`);
  await page.close();
});

console.log('N1: the ticket narrative, "What we know"');

/**
 * What is wrong with the narrative on screen: the ticket body scrolling sideways, a section over the one before it, or text
 * clipped sideways in a block (nothing may be clipped or overlap).
 */
async function checkNarrative(page, where) {
  const problems = await page.evaluate(() => {
    const out = [];
    const body = document.querySelector('.tv-body');
    const nv = document.querySelector('.nv');
    if (!body || !nv) return ['there is no narrative in the ticket body'];
    // Only the narrative's own width counts: the ticket's other fields (a long link) are not its business.
    const edge = nv.getBoundingClientRect().right;
    const wide = [...nv.querySelectorAll('*')].filter((e) => e.getBoundingClientRect().right > edge + 1).slice(0, 3).map((e) => `${e.tagName.toLowerCase()}.${e.className} "${(e.textContent ?? '').slice(0, 40)}"`);
    if (wide.length) out.push(`the narrative runs past its edge: ${wide.join('; ')}`);
    const sections = [...document.querySelectorAll('.nv-section')].map((e) => ({ n: e.dataset.section, r: e.getBoundingClientRect() }));
    for (let i = 1; i < sections.length; i++) if (sections[i].r.top < sections[i - 1].r.bottom - 1) out.push(`section ${sections[i].n} overlaps section ${sections[i - 1].n}`);
    for (const el of document.querySelectorAll('.nv-body, .nv-ready, .nv-stages, .nv-head, .nv-source')) if (el.scrollWidth > el.clientWidth + 1) out.push(`${el.className} is clipped sideways`);
    return out;
  });
  assert.deepEqual(problems, [], `the narrative ${where}`);
}

await test('N1 real use: the verdict line, "Read the verdict", the narrative as the agent reports, the hand-back and its gate; every step checked and screenshotted', async () => {
  const n = s.narrative();
  const page = await open('/left', [...n.base, ...n.mid], undefined, 'no-preference');
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const base = detail('SHOP-2430');
  const served = new Set();
  const renumber = (events) => events.map((e) => ({ ...e, seq: ++pushed, id: `E${pushed}` }));
  daemon.onFrame = (f) => {
    if (f.t === 'watch_ticket' && !served.has(f.key) && f.key !== 'SHOP-3538') {
      served.add(f.key);
      const t = n.base.find((e) => e.type === 'ticket.synced' && e.payload.ticket.key === f.key)?.payload.ticket;
      if (t) daemon.push(now('ticket.detail', { ...base, key: f.key, id: `9${served.size}`, fields: { ...base.fields, summary: t.summary, status: { name: t.workflowStatus.name, statusCategory: { key: t.workflowStatus.category } } } }));
    } else if (f.t === 'narrative_read') {
      // As the daemon: recorded as his, or as the tester's.
      daemon.push(now('narrative.read', { runId: f.runId, ticket: 'SHOP-3546', by: f.test ? 'tester' : 'you' }));
    } else if (f.t === 'mark_ready') {
      daemon.push(now('pr.synced', { pr: { repo: 'acme/shop-api', number: 140, state: 'open', ticket: 'SHOP-3546', url: 'https://github.com/acme/shop-api/pull/140', checks: 'success', title: 'feature/SHOP-3546: retry a 429 like a 503', review: 'none' } }));
    }
  };
  let step = 0;
  const done = async (name, ticketOpen = true) => {
    step++;
    await pause(350);
    let problem;
    await checkLayers(page, `step ${step}: ${name}`).catch((e) => (problem = e));
    if (!problem && ticketOpen) await checkNarrative(page, `step ${step}: ${name}`).catch((e) => (problem = e));
    if (screensAt) await page.screenshot({ path: join(screensAt, `N1-${String(step).padStart(2, '0')}-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`) });
    if (problem) throw problem;
    await pause(900); // a person reads before the next step
  };
  const stages = () => page.locator('.nv-stage').evaluateAll((els) => els.map((e) => e.getAttribute('data-stage')));
  const bodyTop = () => page.locator('.tv-body').evaluate((e) => e.getBoundingClientRect().top);
  const sectionTop = (n) => page.locator(`.nv-section[data-section="${n}"]`).evaluate((e) => e.getBoundingClientRect().top);

  await page.locator('.thread').waitFor();
  const verdictLine = page.locator('.thread', { hasText: 'Agent 4 reached its verdict on SHOP-3546: VALID, not reproduced yet.' });
  await verdictLine.waitFor();
  assert.ok((await verdictLine.innerText()).includes('Nothing waits for you.'));
  await done('the verdict line in the ticket conversation', false);

  await page.locator('.thread button', { hasText: 'Read the verdict' }).click();
  await page.locator('.nv').waitFor();
  await until('section 2 at the top of the ticket body', async () => Math.abs((await sectionTop(2)) - (await bodyTop())) < 12);
  await done('Read the verdict opens the ticket at its verdict');

  await page.locator('.tv-body').evaluate((e) => e.scrollTo(0, 0));
  assert.deepEqual(await stages(), ['done', 'done', 'done', 'current', 'waiting', 'waiting', 'waiting']);
  assert.equal(await page.locator('.nv-title').innerText(), 'What we know');
  assert.match(await page.locator('.nv-kept').innerText(), /^kept by Elfoqsy from Agent 4's reports$/);
  // Each section that has text ends with its source line; one not reached shows what it waits for.
  assert.match(await page.locator('.nv-section[data-section="1"] .nv-source').innerText(), /^Agent 4 · understanding, \d\d:\d\d · SHOP-3546, AC: retry on 429$/);
  assert.match(await page.locator('.nv-section[data-section="2"] .nv-source').innerText(), /^Agent 4 · verdict, \d\d:\d\d · errors\.ts:27$/);
  assert.match(await page.locator('.nv-section[data-section="3"] .nv-source').innerText(), /^Agent 4 · reproduction, \d\d:\d\d · test run at \d\d:\d\d$/);
  assert.equal(await page.locator('.nv-section[data-section="5"] .nv-waits').innerText(), 'After the root cause');
  assert.equal(await page.locator('.nv-section[data-section="7"] .nv-waits').innerText(), 'After verification');
  assert.match(await page.locator('.nv-section[data-section="4"]').innerText(), /Hypothesis \(open\): The retry budget is read after the early return/);
  await done('the narrative mid-run: three sections done, the cause still a hypothesis');

  await page.locator('.nv-section[data-section="3"]').scrollIntoViewIfNeeded();
  await done('the reproduction with its failing evidence');

  // The agent finishes: its turn ends with a draft PR open.
  daemon.push(...renumber(n.end));
  await page.locator('.thread', { hasText: 'Agent 4 handed back SHOP-3546 with draft PR shop-api#140, CI green.' }).waitFor();
  assert.ok((await page.locator('.thread button', { hasText: 'What we know, then ready for review' }).locator('.dot--needs-you').count()) === 1, 'a yellow dot on the hand-back link');
  await done('the hand-back line in the conversation, with its yellow dot', false);

  await page.locator('.thread button', { hasText: 'What we know, then ready for review' }).click();
  await page.locator('.nv-ready').waitFor();
  await until('section 7 at the top of the ticket body', async () => Math.abs((await sectionTop(7)) - (await bodyTop())) < 12);
  assert.deepEqual(await stages(), ['done', 'done', 'done', 'done', 'done', 'done', 'done']);
  assert.equal(await page.locator('.nv-ready button.button-solid').isDisabled(), true, 'Mark ready for review waits for the tick');
  await page.locator('.nv-ready').scrollIntoViewIfNeeded();
  await done('Ready for review waits for you: the button is disabled until the narrative is ticked');

  // Clicking a disabled button does nothing.
  await page.locator('.nv-ready button.button-solid').click({ force: true, timeout: 1000 }).catch(() => undefined);
  assert.equal(daemon.frames.filter((f) => f.t === 'mark_ready').length, 0, 'no mark_ready before the tick');
  await page.locator('.nv-check input').click();
  await until('his tick', async () => daemon.frames.some((f) => f.t === 'narrative_read'));
  await until('the box ticked once it is recorded', async () => page.locator('.nv-check input').isChecked());
  const tickFrame = daemon.frames.find((f) => f.t === 'narrative_read');
  assert.deepEqual(tickFrame, { t: 'narrative_read', runId: 'r4' }, "his tick carries no test mark: it is recorded as his");
  await until('the button enabled', async () => !(await page.locator('.nv-ready button.button-solid').isDisabled()));
  await done('ticked: "I\'ve read the narrative" is recorded as his and the button opens');

  await page.locator('.nv-ready button.button-solid').click();
  await until('mark_ready sent', async () => daemon.frames.some((f) => f.t === 'mark_ready'));
  await until('the card gone once the PR is ready', async () => (await page.locator('.nv-ready').count()) === 0);
  assert.match(await page.locator('.nv-section[data-section="7"]').innerText(), /a draft|open/);
  await done('marked ready for review: the PR is open and the card is gone');

  await page.locator('.nv-copy').click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  assert.ok(copied.startsWith('# What we know: SHOP-3546'));
  for (const t of ['## 1. Understanding', '## 2. Verdict', '## 3. Reproduction', '## 4. Root cause', '## 5. Fix', '## 6. Verification', '## 7. Hand-back']) assert.ok(copied.includes(t), t);
  assert.ok(copied.includes('2. `shop-api/src/payments/errors.ts:19`, on the way'));
  await done('Copy as Markdown puts all seven sections on the clipboard');
  results.realUseN1 = { steps: step };
  console.log(`    N1 real-use script: ${step} steps, floating layers and the narrative's layout checked after each`);
  await page.close();
});

await test("N1: the tester's tick opens nothing in a real run, and says so", async () => {
  const n = s.narrative();
  const page = await open('/left?tester', [...n.base, ...n.mid, ...n.end]);
  daemon.onFrame = (f) => {
    if (f.t === 'narrative_read') daemon.push(now('narrative.read', { runId: f.runId, ticket: 'SHOP-3546', by: f.test ? 'tester' : 'you' }));
  };
  await page.locator('.thread button', { hasText: 'What we know, then ready for review' }).click();
  await page.locator('.nv-ready').waitFor();
  await page.locator('.nv-check input').click();
  const frame = await until('the tester tick', async () => daemon.frames.find((f) => f.t === 'narrative_read'));
  assert.deepEqual(frame, { t: 'narrative_read', runId: 'r4', test: true });
  await until('the note', async () => (await page.locator('.nv-ready-note').innerText().catch(() => '')).includes("The tester's tick opens nothing"));
  assert.equal(await page.locator('.nv-ready button.button-solid').isDisabled(), true);
  await page.close();
});

console.log('P1: panes in their slots');

// Two of the ten pictures were taken again on 21 October 2026 (right-four-agents, right-map-hidden): Kubernetes' tile in a terminal is now the
// Kubernetes project's own logo (assets/tool-icons/kubernetes), not simple-icons' mark on a blue square; and, the same day, the tile of an `aws`
// call is the AWS logo, not the AWS CLI service's magenta icon (18 × 18 pixels). Nothing else differs.
await test('P1: with no layout saved, both screens look exactly as today (pixels, against the pictures taken before P1)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'elfoqsy-pixels-'));
  await captureStates({ open }, dir);
  assert.deepEqual(compareDirs(join(here, 'baseline'), dir), []);
});

/** The events the lab draws its panes from: the sprint and Agent 4's conversation, and the four agents of the v3 scene. */
function labEvents() {
  const n = s.narrative();
  const d = s.design().filter((e) => e.type !== 'ticket.synced' && !String(e.type).startsWith('conversation') && e.type !== 'elfoqsy.message');
  let q = 0;
  return [...n.base, ...n.mid, ...d].map((e) => ({ ...e, seq: ++q, id: `E${q}` }));
}
const labFixed = (page) => page.clock.setFixedTime(new Date(T0 + 30 * 60_000));
/** The DOM each form has, so a pane in a slot is the form its readout names. */
async function formMarkers(page, pane) {
  const form = await page.locator('.lab-form').innerText();
  const count = (sel) => page.locator(`.lab-box ${sel}`).count();
  if (pane === 'sprint') {
    const markers = { list: ['.slist', 1], compact: ['.orbit--compact', 1], short: ['.orbit--compact', 1], rail: ['.lcol--rail', 1], full: ['.orbit:not(.orbit--compact)', 1] }[form];
    assert.equal(await count(markers[0]), markers[1], `sprint ${form} has ${markers[0]}`);
    if (form === 'full') assert.equal(await count('.orbit--compact'), 0);
  } else if (pane === 'terminals') {
    const panes = await count('section.pane');
    const agents = 4;
    if (form === 'four') assert.ok((await count('.pwrap--four')) === 1 && panes === agents, `four panes, saw ${panes}`);
    else if (form === 'two') assert.ok((await count('.ptabs')) === 0 && panes === 2, `two panes, saw ${panes}`);
    else if (form === 'one') assert.ok((await count('.ptabs')) === 1 && panes === 1, `one pane with tabs, saw ${panes}`);
    else assert.ok((await count('.prows')) === 1 && panes === 0, `tabs only, saw ${panes} panes`);
  } else if (pane === 'map') {
    assert.equal(await count('canvas.map-canvas'), 1);
  }
  return form;
}

// Around every threshold of docs/layout.md, on both sides, and between them.
const GRID = {
  sprint: [[840, 972], [760, 700], [759, 700], [760, 699], [600, 620], [480, 700], [480, 560], [480, 559], [479, 600], [400, 700], [322, 700], [240, 700], [240, 240], [540, 300], [1000, 972], [239, 500]],
  terminals: [[1180, 972], [1000, 700], [999, 972], [1000, 699], [800, 600], [500, 560], [500, 559], [499, 700], [380, 600], [379, 600], [300, 500], [300, 240], [1000, 559]],
  map: [[640, 972], [500, 600], [499, 600], [500, 599], [400, 500], [300, 300], [300, 240]],
  elfoqsy: [[342, 972], [342, 600], [330, 500], [330, 420], [330, 300], [330, 240], [500, 300], [800, 972]],
  conversation: [[618, 972], [500, 600], [380, 421], [380, 420], [380, 300], [380, 240], [900, 500]],
};
await test('P1: every pane renders correctly in every slot, from its minimum up: its form from the slot, text from the type scale, nothing clipped or overlapping (a grid of sizes)', async () => {
  const events = labEvents();
  let pages = 0;
  const forms = {};
  for (const [pane, sizes] of Object.entries(GRID)) {
    for (const [w, h] of sizes) {
      const page = await open(`/panes?pane=${pane}&w=${w}&h=${h}`, events, undefined, 'reduce', labFixed);
      await pause(700);
      const form = await formMarkers(page, pane);
      (forms[pane] ??= new Set()).add(form);
      assert.deepEqual(await checkPane(page, `${pane} ${w}x${h} (${form})`), []);
      await page.close();
      pages++;
    }
  }
  // Every form each pane has was drawn.
  assert.deepEqual([...forms.sprint].sort(), ['compact', 'full', 'list', 'rail', 'short']);
  assert.deepEqual([...forms.terminals].sort(), ['four', 'one', 'tabs', 'two']);
  console.log(`    ${pages} slots checked, ${Object.values(forms).reduce((n, f) => n + f.size, 0)} forms seen`);
});

await test('P1 real use: each pane dragged through its forms by the corner, at a person\'s pace; every step checked and screenshotted', async () => {
  const events = labEvents();
  const steps = {
    sprint: [[840, 972], [760, 700], [700, 700], [520, 700], [480, 560], [480, 500], [400, 500], [320, 500], [240, 500], [240, 240]],
    terminals: [[1180, 972], [1000, 700], [900, 700], [500, 600], [500, 540], [420, 540], [380, 540], [330, 540], [300, 240]],
    map: [[640, 972], [500, 600], [450, 500], [380, 400], [300, 300]],
    elfoqsy: [[342, 972], [342, 560], [330, 420], [330, 300], [330, 240]],
    conversation: [[618, 972], [500, 600], [420, 400], [380, 300], [380, 240]],
  };
  let n = 0;
  const shots = [];
  for (const [pane, list] of Object.entries(steps)) {
    const [w0, h0] = list[0];
    const page = await open(`/panes?pane=${pane}&w=${w0}&h=${h0}`, events, undefined, 'no-preference', labFixed);
    await pause(900);
    for (const [w, h] of list) {
      // The corner, at the pace of a hand: down, a few small moves, up.
      const grip = await page.locator('.lab-grip').boundingBox();
      const now = await page.locator('.lab-size').innerText();
      const [cw, ch] = now.split('×').map((x) => Number(x));
      if (cw !== w || ch !== h) {
        await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
        await page.mouse.down();
        await page.mouse.move(grip.x + grip.width / 2 + (w - cw), grip.y + grip.height / 2 + (h - ch), { steps: 8 });
        await page.mouse.up();
      }
      await until(`${pane} at ${w} x ${h}`, async () => (await page.locator('.lab-size').innerText()) === `${w} × ${h}`);
      await pause(500);
      n++;
      const form = await formMarkers(page, pane);
      const problems = await checkPane(page, `${pane} ${w}x${h} (${form})`);
      const layers = await checkLayers(page, `${pane} ${w}x${h}`).catch((e) => e);
      if (screensAt) {
        const file = `P1-${String(n).padStart(2, '0')}-${pane}-${form.replace(/ /g, '-')}-${w}x${h}.png`;
        shots.push(file);
        await page.screenshot({ path: join(screensAt, file), clip: { x: 0, y: 0, width: Math.min(1920, w + 90), height: Math.min(1080, h + 120) } });
      }
      assert.deepEqual(problems, []);
      if (layers instanceof Error) throw layers;
      await pause(700); // a person looks at it before the next move
    }
    await page.close();
  }
  results.realUseP1 = { steps: n, shots };
  console.log(`    P1 real-use script: ${n} steps, each pane's slot checked after each`);
});


console.log('P2: free layout');

const engine = await vite.ssrLoadModule('@elfoqsy/state');
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Two windows on one log, as one workstation's two monitors: /left and /right. */
async function openPair(events = labEvents()) {
  const left = await open('/left', events, undefined, 'reduce', labFixed);
  const right = await open('/right', null, undefined, 'reduce', labFixed);
  await pause(1500);
  return [left, right];
}
const layoutFrames = () => daemon.frames.filter((f) => f.t === 'layout_set');
/** Each window shows the layout's arrangement: the engine's rectangle for every pane of its screen, and no other. */
async function arrangementProblems(pages, layout, folded = [new Set(), new Set()]) {
  const out = [];
  for (const [i, page] of pages.entries()) {
    const w = await readWindow(page);
    if (layout === null) {
      if (!w.classic || w.free) out.push(`screen ${i}: not today's columns`);
      continue;
    }
    if (!w.free) out.push(`screen ${i}: not the layout`);
    const expected = engine.arrange(layout[i], folded[i]).rects;
    const names = layout[i].flat().sort();
    if (!sameJson(Object.keys(w.panes).sort(), names)) out.push(`screen ${i}: shows ${Object.keys(w.panes).sort()}, the layout has ${names}`);
    for (const name of names) {
      const e = expected[name];
      const a = w.panes[name];
      if (a && !(a.x === e.x && a.y === e.y && a.w === e.w && a.h === e.h)) out.push(`screen ${i}: ${name} at ${a.x},${a.y} ${a.w}×${a.h}, the engine says ${e.x},${e.y} ${e.w}×${e.h}`);
      if (a && (w.folds[name] ?? null) !== (e.fold ?? null)) out.push(`screen ${i}: ${name} is ${w.folds[name] ?? 'open'}, the engine says ${e.fold ?? 'open'}`);
    }
    if (w.skeleton || w.chip) out.push(`screen ${i}: a ${w.skeleton ? 'skeleton' : 'chip'} is left`);
    if (layout[i].length === 0 && !w.empty) out.push(`screen ${i}: empty, and does not say so`);
  }
  return out;
}
/** The floating layers, and every pane's box in its slot, as a person would see them. */
async function checksAfterStep(pages, where) {
  for (const [i, page] of pages.entries()) {
    await checkLayers(page, `${where}, screen ${i}`);
    const w = await readWindow(page);
    for (const name of Object.keys(w.panes)) {
      const problems = await checkPane(page, `${where}, screen ${i}, ${name} ${w.panes[name].w}×${w.panes[name].h}`, `.fpane[data-fpane="${name}"]`);
      assert.deepEqual(problems, []);
    }
  }
}
let p2Steps = 0;
const p2Shots = [];
/** A step's picture: both windows, kept apart as <name>.left.png and <name>.right.png (tools/compose joins them for the report). */
async function p2Shot(pages, name, mid = false) {
  if (!screensAt) return;
  const base = `P2-${String(p2Steps).padStart(2, '0')}${mid ? 'a' : ''}-${name}`;
  p2Shots.push(base);
  await Promise.all(pages.map((page, i) => page.screenshot({ path: join(screensAt, `${base}.${i === 0 ? 'left' : 'right'}.png`) })));
}

/** The two windows and the layout the real-use script has reached, for the steps that go on from it. */
let p2 = null;

await test('P2: the grip, the skeleton and the drop: a pane carried to each kind of zone on both screens lands exactly where the skeleton was, in both windows, at once', async () => {
  const pages = await openPair();
  const [left, right] = pages;
  let layout = null; // no layout saved
  const DEFAULT = engine.DEFAULT_LAYOUT;

  // Step 1: the grip, on hover, at the top centre of the pane under the pointer, with today's screens as they are.
  p2Steps++;
  assert.deepEqual(await arrangementProblems(pages, null), []);
  const sprint = await paneBox(left, 'sprint');
  await left.mouse.move(sprint.x + sprint.width / 2 + 90, sprint.y + 200, { steps: 6 });
  await until('the grip', async () => (await readWindow(left)).grip);
  const grip = (await readWindow(left)).grip;
  assert.equal(grip.pane, 'sprint');
  assert.ok(Math.abs(grip.x + grip.w / 2 - (sprint.x + sprint.width / 2)) <= 1, 'the grip is at the pane’s top centre');
  assert.ok(Math.abs(grip.y + grip.h / 2 - sprint.y) <= 1 && grip.w === 52 && grip.h === 24, 'the grip straddles the pane’s top edge, 52 × 24');
  assert.equal((await readWindow(right)).grip, null, 'no grip in the other window');
  await pause(900);
  await checksAfterStep([left], 'step 1');
  await p2Shot(pages, 'the-grip-shows-at-the-top-centre-of-the-pane-under-the-pointer');

  const kinds = ['above', 'below', 'left', 'right'];
  const order = ['conversation', 'terminals', 'sprint', 'map', 'elfoqsy'];
  const covered = new Set();
  let outcomes = { moved: 0, refused: 0, same: 0, across: 0, today: 0 };
  for (const pane of order) {
    for (const [ki, kind] of kinds.entries()) {
      // Once on the screen it is on, once on the other: so both screens get each kind of zone, and half the drags cross windows.
      for (const where of ['same', 'other']) {
        p2Steps++;
        const here = layout ?? DEFAULT;
        const from = engine.screenOf(here, pane);
        const screen = where === 'same' ? from : 1 - from;
        const base = engine.without(here, pane);
        const rects = engine.arrange(base[screen]).rects;
        const candidates = base[screen].flat();
        const target = candidates.length ? candidates[(order.indexOf(pane) + ki) % candidates.length] : null;
        const to = target ? zonePoint(kind, rects[target]) : { x: 960, y: 600 };
        const zone = engine.targetAt(to, screen, base[screen], rects);
        const after = zone ? engine.insert(base, zone, pane) : null;
        const feasible = !!after && engine.fits(after);
        if (feasible) covered.add(`${kind}-${screen}`);
        const name = `${pane}-${kind}-${target ?? 'the-empty-screen'}-on-the-${screen === 0 ? 'left' : 'right'}-screen`;
        const before = layoutFrames().length;

        let carry;
        if (from !== screen) outcomes.across++;
        if (from === screen) {
          const hand = await takeGrip(pages[from], pane);
          await approach(pages[from], hand, to);
        } else {
          carry = await carryAcross(pages[from], pages[screen], pane);
          await carry.carry(to);
        }
        // Mid-drag: the skeleton at the real size in the zone, the others making room, the chip; or nothing, when it does not fit.
        const mid = await readWindow(pages[screen]);
        if (feasible) {
          const want = engine.arrange(after[screen]).rects;
          assert.ok(mid.skeleton, `${name}: a skeleton shows`);
          assert.equal(mid.skeleton.pane, pane);
          assert.deepEqual({ x: mid.skeleton.x, y: mid.skeleton.y, w: mid.skeleton.w, h: mid.skeleton.h }, want[pane], `${name}: the skeleton is the moved pane's real rectangle`);
          for (const other of after[screen].flat().filter((p) => p !== pane)) assert.deepEqual(mid.panes[other], want[other], `${name}: ${other} makes room`);
          assert.equal(mid.chip, pane, `${name}: the chip follows the pointer`);
        } else {
          assert.equal(mid.skeleton, null, `${name}: nothing shows when the drop would push a pane below its minimum`);
          for (const other of base[screen].flat()) assert.deepEqual(mid.panes[other], rects[other], `${name}: ${other} stays`);
        }
        if (from !== screen) {
          const src = await readWindow(pages[from]);
          assert.equal(src.skeleton, null, `${name}: the window it left shows no skeleton`);
          assert.equal(src.chip, null, `${name}: the window it left shows no chip`);
          assert.ok(!(pane in src.panes), `${name}: and the pane is gone from it (its place is closed up)`);
        }
        if (ki === 0 && (screen === 0 || order.indexOf(pane) < 2)) await p2Shot(pages, name, true);

        // Let go.
        if (from === screen) await pages[from].mouse.up();
        else await carry.release(to, feasible);
        await pause(900);
        const same = feasible && engine.sameLayout(after, layout);
        if (feasible && !same) {
          await until(`${name}: the layout`, async () => layoutFrames().length > before);
          assert.equal(layoutFrames().length, before + 1, `${name}: one layout is sent`);
          assert.deepEqual(layoutFrames().at(-1).layout, engine.savedLayout(after), `${name}: exactly the layout the skeleton showed (today's arrangement is saved as none)`);
          layout = engine.savedLayout(after);
          outcomes.moved++;
        } else {
          assert.equal(layoutFrames().length, before, `${name}: nothing is sent`);
          outcomes[feasible ? 'same' : 'refused']++;
        }
        await until(`${name}: both windows agree`, async () => (await arrangementProblems(pages, layout)).length === 0, 6000).catch(async () => assert.deepEqual(await arrangementProblems(pages, layout), []));
        if (feasible && !same && layout === null) {
          // The drop gave today's arrangement: no layout is saved, and both screens are today's own columns (arrangementProblems
          // has checked it); nothing of the drag is left behind.
          for (const page of pages) {
            const w = await readWindow(page);
            assert.ok(w.classic && !w.skeleton && !w.chip, `${name}: today's screens, nothing of the drag left`);
          }
          outcomes.today++;
        } else if (feasible && !same) {
          // The drop is the skeleton, exactly; and nothing it left behind blocks a click.
          const now = (await readWindow(pages[screen])).panes[pane];
          assert.deepEqual(now, mid.skeleton && { x: mid.skeleton.x, y: mid.skeleton.y, w: mid.skeleton.w, h: mid.skeleton.h }, `${name}: the pane is where the skeleton was`);
          // Neither the skeleton nor the chip is left where the pointer was; and a click in the middle of the pane lands in it.
          const hit = await pages[screen].evaluate(({ at, mid: centre }) => {
            const first = document.elementFromPoint(at.x, at.y);
            const inPane = document.elementFromPoint(centre.x, centre.y)?.closest('[data-fpane]')?.dataset.fpane ?? null;
            return { blocked: !!first?.closest('.fskel, .fchip'), inPane };
          }, { at: to, mid: { x: now.x + now.w / 2, y: now.y + now.h / 2 } });
          assert.equal(hit.blocked, false, `${name}: nothing it drew blocks the pointer's place`);
          assert.equal(hit.inPane, pane, `${name}: a click in the middle of the pane lands in it`);
        }
        await checksAfterStep(pages, name);
        await p2Shot(pages, name);
        await pause(500);
      }
    }
  }
  for (const kind of kinds) for (const screen of [0, 1]) assert.ok(covered.has(`${kind}-${screen}`), `a drop to a zone of kind ${kind} on screen ${screen} was made`);
  results.realUseP2a = { steps: p2Steps, outcomes };
  console.log(`    P2 drags: ${p2Steps - 1} drags to every zone kind on both screens (${outcomes.across} from one window to the other), ${outcomes.moved} dropped (${outcomes.today} of them gave today's arrangement, saved as no layout), ${outcomes.refused} shown nothing and changed nothing, ${outcomes.same} back where they were`);
  p2 = { pages, layout };
});


/** A layout the daemon has saved, as the log carries it. */
const layoutEvent = (layout) => {
  const seq = (daemon.events.at(-1)?.seq ?? 0) + 1;
  return { seq, id: `L${seq}`, ts: new Date(daemon.now()).toISOString(), source: 'orchestrator', type: 'layout.changed', payload: { layout, by: 'you' } };
};
const menuButton = (page) => page.locator('.fmenu-button');
async function openMenu(page) {
  await menuButton(page).click();
  await page.locator('[data-layer="menu"]').waitFor();
  await pause(400);
}
async function menuChoose(page, text) {
  await page.locator('[data-layer="menu"] [role="menuitem"]', { hasText: text }).click();
  await pause(700);
}
/** One step of the script that goes on from the drags: do it, let both windows settle, check them, take the picture. */
async function p2Step(name, pages, layout, act) {
  p2Steps++;
  const before = layoutFrames().length;
  await act();
  await pause(900);
  await until(`${name}: both windows agree`, async () => (await arrangementProblems(pages, layout)).length === 0, 6000).catch(async () => assert.deepEqual(await arrangementProblems(pages, layout), [], name));
  await checksAfterStep(pages, name);
  await p2Shot(pages, name);
  return layoutFrames().length - before;
}

await test('P2 real use, continued: the screen menu, an empty screen emptied and filled again, reset, and both windows reloaded to see the layout kept', async () => {
  assert.ok(p2, 'the drags run first');
  const { pages } = p2;
  const [left, right] = pages;
  let layout = p2.layout;

  // The menu is a floating layer: opened, checked with the others, listing this screen's panes and the reset.
  p2Steps++;
  await openMenu(right);
  const items = await right.locator('[data-layer="menu"] [role="menuitem"]').allInnerTexts();
  const names = (i) => layout[i].flat().map((id) => `Move ${engine.PANES[id].name} to the ${i === 0 ? 'right' : 'left'} screen`);
  assert.deepEqual(items, [...names(1), 'Reset the layout']);
  await checkLayers(right, 'the screen menu');
  await pause(500);
  await p2Shot(pages, 'the-screen-menu-lists-the-panes-here-and-the-reset');
  await right.keyboard.press('Escape');
  assert.equal(await right.locator('[data-layer="menu"]').count(), 0, 'Escape closes the menu');
  await pause(400);

  // Empty the right screen with the menu: every pane on it moved to the left.
  for (const pane of [...layout[1].flat()]) {
    const moved = engine.moveToOtherScreen(layout, pane);
    const sent = await p2Step(`the-menu-moves-${pane}-to-the-left-screen`, pages, moved, async () => {
      await openMenu(right);
      await menuChoose(right, `Move ${engine.PANES[pane].name} to the left screen`);
    });
    assert.equal(sent, 1);
    assert.deepEqual(layoutFrames().at(-1).layout, engine.savedLayout(moved));
    layout = moved;
  }
  assert.deepEqual(layout[1], []);
  const empty = await readWindow(right);
  assert.ok(empty.empty, 'the right screen says it is empty');
  const offered = await right.locator('.fempty-pane').allInnerTexts();
  assert.deepEqual(offered, engine.PANE_IDS.map((id) => engine.PANES[id].name), 'it offers the panes of the other screen');
  assert.equal(await right.locator('.fempty-title').innerText(), 'Nothing on this screen');

  // Fill it again with a button, then empty it and fill it by dragging a pane from the other window, dropped anywhere on it.
  {
    const filled = engine.bringHere(layout, 'terminals', 1);
    const sent = await p2Step('a-button-brings-terminals-to-the-empty-screen', pages, filled, async () => {
      await right.locator('.fempty-pane', { hasText: 'Terminals' }).click();
    });
    assert.equal(sent, 1);
    assert.deepEqual(layoutFrames().at(-1).layout, engine.savedLayout(filled));
    layout = filled;
  }
  {
    const emptied = engine.moveToOtherScreen(layout, 'terminals');
    await p2Step('the-menu-empties-the-right-screen-again', pages, emptied, async () => {
      await openMenu(right);
      await menuChoose(right, 'Move Terminals to the left screen');
    });
    layout = emptied;
    p2Steps++;
    const before = layoutFrames().length;
    const carry = await carryAcross(left, right, 'conversation');
    const anywhere = { x: 300, y: 820 };
    await carry.carry(anywhere);
    const mid = await readWindow(right);
    const want = engine.insert(engine.without(layout, 'conversation'), { screen: 1, kind: 'col', col: 0 }, 'conversation');
    assert.ok(mid.skeleton, 'a drop anywhere on an empty screen shows a skeleton');
    assert.deepEqual({ x: mid.skeleton.x, y: mid.skeleton.y, w: mid.skeleton.w, h: mid.skeleton.h }, engine.arrange(want[1]).rects.conversation);
    await pause(500);
    await p2Shot(pages, 'a-pane-carried-onto-the-empty-screen-shows-where-it-lands', true);
    await carry.release(anywhere);
    await pause(900);
    await until('the pane dropped on the empty screen', async () => layoutFrames().length > before);
    assert.deepEqual(layoutFrames().at(-1).layout, engine.savedLayout(want));
    layout = engine.savedLayout(want);
    await until('both windows agree', async () => (await arrangementProblems(pages, layout)).length === 0);
    await checksAfterStep(pages, 'filled by a drag');
    await p2Shot(pages, 'a-pane-dropped-on-the-empty-screen-fills-it');
  }

  // Reset: the menu's last item; both windows are today's columns again, and the log carries it as no layout.
  {
    const sent = await p2Step('reset-puts-both-screens-back-as-today', pages, null, async () => {
      await openMenu(right);
      await menuChoose(right, 'Reset the layout');
    });
    assert.equal(sent, 1);
    assert.equal(layoutFrames().at(-1).layout, null);
    layout = null;
  }

  // A pane carried from today's screens to the other window, so there is a layout to reload.
  const arranged = engine.insert(engine.without(engine.DEFAULT_LAYOUT, 'conversation'), { screen: 1, kind: 'row', col: 0, row: 0 }, 'conversation');
  {
    p2Steps++;
    const before = layoutFrames().length;
    const rects = engine.arrange(engine.without(engine.DEFAULT_LAYOUT, 'conversation')[1]).rects;
    const to = zonePoint('above', rects.map);
    const carry = await carryAcross(left, right, 'conversation');
    await carry.carry(to);
    await carry.release(to);
    await pause(900);
    await until('the layout is saved', async () => layoutFrames().length > before);
    assert.deepEqual(layoutFrames().at(-1).layout, engine.savedLayout(arranged));
    layout = engine.savedLayout(arranged);
    await until('both windows agree', async () => (await arrangementProblems(pages, layout)).length === 0);
    await p2Shot(pages, 'a-pane-carried-out-of-todays-screens-above-the-map');
  }

  // Reload both windows: the layout is in the log, so each comes back as it was.
  {
    p2Steps++;
    await Promise.all(pages.map((page) => page.reload()));
    await pause(1800);
    assert.deepEqual(await arrangementProblems(pages, layout), []);
    await checksAfterStep(pages, 'after a reload');
    await p2Shot(pages, 'both-windows-reloaded-keep-the-layout');
  }

  // Reset, and reload again: no layout in the log is today's screens.
  {
    await p2Step('reset-again', pages, null, async () => {
      await openMenu(right);
      await menuChoose(right, 'Reset the layout');
    });
    p2Steps++;
    await Promise.all(pages.map((page) => page.reload()));
    await pause(1800);
    assert.deepEqual(await arrangementProblems(pages, null), []);
    await p2Shot(pages, 'reset-and-reloaded-both-windows-are-todays-screens');
  }
  results.realUseP2 = { steps: p2Steps, shots: p2Shots };
  console.log(`    P2 real-use script: ${p2Steps} steps, floating layers and every pane's box checked after each`);
  for (const page of pages) await page.close();
  p2 = null;
});

await test('P2: a drop that would push a pane below its minimum shows nothing and changes nothing, in a window and across windows', async () => {
  // Three panes in a column are 310 high each; a fourth would leave 228, under the 240 minimum.
  const stacked = [[['sprint', 'elfoqsy', 'conversation']], [['map'], ['terminals']]];
  const pages = await openPair();
  const [left, right] = pages;
  daemon.push(layoutEvent(stacked));
  await until('both windows show it', async () => (await arrangementProblems(pages, stacked)).length === 0);
  const frames = layoutFrames().length;
  const base = engine.without(stacked, 'map');
  const rects = engine.arrange(base[0]).rects;

  // Across windows: the map carried from the right window onto the top of the stack in the left one.
  for (const kind of ['above', 'below']) {
    const to = zonePoint(kind, rects.elfoqsy);
    const carry = await carryAcross(right, left, 'map');
    await carry.carry(to);
    const mid = await readWindow(left);
    assert.equal(mid.skeleton, null, `${kind}: no skeleton`);
    assert.equal(mid.chip, 'map', `${kind}: the chip still follows the pointer`);
    for (const pane of ['sprint', 'elfoqsy', 'conversation']) assert.deepEqual(mid.panes[pane], engine.arrange(stacked[0]).rects[pane], `${kind}: ${pane} stays`);
    p2Steps++;
    await pause(700);
    await p2Shot(pages, `the-map-over-the-top-of-a-full-stack-shows-nothing-${kind}`, true);
    await carry.release(to, false);
    await pause(900);
    assert.equal(layoutFrames().length, frames, `${kind}: nothing is sent`);
    assert.deepEqual(await arrangementProblems(pages, stacked), [], `${kind}: nothing changed`);
  }
  // In one window: Conversation carried over the three-deep column's top, from the column beside it.
  {
    const wide = [[['sprint'], ['elfoqsy', 'conversation', 'map']], [['terminals']]];
    daemon.push(layoutEvent(wide));
    await until('both windows show it', async () => (await arrangementProblems(pages, wide)).length === 0);
    const base2 = engine.without(wide, 'sprint');
    const r2 = engine.arrange(base2[0]).rects;
    const to = zonePoint('above', r2.conversation);
    const hand = await takeGrip(left, 'sprint');
    await approach(left, hand, to);
    const mid = await readWindow(left);
    assert.equal(mid.skeleton, null, 'a fourth in the column shows no skeleton');
    p2Steps++;
    await p2Shot(pages, 'sprint-over-a-full-column-in-the-same-window-shows-nothing', true);
    await left.mouse.up();
    await pause(900);
    assert.equal(layoutFrames().length, frames, 'nothing is sent');
    assert.deepEqual(await arrangementProblems(pages, wide), [], 'and the window shows the layout it had');
    await checksAfterStep(pages, 'after a refused drop');
  }
  for (const page of pages) await page.close();
});

await test('P2: while the pointer is over the skeleton the target holds; leaving it for another zone changes the skeleton', async () => {
  const pages = await openPair();
  const [left] = pages;
  const layout = [[['sprint'], ['elfoqsy'], ['conversation']], [['map'], ['terminals']]];
  daemon.push(layoutEvent(layout));
  await until('shown', async () => (await arrangementProblems(pages, layout)).length === 0);
  const base = engine.without(layout, 'sprint');
  const rects = engine.arrange(base[0]).rects;
  const to = zonePoint('above', rects.conversation);
  const hand = await takeGrip(left, 'sprint');
  await approach(left, hand, to);
  const first = (await readWindow(left)).skeleton;
  assert.ok(first, 'the skeleton shows above the conversation');
  // The middle of the skeleton is where the conversation was, until it made room: a zone of its own, were it not held.
  await left.mouse.move(first.x + first.w / 2, first.y + first.h / 2, { steps: 8 });
  await pause(300);
  assert.deepEqual((await readWindow(left)).skeleton, first, 'the target holds while the pointer is over the skeleton');
  // Out of it, onto the right half of Elfoqsy's panel: another zone.
  const elf = (await readWindow(left)).panes.elfoqsy;
  await left.mouse.move(40, 40, { steps: 6 });
  await left.mouse.move(elf.x + elf.w * 0.8, elf.y + elf.h / 2);
  await pause(300);
  const second = (await readWindow(left)).skeleton;
  assert.ok(second && (second.w !== first.w || second.h !== first.h), 'out of the skeleton, the zone under the pointer decides again');
  await left.mouse.up();
  await pause(800);
  assert.deepEqual(layoutFrames().at(-1).layout, engine.insert(base, { screen: 0, kind: 'col', col: 1 }, 'sprint'), 'the drop is the skeleton it was let go over');
  for (const page of pages) await page.close();
});

await test('P2: a pane asks the pane that owns the thing, in the other window: a ticket link opens the sprint, a chosen conversation the conversation, a clicked agent its terminal', async () => {
  // Conversation and Elfoqsy on the left; Sprint, the map and the terminals on the right; and the other way round.
  const split = [[['elfoqsy'], ['conversation']], [['sprint'], ['map'], ['terminals']]];
  const pages = await openPair();
  const [left, right] = pages;
  daemon.push(layoutEvent(split));
  await until('shown', async () => (await arrangementProblems(pages, split)).length === 0);

  // "Read the verdict" in the conversation (left) opens the ticket, at the verdict, in the Sprint pane (right).
  assert.equal(await left.locator('.tv-key').count(), 0, 'no ticket on the left: its sprint is on the other screen');
  await left.locator('.thread button', { hasText: 'Read the verdict' }).click();
  await right.locator('.tv-key a').waitFor();
  assert.match(await right.locator('.tv-key').innerText(), /SHOP-3546/);
  assert.equal(await left.locator('.tv-key').count(), 0);

  // A conversation chosen in Elfoqsy's column opens in the conversation pane, in this window and, one screen away, in the other.
  const second = left.locator('.conversation', { hasText: 'Plan the SHOP-1164 stall fix' });
  await second.click();
  await until('the conversation changed', async () => (await left.locator('.chat-title').innerText()).includes('SHOP-1164'));
  const swapped = [[['conversation']], [['sprint'], ['elfoqsy'], ['map'], ['terminals']]];
  daemon.push(layoutEvent(swapped));
  await until('rearranged', async () => (await arrangementProblems(pages, swapped)).length === 0).catch(async (e) => {
    throw new Error(`${e.message} ${JSON.stringify(await arrangementProblems(pages, swapped))}`);
  });
  await right.locator('.conversation', { hasText: 'Why does checkout drop 429 errors?' }).click();
  await until('the conversation, one screen away, changed', async () => (await left.locator('.chat-title').innerText()).includes('429'));

  // A click on an agent of the map (left) focuses its terminal (right).
  const mapLeft = [[['map']], [['sprint'], ['elfoqsy'], ['conversation'], ['terminals']]];
  daemon.push(layoutEvent(mapLeft));
  await until('map on the left', async () => (await arrangementProblems(pages, mapLeft)).length === 0);
  await pause(1500);
  const focusedRun = () => right.evaluate(() => document.querySelector('section.pane--focused')?.getAttribute('data-run') ?? null);
  const agents = await left.evaluate(() => [...document.querySelectorAll('button.map-agent')].map((b) => b.getAttribute('data-run')));
  assert.ok(agents.length > 1, 'the map has agents');
  const before = await focusedRun();
  const pick = agents.find((r) => r !== before);
  const at = await left.locator(`button.map-agent[data-run="${pick}"]`).boundingBox();
  await left.mouse.click(at.x + at.width / 2, at.y + at.height / 2);
  await until('its terminal is focused in the other window', async () => (await focusedRun()) === pick);
  for (const page of pages) await page.close();
});

await test('P2: a drop that gives today’s arrangement saves no layout, and both screens are today’s again, across windows and in one', async () => {
  const pages = await openPair();
  const [left, right] = pages;
  const DEFAULT = engine.DEFAULT_LAYOUT;
  // Out: the conversation to the top of the map, in the other window.
  const away = engine.insert(engine.without(DEFAULT, 'conversation'), { screen: 1, kind: 'row', col: 0, row: 0 }, 'conversation');
  {
    const rects = engine.arrange(engine.without(DEFAULT, 'conversation')[1]).rects;
    const to = zonePoint('above', rects.map);
    const carry = await carryAcross(left, right, 'conversation');
    await carry.carry(to);
    await carry.release(to);
    await until('the layout is saved', async () => layoutFrames().length === 1);
    assert.deepEqual(layoutFrames()[0].layout, away);
    await until('both windows show it', async () => (await arrangementProblems(pages, away)).length === 0);
  }
  // Back: across windows, to the right of Elfoqsy, which is today's arrangement.
  {
    const base = engine.without(away, 'conversation');
    const rects = engine.arrange(base[0]).rects;
    const to = zonePoint('right', rects.elfoqsy);
    assert.ok(engine.sameLayout(engine.insert(base, engine.targetAt(to, 0, base[0], rects), 'conversation'), null), 'this drop gives today’s arrangement');
    const carry = await carryAcross(right, left, 'conversation');
    await carry.carry(to);
    assert.ok((await readWindow(left)).skeleton, 'the skeleton shows, as for any drop');
    await carry.release(to);
    await until('no layout is saved', async () => layoutFrames().length === 2);
    assert.equal(layoutFrames()[1].layout, null, 'the frame says no layout');
    await until('both windows are today’s screens', async () => (await arrangementProblems(pages, null)).length === 0);
    await pause(600);
    await checksAfterStep(pages, 'back to today');
  }
  // The same inside one window: out to the left of Sprint, and back to the right of Elfoqsy.
  {
    const base = engine.without(DEFAULT, 'conversation');
    const r1 = engine.arrange(base[0]).rects;
    const to1 = zonePoint('left', r1.sprint);
    const hand = await takeGrip(left, 'conversation');
    await approach(left, hand, to1);
    await left.mouse.up();
    await until('a layout is saved', async () => layoutFrames().length === 3);
    const mine = engine.insert(base, { screen: 0, kind: 'col', col: 0 }, 'conversation');
    assert.deepEqual(layoutFrames()[2].layout, mine);
    await until('shown', async () => (await arrangementProblems(pages, mine)).length === 0);
    const base2 = engine.without(mine, 'conversation');
    const r2 = engine.arrange(base2[0]).rects;
    const to2 = zonePoint('right', r2.elfoqsy);
    const hand2 = await takeGrip(left, 'conversation');
    await approach(left, hand2, to2);
    await left.mouse.up();
    await until('no layout is saved again', async () => layoutFrames().length === 4);
    assert.equal(layoutFrames()[3].layout, null);
    await until('both windows are today’s screens', async () => (await arrangementProblems(pages, null)).length === 0);
  }
  for (const page of pages) await page.close();
});

await test('P2: an open ticket follows its pane to the other window, and through a rearrangement of the window it is in', async () => {
  // In today's screens: a ticket is open, a drag begins (the screen is rearranged while the pane is carried) and is cancelled.
  {
    const page = await open('/left', labEvents(), undefined, 'reduce', labFixed);
    await pause(1200);
    await openTicket(page, 'SHOP-3538');
    const hand = await takeGrip(page, 'conversation');
    await page.mouse.move(hand.x, 1075, { steps: 6 });
    await pause(300);
    assert.ok((await readWindow(page)).free, 'the screen is the layout engine’s while the pane is carried');
    await page.mouse.up();
    await pause(900);
    assert.ok((await readWindow(page)).classic, 'and today’s again after the cancel');
    assert.equal(await page.locator('.tv-key a').textContent(), 'SHOP-3538', 'the ticket is still open');
    await page.close();
  }
  // Across windows: Sprint on the right with a ticket open, moved to the left by the screen menu.
  const split = [[['elfoqsy'], ['conversation']], [['sprint'], ['map'], ['terminals']]];
  const pages = await openPair();
  const [left, right] = pages;
  daemon.push(layoutEvent(split));
  await until('shown', async () => (await arrangementProblems(pages, split)).length === 0);
  await left.locator('.thread button', { hasText: 'Read the verdict' }).click();
  await right.locator('.tv-key a').waitFor();
  assert.equal(await right.locator('.tv-key a').textContent(), 'SHOP-3546');
  const moved = engine.moveToOtherScreen(split, 'sprint');
  await openMenu(right);
  await menuChoose(right, 'Move Sprint to the left screen');
  await until('the sprint is on the left', async () => (await arrangementProblems(pages, moved)).length === 0);
  await left.locator('.tv-key a').waitFor();
  assert.equal(await left.locator('.tv-key a').textContent(), 'SHOP-3546', 'the ticket is open in the window the pane went to');
  assert.equal(await right.locator('.tv-key').count(), 0);
  await checksAfterStep(pages, 'the ticket followed its pane');
  p2Steps++;
  await p2Shot(pages, 'the-open-ticket-follows-the-sprint-to-the-other-window');
  // And back: the pane goes to the right again with what it showed, and what it shows there is what is open now.
  await left.locator('.tv-key a').waitFor();
  const back = engine.moveToOtherScreen(moved, 'sprint');
  await openMenu(left);
  await menuChoose(left, 'Move Sprint to the right screen');
  await until('the sprint is on the right again', async () => (await arrangementProblems(pages, back)).length === 0);
  await right.locator('.tv-key a').waitFor();
  assert.equal(await right.locator('.tv-key a').textContent(), 'SHOP-3546');
  assert.equal(await left.locator('.tv-key').count(), 0);
  for (const page of pages) await page.close();
});

console.log('C: collapse, add and remove');

let cSteps = 0;
const cShots = [];
/** A step's picture, as the P2 ones: both windows, <name>.left.png and <name>.right.png. */
async function cShot(pages, name, mid = false) {
  if (!screensAt) return;
  const base = `C-${String(cSteps).padStart(2, '0')}${mid ? 'a' : ''}-${name}`;
  cShots.push(base);
  await Promise.all(pages.map((page, i) => page.screenshot({ path: join(screensAt, `${base}.${i === 0 ? 'left' : 'right'}.png`) })));
}
/** The pointer rests off every pane, as a person's does between actions: no grip, no +, no x. */
const park = (pages) => Promise.all(pages.map((page) => page.mouse.move(2, 2)));
/** The panes folded on each screen, from the set a window has folded. */
const foldedOn = (layout, set) => [0, 1].map((i) => new Set([...set].filter((p) => layout[i].flat().includes(p))));
/** One step of this script: do it, let both windows settle, compare them with the engine, check them as a person would, picture. */
async function cStep(name, pages, layout, folded, act) {
  cSteps++;
  await act();
  await pause(900);
  const on = foldedOn(layout, folded);
  await until(`${name}: both windows agree`, async () => (await arrangementProblems(pages, layout, on)).length === 0, 6000).catch(async () => assert.deepEqual(await arrangementProblems(pages, layout, on), [], name));
  await checksAfterStep(pages, name);
  await cShot(pages, name);
}
const hideButton = (page, pane) => page.locator(`.fpane[data-fpane="${pane}"] button.collapse:not(.pane-x)`);
const NAMES = { sprint: 'the sprint', elfoqsy: 'Elfoqsy', conversation: 'the conversation', map: 'the live map', terminals: 'the agent terminals' };
const screenWindow = (pages, layout, pane) => pages[engine.screenOf(layout, pane)];

await test('C real use: every pane folded to today’s rail and opened again, on both screens and inside a stack; the icon draws the layout', async () => {
  const pages = await openPair();
  const [left, right] = pages;
  // Each pane in a column of its own, on both screens: not today's arrangement (so a layout is kept), but today's columns.
  const A = [[['sprint'], ['conversation'], ['elfoqsy']], [['terminals'], ['map']]];
  daemon.push(layoutEvent(A));
  await until('both windows show it', async () => (await arrangementProblems(pages, A)).length === 0);
  const folded = new Set();
  const rails = { sprint: 'Sprint, hidden', conversation: 'Conversation, hidden', elfoqsy: 'Elfoqsy, hidden', map: 'Live map, hidden', terminals: 'Agent terminals, hidden' };
  await park(pages);
  await cStep('both-screens-open-a-pane-in-each-column', pages, A, folded, async () => {});

  // Each pane folds to a rail and opens again; its icon is the screen's layout, its own cell filled when open, dashed when folded.
  for (const pane of ['sprint', 'conversation', 'elfoqsy', 'terminals', 'map']) {
    const page = screenWindow(pages, A, pane);
    const before = await readWindow(page);
    assert.equal(before.controls[pane].filled, 1, `${pane}: its own cell is filled while it is open`);
    assert.equal(before.controls[pane].cells, 3 - (engine.screenOf(A, pane) === 1 ? 1 : 0), `${pane}: one cell for each pane on the screen`);
    assert.equal(before.controls[pane].hide.y - before.panes[pane].y, 24, `${pane}: its hide button sits 24 px under its top`);
    assert.equal(before.controls[pane].hide.w, 36);

    folded.add(pane);
    await cStep(`${pane}-folds-to-its-rail`, pages, A, folded, async () => {
      await hideButton(page, pane).click();
      await park(pages);
    });
    const w = await readWindow(page);
    assert.equal(w.folds[pane], 'rail');
    assert.deepEqual({ w: w.panes[pane].w, h: w.panes[pane].h }, { w: 56, h: 972 }, `${pane}: as wide as today’s rail, as tall as the screen`);
    assert.equal(await page.locator(`.fpane[data-fpane="${pane}"] [aria-label="${rails[pane]}"]`).count(), 1, `${pane}: today’s rail`);
    assert.match(w.controls[pane].hide.label, /^Show /, `${pane}: its button shows it`);
    assert.equal(w.controls[pane].dashed, 1, `${pane}: its own cell is dashed while it is folded`);
    assert.equal(w.controls[pane].x, null, `${pane}: a folded pane has no x`);

    folded.delete(pane);
    await cStep(`${pane}-opens-again`, pages, A, folded, async () => {
      await hideButton(page, pane).click();
      await park(pages);
    });
    assert.equal((await readWindow(page)).folds[pane], null);
  }

  // Inside a stack a folded pane is a bar with the same elements in a row.
  const B = [[['sprint', 'conversation'], ['elfoqsy']], [['map', 'terminals']]];
  daemon.push(layoutEvent(B));
  await until('stacks', async () => (await arrangementProblems(pages, B)).length === 0);
  await park(pages);
  await cStep('stacks-sprint-over-the-conversation-and-the-map-over-the-terminals', pages, B, folded, async () => {});
  for (const group of [['conversation'], ['sprint'], ['terminals'], ['map']]) {
    const [pane] = group;
    const page = screenWindow(pages, B, pane);
    folded.add(pane);
    await cStep(`${pane}-in-a-stack-folds-to-a-bar`, pages, B, folded, async () => {
      await hideButton(page, pane).click();
      await park(pages);
    });
    const w = await readWindow(page);
    assert.equal(w.folds[pane], 'bar', `${pane}: a bar`);
    assert.equal(w.panes[pane].h, 48, `${pane}: 48 high`);
    assert.equal(await page.locator(`.fpane[data-fpane="${pane}"] [aria-label="${rails[pane]}"]`).count(), 1, `${pane}: the same elements as its rail`);
    // The elements are in a row: the show button and the first of them side by side, inside the bar.
    const row = await page.evaluate((id) => {
      const box = document.querySelector(`.fpane[data-fpane="${id}"]`).getBoundingClientRect();
      const kids = [...document.querySelector(`.fpane[data-fpane="${id}"] [aria-label$=", hidden"]`).children].map((c) => c.getBoundingClientRect());
      return { rowed: kids.every((k) => Math.abs(k.y + k.height / 2 - (box.y + box.height / 2)) < 12), inside: kids.every((k) => k.x >= box.x && k.x + k.width <= box.x + box.width && k.y >= box.y && k.y + k.height <= box.y + box.height) };
    }, pane);
    assert.deepEqual(row, { rowed: true, inside: true }, `${pane}: its elements in a row inside the bar`);
  }
  // Both panes of a stack folded: two bars, and the column does not grow.
  for (const pane of ['conversation', 'sprint', 'terminals', 'map']) {
    const page = screenWindow(pages, B, pane);
    folded.delete(pane);
    await cStep(`${pane}-opens-again-from-its-bar`, pages, B, folded, async () => {
      await hideButton(page, pane).click();
      await park(pages);
    });
  }
  results.cFolds = { steps: cSteps };
  p2 = { pages, layout: B };
});

await test('C real use, continued: the x takes each pane off the screens, and + brings each back', async () => {
  const pages = p2 ? p2.pages : await openPair();
  const [left, right] = pages;
  let layout = [[['sprint'], ['conversation'], ['elfoqsy']], [['terminals'], ['map']]];
  daemon.push(layoutEvent(layout));
  await until('rearranged', async () => (await arrangementProblems(pages, layout)).length === 0);
  const folded = new Set();
  await park(pages);

  // Each pane: the x shows on hover beside its hide button, same size; it takes the pane off the screens and the place closes up;
  // then one + at the edge of a neighbour, its menu, and the pane back on that side.
  const trips = [
    ['conversation', 'right'],
    ['sprint', 'below'],
    ['terminals', 'left'],
    ['elfoqsy', 'above'],
    ['map', 'right'],
  ];
  for (const [pane, side] of trips) {
    const page = screenWindow(pages, layout, pane);
    const box = (await readWindow(page)).panes[pane];
    // The x: hidden at rest, shown on hover, right of the hide button, the same size and style.
    let w = await readWindow(page);
    assert.equal(w.controls[pane].x.opacity, 0, `${pane}: no x at rest`);
    await page.mouse.move(box.x + box.w / 2 + 40, box.y + box.h / 2, { steps: 5 });
    await until(`${pane}: its x`, async () => (await readWindow(page)).controls[pane].x.opacity === 1);
    w = await readWindow(page);
    assert.ok(w.controls[pane].x.x >= w.controls[pane].hide.x + w.controls[pane].hide.w, `${pane}: the x is right of its hide button`);
    assert.deepEqual({ w: w.controls[pane].x.w, h: w.controls[pane].x.h, y: w.controls[pane].x.y }, { w: 36, h: 36, y: w.controls[pane].hide.y }, `${pane}: the same size, at the same height`);
    cSteps++;
    await pause(500);
    await cShot(pages, `${pane}-hover-shows-its-x-beside-its-hide-button`);

    // Take it off the screens.
    const removed = engine.without(layout, pane);
    const before = layoutFrames().length;
    cSteps++;
    await page.locator(`.fpane[data-fpane="${pane}"] button.pane-x`).click();
    await park(pages);
    await until(`${pane}: removed`, async () => layoutFrames().length > before);
    assert.deepEqual(layoutFrames().at(-1).layout, engine.savedLayout(removed), `${pane}: the layout without it`);
    layout = removed;
    await pause(900);
    await until(`${pane}: its place closes up`, async () => (await arrangementProblems(pages, layout)).length === 0);
    assert.ok(!(pane in (await readWindow(page)).panes) && !(pane in (await readWindow(pages[page === left ? 1 : 0])).panes), `${pane}: on neither screen`);
    await checksAfterStep(pages, `${pane} removed`);
    await cShot(pages, `${pane}-removed-and-its-place-closes-up`);

    // One + at the edge nearest the pointer, in the gap at the edge's middle.
    const anchor = layout[engine.screenOf(layout, layout[0].flat()[0]) ?? 0].flat()[0];
    const home = pages[0];
    const anchorPane = layout[0].flat()[0];
    const aw = (await readWindow(home)).panes[anchorPane];
    const edge = { right: { x: aw.x + aw.w - 14, y: aw.y + aw.h / 2 }, below: { x: aw.x + aw.w / 2 - 80, y: aw.y + aw.h - 14 }, left: { x: aw.x + 14, y: aw.y + aw.h / 2 }, above: { x: aw.x + aw.w / 2 + 120, y: aw.y + 14 } }[side];
    await home.mouse.move(edge.x, edge.y, { steps: 6 });
    await until(`${pane}: a +`, async () => (await readWindow(home)).plus);
    w = await readWindow(home);
    assert.equal(w.pluses, 1, 'one + only');
    assert.equal(w.plus.at, `${anchorPane}:${side}`, `the + is at the ${side} of ${anchorPane}`);
    const want = { left: [aw.x - 23, aw.y + aw.h / 2 - 13], right: [aw.x + aw.w - 3, aw.y + aw.h / 2 - 13], above: [aw.x + aw.w / 2 + 38, aw.y - 25], below: [aw.x + aw.w / 2 - 13, aw.y + aw.h - 3] }[side];
    assert.ok(Math.abs(w.plus.x - want[0]) <= 1 && Math.abs(w.plus.y - want[1]) <= 1 && w.plus.w === 26, `the + in the gap at the middle of the edge: ${JSON.stringify(w.plus)} vs ${want}`);
    cSteps++;
    await pause(500);
    await cShot(pages, `one-plus-at-the-${side}-edge-of-${anchorPane}`);

    // Its menu: the panes not on this screen, each marked; the removed one "not on a screen"; a floating layer.
    await home.locator('.fplus').click();
    await home.locator('[data-layer="menu"].addmenu').waitFor();
    await pause(400);
    w = await readWindow(home);
    const item = w.menu.items.find((i) => i.name === engine.PANES[pane].name);
    assert.ok(item, `${pane} is offered`);
    assert.equal(item.note, 'not on a screen');
    assert.equal(item.disabled, false);
    for (const other of w.menu.items.filter((i) => i.name !== engine.PANES[pane].name)) assert.ok(['moves from the other screen', 'no room'].includes(other.note), `${other.name}: ${other.note}`);
    assert.ok(!w.menu.items.some((i) => layout[0].flat().map((p) => engine.PANES[p].name).includes(i.name)), 'only panes that are not on this screen');
    await checkLayers(home, `the add menu for ${pane}`);
    cSteps++;
    await cShot(pages, `the-add-menu-offers-${pane}-as-not-on-a-screen`);

    // Choose it: it goes on that side, as a drop there would.
    const after = engine.placeBeside(layout, anchorPane, side, pane);
    assert.ok(after && engine.fits(after));
    const sent = layoutFrames().length;
    await home.locator('.addmenu-item', { hasText: engine.PANES[pane].name }).click();
    await park(pages);
    await until(`${pane}: back`, async () => layoutFrames().length > sent);
    assert.deepEqual(layoutFrames().at(-1).layout, engine.savedLayout(after), `${pane}: placed ${side} of ${anchorPane}`);
    layout = engine.savedLayout(after) ?? engine.DEFAULT_LAYOUT;
    cSteps++;
    await pause(900);
    await until(`${pane}: both windows agree`, async () => (await arrangementProblems(pages, engine.savedLayout(after))).length === 0);
    await checksAfterStep(pages, `${pane} back`);
    await cShot(pages, `${pane}-back-on-the-${side}-of-${anchorPane}-by-the-plus`);
    void anchor;
  }
  results.cRemove = { steps: cSteps };
  p2 = { pages, layout };
});

await test('C real use, continued: an empty screen of removed panes offers every pane that is not on it, and brings each back', async () => {
  const pages = p2 ? p2.pages : await openPair();
  const [left, right] = pages;
  let layout = [[['sprint'], ['conversation'], ['elfoqsy']], [['terminals'], ['map']]];
  daemon.push(layoutEvent(layout));
  await until('rearranged', async () => (await arrangementProblems(pages, layout)).length === 0);
  await park(pages);
  const remove = async (pane, name) => {
    const page = screenWindow(pages, layout, pane);
    const box = (await readWindow(page)).panes[pane];
    await page.mouse.move(box.x + box.w / 2, box.y + box.h / 2, { steps: 4 });
    await until(`${pane}: its x`, async () => (await readWindow(page)).controls[pane].x?.opacity === 1);
    layout = engine.without(layout, pane);
    await cStep(name, pages, layout, new Set(), async () => {
      await page.locator(`.fpane[data-fpane="${pane}"] button.pane-x`).click();
      await park(pages);
    });
  };
  await remove('terminals', 'terminals-taken-off-the-right-screen');
  await remove('map', 'the-map-taken-off-too-the-right-screen-is-empty');
  let w = await readWindow(right);
  assert.ok(w.empty, 'the right screen says it is empty');
  assert.deepEqual(w.emptyOffers, ['Sprint', 'Elfoqsy', 'Conversation', 'Agent map', 'Terminals'], 'every pane that is not on it: the left screen’s, and the two removed');

  // A removed pane comes back with a button, alone on the screen.
  layout = engine.bringHere(layout, 'terminals', 1);
  await cStep('a-button-brings-terminals-back-alone', pages, layout, new Set(), async () => {
    await right.locator('.fempty-pane', { hasText: 'Terminals' }).click();
    await park(pages);
  });
  assert.equal(layoutFrames().at(-1).layout !== null, true);
  // And a pane of the other screen moves: Sprint leaves the left screen for the empty right one.
  await remove('terminals', 'terminals-off-again-the-right-screen-is-empty-again');
  layout = engine.bringHere(layout, 'sprint', 1);
  await cStep('a-button-moves-the-sprint-from-the-left-screen', pages, layout, new Set(), async () => {
    await right.locator('.fempty-pane', { hasText: 'Sprint' }).click();
    await park(pages);
  });
  w = await readWindow(left);
  assert.ok(!('sprint' in w.panes), 'the sprint has left the left screen');
  assert.deepEqual(Object.keys((await readWindow(right)).panes), ['sprint']);
  // The two removed panes are still offered by the + of the sprint, as not on a screen.
  const sw = (await readWindow(right)).panes.sprint;
  await right.mouse.move(sw.x + sw.w - 14, sw.y + sw.h / 2, { steps: 5 });
  await until('a +', async () => (await readWindow(right)).plus);
  await right.locator('.fplus').click();
  await right.locator('[data-layer="menu"].addmenu').waitFor();
  w = await readWindow(right);
  assert.deepEqual(w.menu.items.map((i) => `${i.name}: ${i.note}`).sort(), ['Agent map: not on a screen', 'Conversation: moves from the other screen', 'Elfoqsy: moves from the other screen', 'Terminals: not on a screen']);
  cSteps++;
  await pause(400);
  await cShot(pages, 'the-plus-of-the-lone-sprint-offers-removed-panes-and-the-other-screens');
  await right.keyboard.press('Escape');
  results.cEmpty = { steps: cSteps };
  p2 = { pages, layout };
});

await test('C: the + never overlaps the grip, and the hide buttons and grips sit at one height', async () => {
  const pages = await openPair();
  const [left, right] = pages;
  const A = [[['sprint'], ['conversation'], ['elfoqsy']], [['terminals'], ['map']]];
  daemon.push(layoutEvent(A));
  await until('shown', async () => (await arrangementProblems(pages, A)).length === 0);
  const meet = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const apart = [];
  for (const pane of ['sprint', 'conversation', 'elfoqsy', 'terminals', 'map']) {
    const page = screenWindow(pages, A, pane);
    const box = (await readWindow(page)).panes[pane];
    // Every edge of every pane: with the pointer near it, the grip (if the pointer is in the pane) and the one + never meet.
    const near = { above: [box.x + box.w / 2 + 130, box.y + 14], below: [box.x + box.w / 2 - 130, box.y + box.h - 14], left: [box.x + 14, box.y + box.h / 2], right: [box.x + box.w - 14, box.y + box.h / 2] };
    for (const [side, [x, y]] of Object.entries(near)) {
      await page.mouse.move(2, 2);
      await page.mouse.move(x, y, { steps: 4 });
      await until(`${pane} ${side}: a +`, async () => (await readWindow(page)).plus);
      const w = await readWindow(page);
      assert.equal(w.pluses, 1, `${pane} ${side}: one +`);
      if (w.grip && w.plus) apart.push(`${pane} ${side}`), assert.ok(!meet(w.grip, w.plus), `${pane} ${side}: the + and the grip meet: ${JSON.stringify(w.plus)} ${JSON.stringify(w.grip)}`);
      if (w.grip) assert.equal(w.grip.y - box.y, -12, `${pane}: the grip straddles the top edge, at one height`);
      if (side === 'above') {
        assert.equal(w.plus.at, `${pane}:above`);
        assert.ok(w.plus.x >= w.grip.x + w.grip.w + 8, `${pane}: the + sits right of the grip, with room to spare`);
        assert.equal(w.grip.x + w.grip.w / 2, box.x + box.w / 2, `${pane}: the grip is centred`);
        if (['sprint', 'terminals'].includes(pane)) {
          cSteps++;
          await pause(400);
          await cShot(pages, `${pane}-the-plus-at-the-top-edge-sits-right-of-the-grip`);
        }
      }
    }
    // The hide button and the grip are at one height from the top of the pane, on every pane.
    assert.equal((await readWindow(page)).controls[pane].hide.y - box.y, 24, `${pane}: its hide button`);
  }
  assert.equal(apart.length, 20, 'all four edges of the five panes were looked at');
  await park(pages);

  // Today's screens again (no layout saved): the next test is about them.
  daemon.push(layoutEvent(null));
  await until('today’s columns', async () => (await readWindow(left)).classic && (await readWindow(right)).classic);
  for (const page of pages) await page.close();
});

/** Today's columns, as a window has them: each pane's box, its hide button and the other controls of its header row, in page pixels. */
const classicControls = (page, pane) =>
  page.evaluate(
    ([name, selector]) => {
      const rect = (e) => {
        const r = e.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      };
      const box = document.querySelector(selector);
      if (!box) return null;
      const hide = box.querySelector('button.collapse');
      const hr = hide ? rect(hide) : null;
      const others = hr
        ? [...box.querySelectorAll('button, a, input, select, textarea, [role="button"]')]
            .filter((e) => e !== hide && getComputedStyle(e).visibility !== 'hidden' && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().top < hr.y + hr.h + 4)
            .map(rect)
        : [];
      return { box: rect(box), hide: hr, others, name };
    },
    [pane, { sprint: '.lcol-wrap:has(> .lcol--sprint)', elfoqsy: '.elf', conversation: '.chat:not(.chat--rail)', map: '.rcol--map', terminals: '.rcol--terminals' }[pane]],
  );

await test('C: today’s screens offer the x and the +, drawn over the panes; the first one used saves a layout, and Reset gives them back', async () => {
  const pages = await openPair();
  const [left, right] = pages;
  daemon.push(layoutEvent(null));
  await until('today’s columns', async () => (await readWindow(left)).classic && (await readWindow(right)).classic);
  const meet = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const DEFAULT = engine.DEFAULT_LAYOUT;
  const win = (pane) => pages[DEFAULT[0].flat().includes(pane) ? 0 : 1];
  const xs = (page) => page.locator('.pane-xf');
  await park(pages);

  // At rest: no x and no + (and the pane's own DOM has none of either: today's panes are untouched).
  for (const page of pages) {
    assert.equal(await xs(page).count(), 0, 'no x at rest');
    assert.equal(await page.locator('.fplus').count(), 0, 'no + at rest');
    assert.equal(await page.locator('.pane-x').count(), 0, 'no x inside any pane');
  }

  // Each pane: with the pointer over it the x shows beside its hide button, the same size and height, over no other control.
  for (const pane of ['sprint', 'elfoqsy', 'conversation', 'map', 'terminals']) {
    const page = win(pane);
    const before = await classicControls(page, pane);
    assert.ok(before?.hide, `${pane}: has its hide button`);
    await page.mouse.move(before.box.x + before.box.w / 2, before.box.y + before.box.h / 2, { steps: 5 });
    await until(`${pane}: its x`, async () => (await xs(page).count()) === 1);
    const x = await xs(page).evaluate((e) => {
      const r = e.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), label: e.getAttribute('aria-label'), pane: e.dataset.xf };
    });
    assert.equal(x.pane, pane);
    assert.equal(x.label, `Remove ${{ sprint: 'the sprint', elfoqsy: 'Elfoqsy', conversation: 'the conversation', map: 'the live map', terminals: 'the agent terminals' }[pane]} from this screen`);
    assert.deepEqual({ w: x.w, h: x.h, y: x.y }, { w: before.hide.w, h: before.hide.h, y: before.hide.y }, `${pane}: the same size, at the hide button's height`);
    const wantX = pane === 'elfoqsy' ? before.hide.x + before.hide.w + 8 : before.hide.x - 8 - before.hide.w;
    assert.equal(x.x, wantX, `${pane}: ${pane === 'elfoqsy' ? 'right' : 'left'} of its hide button, 8 px from it`);
    for (const other of before.others) assert.ok(!meet(x, other), `${pane}: the x covers a control of its header: ${JSON.stringify(other)}`);
    assert.ok(x.x >= 0 && x.x + x.w <= 1920 && x.y >= 0, `${pane}: inside the screen`);
    // Nothing of today's screens moved because it showed.
    const after = await classicControls(page, pane);
    assert.deepEqual({ box: after.box, hide: after.hide }, { box: before.box, hide: before.hide }, `${pane}: the pane and its hide button did not move`);
    if (['sprint', 'elfoqsy', 'terminals'].includes(pane)) {
      cSteps++;
      await pause(500);
      await cShot(pages, `today-${pane}-hover-shows-its-x-beside-its-hide-button`);
    }
    await park(pages);
    await until(`${pane}: no x at rest again`, async () => (await xs(page).count()) === 0);
  }

  // The first use of the x saves a layout: today's arrangement without that pane, and both windows show it.
  const gone = engine.without(DEFAULT, 'sprint');
  let sent = layoutFrames().length;
  const sprint = await classicControls(left, 'sprint');
  await left.mouse.move(sprint.box.x + sprint.box.w / 2, sprint.box.y + sprint.box.h / 2, { steps: 5 });
  await until('the sprint’s x', async () => (await xs(left).count()) === 1);
  cSteps++;
  await xs(left).click();
  await park(pages);
  await until('the layout is saved', async () => layoutFrames().length > sent);
  assert.deepEqual(layoutFrames().at(-1).layout, engine.savedLayout(gone), 'today’s arrangement without the sprint');
  await pause(900);
  await until('both windows show it', async () => (await arrangementProblems(pages, gone)).length === 0);
  await checksAfterStep(pages, 'the sprint removed from today’s screens');
  await cShot(pages, 'today-the-sprint-removed-by-its-x-saves-a-layout');

  // Reset gives today's columns again, and the x and the + with them.
  await openMenu(left);
  sent = layoutFrames().length;
  await menuChoose(left, 'Reset the layout');
  await until('reset', async () => layoutFrames().length > sent);
  assert.equal(layoutFrames().at(-1).layout, null);
  await park(pages);
  await until('today’s columns again', async () => (await arrangementProblems(pages, null)).length === 0);
  const again = await classicControls(left, 'conversation');
  await left.mouse.move(again.box.x + again.box.w / 2, again.box.y + again.box.h / 2, { steps: 5 });
  await until('its x after the reset', async () => (await xs(left).count()) === 1);
  await park(pages);

  // The + at an edge of today's panes: one, in the gap at the middle of the edge, its menu offering the panes of the other screen.
  const box = (await classicControls(left, 'sprint')).box;
  await left.mouse.move(box.x + box.w - 14, box.y + box.h / 2, { steps: 6 });
  await until('a + in today’s screen', async () => (await left.locator('.fplus').count()) === 1);
  const plus = await left.locator('.fplus').evaluate((e) => {
    const r = e.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), at: e.dataset.plus };
  });
  assert.equal(plus.at, 'sprint:right');
  assert.ok(Math.abs(plus.x - (box.x + box.w - 3)) <= 1 && Math.abs(plus.y - (box.y + box.h / 2 - 13)) <= 1 && plus.w === 26, `the + in the gap at the middle of the edge: ${JSON.stringify(plus)}`);
  assert.equal(await left.locator('.pane-xf').count() <= 1, true);
  cSteps++;
  await pause(500);
  await cShot(pages, 'today-one-plus-at-the-right-edge-of-the-sprint');
  await left.locator('.fplus').click();
  await left.locator('[data-layer="menu"].addmenu').waitFor();
  await pause(400);
  const menu = (await readWindow(left)).menu;
  assert.deepEqual(menu.items.map((i) => [i.name, i.note, i.disabled]), [['Agent map', 'moves from the other screen', false], ['Terminals', 'moves from the other screen', false]], 'the panes of the other screen');
  await checkLayers(left, 'the add menu in today’s screen');
  cSteps++;
  await cShot(pages, 'today-the-add-menu-offers-the-other-screens-panes');
  const after = engine.placeBeside(DEFAULT, 'sprint', 'right', 'terminals');
  assert.ok(after && engine.fits(after));
  sent = layoutFrames().length;
  await left.locator('.addmenu-item', { hasText: 'Terminals' }).click();
  await park(pages);
  await until('the layout is saved', async () => layoutFrames().length > sent);
  assert.deepEqual(layoutFrames().at(-1).layout, engine.savedLayout(after), 'Terminals placed right of the sprint');
  await pause(900);
  await until('both windows show it', async () => (await arrangementProblems(pages, after)).length === 0);
  await checksAfterStep(pages, 'terminals moved beside the sprint from today’s screens');
  cSteps++;
  await cShot(pages, 'today-terminals-moved-beside-the-sprint-by-the-plus');

  daemon.push(layoutEvent(null));
  await until('today’s columns', async () => (await arrangementProblems(pages, null)).length === 0);
  for (const page of pages) await page.close();
});

await test('C: the add menu is a floating layer (one at a time, Escape and a click outside close it), and says no room where there is none', async () => {
  const pages = await openPair();
  const [left, right] = pages;
  const N = [[['sprint', 'elfoqsy', 'conversation']], [['map'], ['terminals']]];
  daemon.push(layoutEvent(N));
  await until('shown', async () => (await arrangementProblems(pages, N)).length === 0);
  const sprint = (await readWindow(left)).panes.sprint;
  const open = async () => {
    await left.mouse.move(2, 2);
    await left.mouse.move(sprint.x + sprint.w / 2 + 130, sprint.y + 14, { steps: 5 });
    await until('a +', async () => (await readWindow(left)).plus);
    await left.locator('.fplus').click();
    await left.locator('[data-layer="menu"].addmenu').waitFor();
    await pause(400);
  };
  await open();
  let w = await readWindow(left);
  assert.equal(w.menu.title, 'Add above Sprint');
  // Three panes stacked already: a fourth above leaves each under its minimum height.
  assert.deepEqual(w.menu.items.map((i) => [i.name, i.note, i.disabled]), [['Agent map', 'no room', true], ['Terminals', 'no room', true]]);
  await checkLayers(left, 'the add menu with nothing that fits');
  cSteps++;
  await cShot(pages, 'the-add-menu-says-no-room-where-a-fourth-pane-would-not-fit', true);
  const frames = layoutFrames().length;
  await left.locator('.addmenu-item', { hasText: 'Agent map' }).click({ force: true }).catch(() => undefined);
  await pause(400);
  assert.equal(layoutFrames().length, frames, 'a disabled entry does nothing');
  // Escape closes it, and the + goes with it.
  await left.keyboard.press('Escape');
  await until('closed', async () => (await left.locator('[data-layer="menu"]').count()) === 0);
  assert.equal((await readWindow(left)).pluses, 0, 'the + goes with the menu');
  // A click outside closes it too.
  await open();
  await left.mouse.click(1850, 1000);
  await until('closed by a click outside', async () => (await left.locator('[data-layer="menu"]').count()) === 0);
  // One layer at a time: the screen menu opened over it closes it.
  await open();
  await left.locator('.fmenu-button').click();
  await until('only the screen menu', async () => (await left.locator('[data-layer="menu"]').count()) === 1 && (await left.locator('[data-layer="menu"].addmenu').count()) === 0);
  await checkLayers(left, 'the screen menu after the add menu');
  await left.keyboard.press('Escape');
  for (const page of pages) await page.close();
});

await test('C: a folded pane is dragged by its grip and is open where it lands, as its skeleton showed', async () => {
  const pages = await openPair();
  const [left] = pages;
  const A = [[['sprint'], ['conversation'], ['elfoqsy']], [['terminals'], ['map']]];
  daemon.push(layoutEvent(A));
  await until('shown', async () => (await arrangementProblems(pages, A)).length === 0);
  await hideButton(left, 'elfoqsy').click();
  const folded = new Set(['elfoqsy']);
  await park(pages);
  await until('a rail', async () => (await readWindow(left)).folds.elfoqsy === 'rail');
  const base = engine.without(A, 'elfoqsy');
  const rects = engine.arrange(base[0], new Set()).rects;
  const to = zonePoint('above', rects.conversation);
  const hand = await takeGrip(left, 'elfoqsy');
  await approach(left, hand, to);
  const mid = await readWindow(left);
  const after = engine.insert(base, engine.targetAt(to, 0, base[0], rects), 'elfoqsy');
  assert.ok(mid.skeleton, 'a skeleton');
  assert.deepEqual({ x: mid.skeleton.x, y: mid.skeleton.y, w: mid.skeleton.w, h: mid.skeleton.h }, engine.arrange(after[0], new Set()).rects.elfoqsy, 'the skeleton is its open size, not a rail’s');
  cSteps++;
  await cShot(pages, 'a-folded-pane-carried-shows-its-open-size', true);
  await left.mouse.up();
  await pause(900);
  await until('open where it landed', async () => (await arrangementProblems(pages, after, [new Set(), new Set()])).length === 0);
  assert.equal((await readWindow(left)).folds.elfoqsy, null);
  assert.match((await readWindow(left)).controls.elfoqsy.hide.label, /^Hide /);
  void folded;
  for (const page of pages) await page.close();
});


let aSteps = 0;
const aShots = [];
/** One step of the Abilities script: do it, let it settle, check both windows as after every step, and picture both. */
async function aStep(name, pages, act) {
  aSteps++;
  await act();
  await pause(800);
  await checksAfterStep(pages, name);
  // The view is the window's own: the other window never shows it.
  assert.equal(await pages[1].locator('.abilities').count(), 0, `${name}: the right window shows no Abilities view`);
  if (!screensAt) return;
  const base = `A-${String(aSteps).padStart(2, '0')}-${name}`;
  aShots.push(base);
  await Promise.all(pages.map((page, i) => page.screenshot({ path: join(screensAt, `${base}.${i === 0 ? 'left' : 'right'}.png`) })));
}
const boxOf = (page, sel) => page.locator(sel).first().evaluate((el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; });

await test('A real use: her notice with its cards, the Abilities view from a card and from her pane, filters, a new ability arriving live; every step checked and screenshotted', async () => {
  const { abilityEvents, agentSkillEvents, AGENT_SKILL, FIRST_SKILLS } = await import('./abilities.mjs');
  const now = T0 + 30 * 60_000;
  const today = engine.todayConversation(now);
  const lab = labEvents();
  const events = [...lab, ...abilityEvents(lab.length, today)];
  const state = engine.foldAll(events);
  const pages = await openPair(events);
  const [left] = pages;
  await park(pages);

  // Today's conversation: her one line, and the six cards over it.
  await aStep('her-notice-in-today-with-a-card-for-each-new-skill', pages, async () => {
    await left.locator('button.conversation', { hasText: today.title }).click();
  });
  const notice = left.locator('.hers-notice');
  assert.equal(await notice.locator('.ability-card--mini').count(), 6, 'one small card for each of the six');
  assert.match(await notice.innerText(), /Six things I worked out from the last few days of work/);
  assert.deepEqual(await notice.locator('.ability-card--mini').evaluateAll((els) => els.map((e) => e.getAttribute('data-ability'))), FIRST_SKILLS);
  assert.equal(await notice.locator('.ability-card--mini[data-ability="find-service-pod"] .ability-recheck').count(), 1, 'the one that needs a re-check has its red dot');

  // A card opens the view on itself, over the whole left screen; the panes stay behind it.
  await aStep('a-card-in-the-notice-opens-abilities-on-it', pages, async () => {
    await notice.locator('.ability-card[data-ability="find-request-logs"]').click();
  });
  assert.equal(await left.locator('.abilities').count(), 1);
  assert.deepEqual(await boxOf(left, '.abilities'), { x: 0, y: 0, w: 1920, h: 1080 }, 'over the whole screen');
  assert.equal(await left.locator('.conversation-pane, [aria-label="Conversation with Elfoqsy"]').count() > 0, true, 'the panes are kept behind it');
  assert.equal(await left.locator('.abilities-grid .ability-card').count(), 6);
  assert.equal(await left.locator('.abilities-grid .ability-card[aria-pressed="true"]').getAttribute('data-ability'), 'find-request-logs');
  // The prototype's geometry: cards 232 × 325 from x 40, 20 apart; the detail's card 250 × 350 at x 1360; rings 44 and 56.
  const cards = await left.locator('.abilities-grid .ability-card').evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; }));
  assert.deepEqual(cards.map((c) => [c.w, c.h]), cards.map(() => [232, 325]));
  assert.deepEqual(cards.slice(0, 5).map((c) => c.x), [40, 292, 544, 796, 1048], 'five to a row, 20 apart');
  assert.equal(cards[5].y - cards[0].y, 345, 'rows 20 apart');
  assert.deepEqual(await boxOf(left, '.abilities-detail .ability-card--detail'), { ...(await boxOf(left, '.abilities-detail .ability-card--detail')), x: 1360, w: 250, h: 350 });
  assert.deepEqual([(await boxOf(left, '.abilities-grid .ability-ring')).w, (await boxOf(left, '.abilities-detail .ability-ring')).w], [44, 56]);
  // Its numbers, from the folded events: 23 uses, 22 worked, the steps saved; its six steps, one line each.
  const logs = state.abilities['find-request-logs'];
  const numbers = await left.locator('.abilities-number').evaluateAll((els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
  assert.deepEqual(numbers.slice(0, 3), ['23 uses', '96% worked', `~${Math.round(logs.stepsSaved)} steps saved`]);
  assert.equal(await left.locator('.abilities-step').count(), logs.steps.length);
  assert.equal(await left.locator('.abilities-saved b').innerText(), Math.round(engine.stepsSavedThisMonth(state, now)).toLocaleString('en-US'));
  assert.equal(await left.locator('.abilities-grid .ability-card[data-ability="find-request-logs"] .ability-ring').getAttribute('aria-label'), 'Level 4');

  // Another card: the detail follows; the one that needs a re-check shows its dot on the big card too.
  await aStep('another-card-chosen-it-needs-a-re-check', pages, async () => {
    await left.locator('.abilities-grid .ability-card[data-ability="find-service-pod"]').click();
  });
  assert.equal(await left.locator('.abilities-detail .ability-card--detail .ability-recheck').count(), 1);
  assert.match(await left.locator('.abilities-detail').innerText(), /Find a service's pod on an environment/);

  // Filters: the tools as logos with their counts.
  const filters = await left.locator('.abilities-filter').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
  assert.deepEqual(filters, ['All, 6', ...engine.abilityTools(state).map((t) => `${{ kubernetes: 'Kubernetes', coralogix: 'Coralogix', github: 'GitHub', jira: 'Jira' }[t.tool]}, ${t.count}`)]);
  await aStep('filtered-to-kubernetes', pages, async () => {
    await left.locator('.abilities-filter[aria-label^="Kubernetes"]').click();
  });
  assert.deepEqual(await left.locator('.abilities-grid .ability-card').evaluateAll((els) => els.map((e) => e.getAttribute('data-ability'))), ['find-service-pod', 'pool-has-no-pods']);
  await aStep('all-again', pages, async () => {
    await left.locator('.abilities-filter[aria-label^="All"]').click();
  });
  assert.equal(await left.locator('.abilities-grid .ability-card').count(), 6);

  // Escape closes it, and the screen is as it was: Today's conversation still open.
  await aStep('escape-closes-it', pages, async () => {
    await left.keyboard.press('Escape');
  });
  assert.equal(await left.locator('.abilities').count(), 0);
  assert.equal(await left.locator('.hers-notice').count(), 1, 'the conversation is where he left it');

  // From her pane: the same view, the card he chose last still chosen.
  await aStep('opened-from-elfoqsys-pane', pages, async () => {
    await left.locator('.elf-settings[aria-label="Abilities"]').click();
  });
  assert.equal(await left.locator('.abilities-grid .ability-card[aria-pressed="true"]').getAttribute('data-ability'), 'find-service-pod');
  await aStep('closed-with-its-x', pages, async () => {
    await left.locator('.abilities-close').click();
  });
  assert.equal(await left.locator('.abilities').count(), 0);

  // A new ability arrives while he is in the conversation: an agent found it; her line in Vietnamese, its one card beside it.
  await aStep('a-new-ability-an-agent-found-arrives', pages, async () => {
    daemon.push(...agentSkillEvents(daemon.events.at(-1).seq, today, now));
  });
  const fresh = left.locator('.hers-notice').last();
  assert.equal(await fresh.locator('.ability-card--mini').count(), 1);
  assert.match(await fresh.innerText(), /Agent 5 vừa chỉ cho tôi cách chạy e2e checkout trên dev, tôi ghi lại để lần sau làm luôn\./);
  assert.equal(await fresh.locator('.ability-finder--agent').innerText(), '5', 'Agent 5 found it');
  await aStep('its-card-opens-abilities-on-it', pages, async () => {
    await fresh.locator('.ability-card--mini').click();
  });
  assert.equal(await left.locator('.abilities-grid .ability-card[aria-pressed="true"]').getAttribute('data-ability'), AGENT_SKILL.name);
  assert.equal(await left.locator('.abilities-grid .ability-card').count(), 7);
  // Her notice is a message in the conversation, not part of the view; under the detail is where the ability came from, in one line.
  assert.equal(await left.locator('.abilities-notice').count(), 0, 'no notice in the view');
  const origin = left.locator('.abilities-detail .abilities-origin');
  assert.match(await origin.innerText(), /^Found by Agent 5 on SHOP-3567, \d+ [A-Z][a-z]{2} · 2 earlier runs$/);
  const lines = await origin.evaluate((e) => {
    const range = document.createRange();
    range.selectNodeContents(e);
    return new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
  });
  assert.equal(lines, 1, 'one line, no more');
  assert.deepEqual(await left.locator('.abilities-number').evaluateAll((els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim())), ['New'], 'no uses yet: one "New" and no zeros');
  await aStep('closed-again', pages, async () => {
    await left.keyboard.press('Escape');
  });
  results.abilities = { steps: aSteps, shots: aShots };
  for (const page of pages) await page.close();
});

await test('P2: the tester arranges nothing: his layout frame is marked, and the daemon refuses it', async () => {
  const page = await open('/left?tester', labEvents(), undefined, 'reduce', labFixed);
  await pause(1200);
  const hand = await takeGrip(page, 'sprint');
  const rects = engine.arrange(engine.without(engine.DEFAULT_LAYOUT, 'sprint')[0]).rects;
  await approach(page, hand, zonePoint('above', rects.conversation));
  await page.mouse.up();
  await pause(600);
  assert.deepEqual(layoutFrames().at(-1)?.test, true, 'the frame carries the tester’s mark');
  // The daemon says no, and the screen goes back to what the log says.
  await until('today’s columns again', async () => (await readWindow(page)).classic, 4000);
  await page.close();
});

console.log('Icons: official icons, never a letter');

/** Every state the icon audit visits: the ten of the pixel comparison, the abilities, her activity, the lab. */
async function iconStates() {
  const { baselineStates } = await import('./baseline-states.mjs');
  const { abilityEvents } = await import('./abilities.mjs');
  const states = baselineStates().map(([name, path, events, act]) => ({ name, path, events, act }));
  const lab = labEvents();
  const today = new Date(T0 + 30 * 60_000);
  states.push({ name: 'left-abilities-notice', path: '/left', events: [...lab, ...abilityEvents(lab.length, today)], act: async () => {} });
  return states;
}

/** What each tour of the audit shows, to check and to picture: a letter that stands for a logo, a file type, an avatar or a state is a failure. */
const ICON_ALLOWED = [
  { element: /calendar-month/, why: 'the month of the date tile is the date, in words' },
  { element: /you-label/, why: 'the word "you" on the sprint map is its label' },
  { element: /person-initials/, why: 'AVATARS: Jira and GitHub avatars are not fetched; reported, his choice (docs/reports/official-icons-progress.md)' },
];
const iconLink = (text, href) => ({ type: 'text', text, marks: [{ type: 'link', attrs: { href } }] });
const iconPara = (...content) => ({ type: 'paragraph', content });

await test('Icons audit: every tool, link, file type and state shows its icon, and no letter stands in for one', async () => {
  const { scanPlaceholders } = await import('./icons.mjs');
  const { abilityEvents } = await import('./abilities.mjs');
  const findings = [];
  const scan = async (page, name) => {
    for (const f of await scanPlaceholders(page)) findings.push({ state: name, ...f });
  };
  let shots = 0;
  /** An event after the last of the log the daemon holds, one number on from the one before it. */
  let liveSeq = 0;
  const live = (type, payload) => ({ seq: ++liveSeq, id: `IL${liveSeq}`, ts: new Date(daemon.now()).toISOString(), source: 'orchestrator', type, payload });
  const from = () => {
    liveSeq = daemon.events.at(-1)?.seq ?? 0;
  };
  const shot = async (target, name) => {
    shots++;
    if (screensAt) await target.screenshot({ path: join(screensAt, `I-${String(shots).padStart(2, '0')}-${name}.png`) });
  };
  const n = s.narrative();
  const sizeOf = async (page, selector) => (await page.locator(selector).count());
  const tiles = (page, within) => page.locator(`${within} .tile`).evaluateAll((els) => els.map((e) => e.getAttribute('data-tile')));

  // 1. Elfoqsy's thinking indicator, for everything her activity can reach, and links of every domain in what she says.
  {
    const page = await open('/left', [...n.base, ...n.mid, ...n.end], undefined, 'reduce', labFixed);
    from();
    await pause(1200);
    const { ACTIVITY_TOOLS } = await vite.ssrLoadModule('@elfoqsy/contracts');
    // She is working on a message of his: the indicator shows what she has done.
    daemon.push(live('elfoqsy.message', { messageId: 'icon-ask', role: 'you', conversationId: 'c46', text: 'Check my mail and the plan, please.' }));
    await pause(500);
    const batches = [ACTIVITY_TOOLS.slice(0, 5), ACTIVITY_TOOLS.slice(5, 10), ACTIVITY_TOOLS.slice(10)];
    const expectedTiles = [];
    for (const [i, batch] of batches.entries()) {
      const events = batch.flatMap((tool, k) => {
        const id = `act-${i}-${k}`;
        const last = i === batches.length - 1 && k === batch.length - 1;
        return [
          live('elfoqsy.activity', { conversationId: 'c46', activityId: id, tool, text: `Reads ${tool}`, state: 'running' }),
          ...(last ? [] : [live('elfoqsy.activity', { conversationId: 'c46', activityId: id, tool, text: `Reads ${tool}`, state: 'done' })]),
        ];
      });
      daemon.push(...events);
      await pause(700);
      const shown = await tiles(page, '.thinking');
      const tileOf = (tool) => ({ code: 'grep', memory: 'result', kube: 'kubernetes', logs: 'coralogix' }[tool] ?? tool);
      const lastBatch = i === batches.length - 1;
      expectedTiles.push(...(lastBatch ? batch.slice(0, -1) : batch).map(tileOf));
      // What she has done, each with its own icon, then the row for what she is doing now.
      assert.deepEqual(shown, [...expectedTiles, lastBatch ? tileOf(batch.at(-1)) : 'claude'], `the indicator shows each tool's own icon: ${batch}`);
      await scan(page, `thinking-${i}`);
      await shot(page.locator('.thinking').first(), `her-thinking-indicator-${i}`);
    }
    const links = [
      ['Jira', 'https://acme.atlassian.net/browse/SHOP-3546'],
      ['the plan', 'https://acme.atlassian.net/wiki/spaces/SHOP/pages/7340024/Plan'],
      ['the PR', 'https://github.com/acme/shop-api/pull/140'],
      ['the mail', 'https://outlook.office.com/mail/inbox/id/AAMkAD'],
      ['the chat', 'https://teams.microsoft.com/l/message/19:abc/123'],
      ['the folder', 'https://acme.sharepoint.com/sites/Eng/Shared%20Documents'],
      ['the file', 'https://acme-my.sharepoint.com/personal/foqs/Documents/plan.xlsx'],
      ['the logs', 'https://app.us1.coralogix.com/#/query-new/logs'],
      ['the cluster', 'https://eu-west-1.console.aws.amazon.com/eks/home'],
      ['the docs', 'https://kubernetes.io/docs/concepts/'],
      ['a page nobody here knows', 'https://example.org/page'],
    ];
    daemon.push(live('elfoqsy.message', { messageId: 'icon-links', role: 'elfoqsy', conversationId: 'c46', text: `Where it is: ${links.map(([label, href]) => `[${label}](${href})`).join(', ')}.` }));
    await pause(900);
    const msg = page.locator('.thread').last();
    const marks = await page.locator('.thread a .tile').evaluateAll((els) => els.map((e) => e.getAttribute('data-tile')));
    assert.deepEqual(marks.slice(-10), ['jira', 'confluence', 'github', 'outlook', 'teams', 'sharepoint', 'onedrive', 'coralogix', 'eks', 'kubernetes'], 'each link has its tool’s icon (EKS’s own for the console page that names EKS); the unknown page has none');
    await scan(page, 'her-links');
    await shot(msg, 'her-message-with-links-by-domain');
    await page.close();
  }

  // 2. A ticket: its Confluence pages, its links by domain, its attachments by type, its pull requests and CI by state.
  {
    const page = await open('/left', s.tickets(), undefined, 'reduce', labFixed);
    from();
    await pause(900);
    const base = detail('SHOP-3538');
    const attachments = [
      ['plan.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 48_100],
      ['budget.xlsx', 'application/vnd.ms-excel', 91_000],
      ['deck.pptx', 'application/vnd.ms-powerpoint', 2_400_000],
      ['scan-report.pdf', 'application/pdf', 310_000],
      ['export.csv', 'text/csv', 5_200],
      ['logs.tar.gz', 'application/gzip', 1_900_000],
      ['values.yaml', 'application/x-yaml', 1_100],
      ['notes.md', 'text/markdown', 800],
      ['feed.xml', 'application/xml', 3_000],
      ['LICENSE', 'application/octet-stream', 900],
    ].map(([filename, mimeType, size], i) => ({ id: `att-${i}`, filename, mimeType, size, created: '2026-10-10T10:00:00.000+0000', author: { displayName: 'Quinn Bauer' } }));
    daemon.push(
      live('ticket.detail', {
        ...base,
        fields: {
          ...base.fields,
          attachment: attachments,
          description: { type: 'doc', version: 1, content: [iconPara({ type: 'text', text: 'See ' }, iconLink('the mail', 'https://outlook.office.com/mail/x'), { type: 'text', text: ', ' }, iconLink('the Teams thread', 'https://teams.microsoft.com/l/message/1'), { type: 'text', text: ', ' }, iconLink('the SharePoint folder', 'https://acme.sharepoint.com/sites/Eng'), { type: 'text', text: ', ' }, iconLink('the pull request', 'https://github.com/acme/shop-api/pull/140'), { type: 'text', text: ', ' }, iconLink('the logs', 'https://app.us1.coralogix.com/'), { type: 'text', text: ' and ' }, iconLink('somewhere else', 'https://example.org/x'))] },
        },
      }),
      ...['open:failure', 'draft:pending', 'merged:success', 'closed:none'].flatMap((spec, i) => {
        const [state, checks] = spec.split(':');
        return [live('pr.synced', { pr: { repo: 'acme/shop-api', number: 140 + i, state, ticket: 'SHOP-3538', url: `https://github.com/acme/shop-api/pull/${140 + i}`, checks, title: `PR ${i}` } })];
      }),
    );
    await pause(600);
    daemon.push(live('ci.status', { repo: 'acme/shop-api', pr: 140, sha: 'a'.repeat(40), status: 'failure', url: 'https://github.com/x/actions/runs/1' }), live('ci.status', { repo: 'acme/shop-api', pr: 141, sha: 'b'.repeat(40), status: 'running', url: 'https://github.com/x/actions/runs/2' }), live('ci.status', { repo: 'acme/shop-api', pr: 142, sha: 'c'.repeat(40), status: 'success', url: 'https://github.com/x/actions/runs/3' }));
    await page.locator(`button.ticket:has(.ticket-circle[aria-label^="SHOP-3538,"])`).click();
    await page.locator('.tv-key a').waitFor();
    await pause(900);
    assert.ok((await sizeOf(page, '.confluence-chip .tile[data-tile="confluence"]')) >= 1, 'the Confluence chip shows Confluence’s icon');
    assert.equal(await sizeOf(page, '.confluence-icon'), 0, 'and no letter C');
    assert.deepEqual(await page.locator('.tv-file .file-icon').evaluateAll((els) => els.map((e) => e.getAttribute('data-file-kind'))), ['docx', 'xlsx', 'pptx', 'pdf', 'csv', 'zip', 'code', 'txt', 'xml', 'genericfile'], 'each attachment has its type’s icon');
    const states = await page.locator('.pr-line .state-icon').evaluateAll((els) => els.map((e) => e.getAttribute('data-state-icon')));
    assert.deepEqual(states.filter((x) => x.startsWith('pr-')).sort(), ['pr-closed', 'pr-draft', 'pr-merged', 'pr-open'], 'each pull request its state\u2019s icon');
    assert.deepEqual(states.filter((x) => x.startsWith('ci-')).sort(), ['ci-failed', 'ci-passed', 'ci-running'], 'and its CI\u2019s');
    assert.deepEqual(await page.locator('.adf a .tile').evaluateAll((els) => els.map((e) => e.getAttribute('data-tile'))).then((t) => t.slice(0, 5)), ['outlook', 'teams', 'sharepoint', 'github', 'coralogix'], 'the links of the description carry their tool\u2019s icon, and the unknown one none');
    await scan(page, 'ticket');
    await shot(page.locator('.tv-key').first().locator('xpath=ancestor::*[contains(@class,"ticket-view") or contains(@class,"tv")][1]').first().or(page.locator('.screen--left')).first(), 'ticket-with-confluence-links-development-and-attachments');
    for (const [selector, name] of [['.tv-page', 'confluence-page-chip'], ['.tv-prs', 'pull-requests-with-their-states'], ['.tv-files', 'attachments-by-type']]) {
      if (await page.locator(selector).count()) await shot(page.locator(selector).first(), name);
    }
    await page.close();
  }

  // 3. Abilities: the tool of each card, Outlook, SharePoint and OneDrive among them.
  {
    const clock = T0 + 30 * 60_000;
    const today = engine.todayConversation(clock);
    const lab = labEvents();
    const events = [...lab, ...abilityEvents(lab.length, today)];
    let seq = events.at(-1).seq;
    const learned = ['outlook', 'sharepoint', 'onedrive', 'teams', 'other'].map((tool) => ({ seq: ++seq, id: `AL-${tool}`, ts: new Date(clock).toISOString(), source: 'orchestrator', type: 'ability.learned', payload: { name: `read-${tool}`, version: 1, title: `Read ${tool}`, titleVi: `Đọc ${tool}`, tool, steps: [{ text: 'Read it', kind: 'read' }], finder: { by: 'elfoqsy' }, baselineSteps: 4 } }));
    const page = await open('/left', [...events, ...learned], undefined, 'reduce', labFixed);
    from();
    await pause(1200);
    await page.locator('button.conversation', { hasText: today.title }).click();
    await page.locator('.hers-notice .ability-card--mini').first().click();
    await page.locator('.abilities').waitFor();
    await pause(900);
    await scan(page, 'abilities');
    const tools = await page.locator('.abilities-grid .ability-card').evaluateAll((els) => els.map((e) => e.getAttribute('data-ability')));
    assert.ok(tools.includes('read-outlook') && tools.includes('read-sharepoint') && tools.includes('read-onedrive'), `the grid has the Microsoft abilities: ${tools}`);
    assert.ok((await page.locator('.abilities-grid .ability-card img, .abilities-grid .ability-card [aria-hidden="true"][style*="mask"]').count()) >= tools.length, 'each card has its tool\u2019s logo');
    await shot(page.locator('.abilities').first(), 'abilities-with-microsoft-tools');
    await page.close();
  }

  // 4. The terminals: the tool calls of an agent, each tool by its own icon; connectors by theirs.
  {
    const page = await open('/right', s.design(), undefined, 'reduce', labFixed);
    from();
    await pause(1200);
    const calls = [
      ['mcp__run__confluence', 'search SHOP'], ['mcp__run__logs', 'query errors'], ['mcp__run__aws', 'eks list-clusters'], ['mcp__run__kube', 'get pods'], ['mcp__run__gh', 'pr view 140'],
      ['mcp__run__docker', 'ps'], ['Bash', 'npm run test:unit'], ['Bash', 'pnpm install'], ['Bash', 'git status'], ['Bash', 'docker build .'], ['Bash', 'ls -la'], ['WebFetch', 'https://example.org'],
      ['mcp__claude_ai_Microsoft_365__outlook_email_search', 'today'], ['mcp__blackduck-sca__scan', 'shop-api'], ['mcp__claude_ai_Atlassian_Rovo__search', 'plan'], ['mcp__some-new-server__do', 'x'],
    ];
    daemon.push(
      ...calls.flatMap(([tool, title], k) => [
        live('tool.called', { runId: 'r2', toolUseId: `ic${k}`, tool, title, inputSummary: '{}', allowed: true }),
        live('tool.finished', { runId: 'r2', toolUseId: `ic${k}`, ok: true, outputSummary: 'ok', durationMs: 400 }),
      ]),
    );
    await pause(1200);
    // The pane folds a run of calls into a chip; open each, as a person reading them would.
    const chips = page.locator('section.pane[data-run="r2"] .grp-chip');
    for (let k = 0; k < (await chips.count()); k++) {
      await chips.nth(k).click();
      await pause(200);
    }
    await pause(600);
    const seen = new Set(await page.locator('section.pane[data-run="r2"] .tile').evaluateAll((els) => els.map((e) => e.getAttribute('data-tile'))));
    for (const tile of ['aws', 'kubernetes', 'github', 'docker', 'npm', 'pnpm', 'git', 'shell', 'microsoft365', 'blackduck', 'rovo', 'other']) assert.ok(seen.has(tile), `the terminal shows ${tile}: ${[...seen]}`);
    assert.ok(!seen.has(null) && ![...seen].some((t) => /^(mono|letter)/.test(t)), 'every tile is a tile of the registry');
    await scan(page, 'terminals');
    await shot(page.locator('section.pane[data-run="r2"]').first(), 'terminal-tool-calls-by-tool');
    await page.close();
  }

  // 5. The chat with its digest and question card, the delegation sheet, what she decided, and finding a ticket.
  {
    const page = await open('/left', s.design(), undefined, 'reduce', labFixed);
    from();
    await pause(1500);
    await scan(page, 'chat-digest-and-question');
    await shot(page.locator('.thread').first(), 'chat-with-her-digest-and-a-question-card');
    await page.locator('button[aria-label="What Elfoqsy decides for you"]').click();
    await pause(900);
    await scan(page, 'delegation-sheet');
    await shot(page, 'what-elfoqsy-decides-for-you');
    await page.keyboard.press('Escape');
    await pause(400);
    await page.keyboard.press('Control+k');
    await pause(500);
    await page.keyboard.type('SHOP');
    await pause(900);
    await scan(page, 'find-a-ticket');
    await shot(page, 'finding-a-ticket');
    await page.close();
  }

  const rows = new Map();
  const unexpected = [];
  for (const f of findings) {
    const allowed = ICON_ALLOWED.find((a) => a.element.test(f.element));
    const key = `${allowed ? 'allowed' : 'LETTER'}  ${f.element}  in ${f.parent}  "${f.text}"`;
    rows.set(key, [...(rows.get(key) ?? []), f.state]);
    if (!allowed) unexpected.push(f);
  }
  for (const [k, states] of rows) console.log(`    ${k}  [${[...new Set(states)].join(', ')}]`);
  assert.deepEqual(unexpected, [], 'a letter stands in for an icon');
});

await test('Icons report: the places that still show letters or text where a familiar visual exists, one picture each (for his choice)', async () => {
  if (!screensAt) return;
  const place = async (page, selector, name) => {
    const target = page.locator(selector).first();
    if (!(await target.count())) return console.log(`    no ${selector} for ${name}`);
    await target.scrollIntoViewIfNeeded().catch(() => {});
    await target.screenshot({ path: join(screensAt, `R-${name}.png`), timeout: 4000 }).catch((e) => console.log(`    ${name}: ${String(e).split('\n')[0]}`));
  };
  const live = (seq, type, payload) => ({ seq, id: `RL${seq}`, ts: new Date(daemon.now()).toISOString(), source: 'orchestrator', type, payload });
  // A ticket with comments (the captured SHOP-2430, shown as SHOP-3546), people mentioned in its description, and a linked work item with an assignee.
  const page = await open('/left', s.tickets(), undefined, 'reduce', labFixed);
  await pause(900);
  const base = detail('SHOP-2430');
  let seq = daemon.events.at(-1)?.seq ?? 0;
  const mention = { type: 'paragraph', content: [{ type: 'text', text: 'Ask ' }, { type: 'mention', attrs: { id: 'acc-2', text: '@Morgan Diaz' } }, { type: 'text', text: ' or ' }, { type: 'mention', attrs: { id: 'acc-3', text: '@Jordan Park' } }, { type: 'text', text: ' about it.' }] };
  daemon.push(live(++seq, 'ticket.detail', { ...base, key: 'SHOP-3546', id: '9001', fields: { ...base.fields, summary: '429 retry for provider errors', description: { type: 'doc', version: 1, content: [mention] } } }));
  await pause(500);
  await page.locator(`button.ticket:has(.ticket-circle[aria-label^="SHOP-3546,"])`).click();
  await page.locator('.tv-key a').waitFor();
  await pause(1000);
  await place(page, '.tv-comments li', '01-avatars-of-comment-authors-are-initials');
  await place(page, '.adf .adf-mention', '02-avatars-in-a-mention-are-initials');
  await page.locator('details.tv-history-box > summary').click().catch(() => {});
  await pause(500);
  await place(page, '.tv-history li', '03-history-names-people-in-words');
  await page.close();

  const linked = await open('/left', s.tickets(), undefined, 'reduce', labFixed);
  await pause(900);
  await linked.locator(`button.ticket:has(.ticket-circle[aria-label^="SHOP-3538,"])`).click();
  await linked.locator('.tv-key a').waitFor();
  await pause(900);
  await place(linked, '.issue-rows', '04-avatars-of-assignees-in-linked-work-items-are-initials');
  await place(linked, '.tv-fields', '05-assignee-and-reporter-are-names-with-no-picture');
  await linked.close();

  const news = await open('/left', s.tickets(), undefined, 'reduce', labFixed);
  await pause(900);
  const at = (h, m) => new Date(Date.UTC(2026, 9, 14, h, m)).toISOString();
  let nseq = daemon.events.at(-1)?.seq ?? 0;
  daemon.push(
    live(++nseq, 'jira.news', { newsId: 'news-9', since: at(2, 12), conversationId: 'c9', items: [{ kind: 'mention', who: 'Quinn Bauer', what: 'mentioned you in', key: 'SHOP-3559', at: at(3, 41) }, { kind: 'transition', who: 'Morgan Diaz', what: 'moved to IN PROGRESS', key: 'SHOP-3543', at: at(3, 20) }] }),
    live(++nseq, 'elfoqsy.message', { messageId: 'm-news-9', role: 'elfoqsy', text: 'Welcome back.', conversationId: 'c9', blocks: [{ type: 'jira_news', ref: 'news-9' }] }),
  );
  await news.locator('.block.digest:has(.news-row)').waitFor();
  await pause(500);
  await place(news, '.block.digest:has(.news-row)', '06-avatars-in-what-happened-in-jira-are-initials');
  await place(news, '.calendar-tile', '07-the-date-is-a-calendar-tile-of-words');
  await news.close();

  const right = await open('/right', s.design(), undefined, 'reduce', labFixed);
  await pause(1200);
  await place(right, 'section.pane[data-run="r2"]', '08-agents-are-a-number-on-a-circle');
  await right.close();
});

await test('Abilities fixes: AWS is its logo (and a service only when it is named), a new ability is level 1 with nothing said of how much worked, and her line is hers', async () => {
  const { abilityEvents } = await import('./abilities.mjs');
  const clock = T0 + 30 * 60_000;
  const today = engine.todayConversation(clock);
  const lab = labEvents();
  const base = [...lab, ...abilityEvents(lab.length, today)];
  let seq = base.at(-1).seq;
  const at = (n) => new Date(clock + n * 1000).toISOString();
  const ev = (type, payload, n = 0) => ({ seq: ++seq, id: `AF${seq}`, ts: at(n), source: 'orchestrator', type, payload });
  const aws = {
    name: 'aws-session-left',
    version: 1,
    title: 'How long the AWS sessions have left',
    titleVi: 'xem phiên AWS còn bao lâu',
    tool: 'aws',
    steps: [{ text: 'Read the expiry of each profile', code: 'sts get-caller-identity', kind: 'read' }, { text: 'Say which expires first', kind: 'note' }],
    finder: { by: 'agent', agentNumber: 3, runId: 'run-aws-3', ticket: 'SHOP-3600' },
    baselineSteps: 6,
    baselineFailed: 1,
    baselineQuestions: 1,
    source: 'SHOP-3600, Agent 3',
  };
  const events = [
    ...base,
    ev('ability.learned', aws, 5),
    ev('ability.verified', { name: aws.name, version: 1, steps: [{ status: 'ok' }, { status: 'unverified', note: 'Nothing to run.' }] }, 6),
    // Her own line, in his language, and links of the AWS console: the tool's logo, and a service's icon only for the one it names.
    ev('elfoqsy.message', { messageId: 'm-aws-1', role: 'elfoqsy', conversationId: today.conversationId, text: 'Từ giờ tôi xem được phiên AWS còn bao lâu mà không phải hỏi cậu. Console: [AWS](https://eu-west-1.console.aws.amazon.com/ec2/home), [CloudTrail](https://eu-west-1.console.aws.amazon.com/cloudtrail/home), [IAM](https://us-east-1.console.aws.amazon.com/iam/home).', blocks: [{ type: 'ability', ref: aws.name }] }, 7),
  ];
  const pages = await openPair(events);
  const [left] = pages;
  await park(pages);
  const shot = async (name) => {
    if (screensAt) await left.screenshot({ path: join(screensAt, `F-${name}.png`) });
  };
  await left.locator('button.conversation', { hasText: today.title }).click();
  await pause(800);

  // Her line is hers: in Vietnamese, with no template ("I just learned how to ..."), the card beside it, and each console link by its icon.
  const line = left.locator('.hers-notice').last();
  assert.match(await line.innerText(), /Từ giờ tôi xem được phiên AWS còn bao lâu mà không phải hỏi cậu\./);
  assert.doesNotMatch(await left.locator('.thread').innerText(), /I just learned how to|Tôi vừa học được cách/);
  assert.deepEqual(await line.locator('a .tile').evaluateAll((els) => els.map((e) => e.getAttribute('data-tile'))), ['aws', 'cloudtrail', 'iam'], 'the AWS logo for AWS, a service’s own icon for the service the address names');
  await shot('01-her-line-in-her-words-and-aws-links-by-icon');

  // The Abilities view: AWS is its logo on its card and in its filter, never the CLI's service icon.
  await line.locator('.ability-card--mini').click();
  await left.locator('.abilities').waitFor();
  await pause(900);
  const logoSrc = (selector) => left.locator(selector).first().evaluate((e) => (e.tagName === 'IMG' ? e.getAttribute('src') : getComputedStyle(e).maskImage));
  assert.match(await logoSrc('.abilities-filter[aria-label^="AWS"] .abilities-filter-logo'), /AWS-Cloud-logo/, 'the filter');
  assert.match(await logoSrc('.ability-card[data-ability="aws-session-left"] .ability-logo'), /AWS-Cloud-logo/, 'the card');
  assert.doesNotMatch(await left.locator('.abilities').innerHTML(), /Command-Line-Interface/);
  const detail = left.locator('.abilities-detail');
  assert.equal(await detail.locator('.ability-ring-level').innerText(), '1', 'a new ability is level 1: written and verified');
  assert.equal(await detail.locator('.ability-ring-fill').count(), 0, 'its ring is empty');
  const numbers = (await detail.locator('.abilities-number').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
  assert.deepEqual(numbers, ['New'], 'nothing but "New" before a use: no zeros, no dash');
  await shot('02-a-new-ability-is-level-1-and-says-nothing-of-worked');

  // Its first use that worked: now it says so, and the ring has moved toward level 2.
  daemon.push(ev('ability.used', { name: aws.name, runId: 'run-aws-4', worked: true, steps: 2, baselineSteps: 6, failedCalls: 0, baselineFailed: 1, questions: 0, baselineQuestions: 1 }, 20));
  await pause(900);
  const after = (await left.locator('.abilities-detail .abilities-number').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
  assert.deepEqual(after.slice(0, 2), ['1 use', '100% worked']);
  assert.equal(await left.locator('.abilities-detail .ability-ring-level').innerText(), '1', 'one use is still level 1');
  assert.equal(await left.locator('.abilities-detail .ability-ring-fill').count(), 1, 'and its ring has begun to fill');
  await shot('03-after-its-first-use-it-says-how-much-worked');
  for (const page of pages) await page.close();
});

await test('Ability origin: under each ability in the view, where it came from in one line (no notice there), each a picture', async () => {
  const { abilityEvents, liveAbilityEvents } = await import('./abilities.mjs');
  const clock = T0 + 30 * 60_000;
  const today = engine.todayConversation(clock);
  const lab = labEvents();
  const base = [...abilityEvents(lab.length, today)];
  const events = [...lab, ...base];
  let seq = events.at(-1).seq;
  // The one an agent found and the six she wrote herself, as their files keep them.
  const extra = liveAbilityEvents(seq, clock);
  const page = await open('/left', [...events, ...extra], undefined, 'reduce', labFixed);
  await pause(1200);
  await page.locator('button.conversation', { hasText: today.title }).click();
  await page.locator('.hers-notice .ability-card--mini').first().click();
  await page.locator('.abilities').waitFor();
  await pause(900);
  assert.equal(await page.locator('.abilities-notice').count(), 0, 'no notice in the view');
  const names = await page.locator('.abilities-grid .ability-card').evaluateAll((els) => els.map((e) => e.getAttribute('data-ability')));
  assert.ok(names.length >= 13, `thirteen abilities: ${names}`);
  const lines = [];
  let n = 0;
  for (const name of names) {
    await page.locator(`.abilities-grid .ability-card[data-ability="${name}"]`).click();
    await pause(350);
    const origin = page.locator('.abilities-detail .abilities-origin');
    const text = await origin.innerText();
    lines.push(`${name}: ${text}`);
    assert.match(text, /^Found by (Elfoqsy|Agent \d+)/, `${name}: who found it`);
    assert.match(text, /\d{1,2} [A-Z][a-z]{2}/, `${name}: when`);
    assert.equal(await origin.evaluate((e) => { const r = document.createRange(); r.selectNodeContents(e); return new Set([...r.getClientRects()].map((x) => Math.round(x.top))).size; }), 1, `${name}: one line`);
    // Never truncated: no ellipsis, nothing past the column, 15 px in secondary text; what the line leaves out is in the tip.
    assert.deepEqual(await origin.evaluate((e) => { const s = getComputedStyle(e); return { size: s.fontSize, color: s.color, overflow: s.textOverflow, wide: e.scrollWidth > e.clientWidth }; }), { size: '15px', color: 'rgb(185, 193, 192)', overflow: 'clip', wide: false }, `${name}: 15 px, secondary, not cut`);
    assert.ok(text.length <= 70 && !text.includes('…'), `${name}: written to fit: ${text}`);
    const tip = await origin.getAttribute('data-tip');
    const who = /^Found by (Elfoqsy|Agent \d+(?: on [A-Z]+-\d+)?)/.exec(text)[1];
    assert.ok(tip === null || (tip !== text && tip.startsWith(`Found by ${who}`)), `${name}: the tip holds what the line leaves out: ${tip}`);
    if (screensAt && [0, 1, 6, 7, 9].includes(n)) await page.locator('.abilities-side').screenshot({ path: join(screensAt, `O-${String(n + 1).padStart(2, '0')}-${name}.png`) });
    n++;
  }
  console.log(`    ${lines.join('\n    ')}`);
  await page.close();
});

/**
 * What a watermark shows of itself: the card's picture with its ring, title and shade hidden, read pixel by pixel in a blank page
 * (the mark is whatever is lighter than the card's own colour): its box, its centre and how much of the box it fills.
 */
async function markExtent(page, probe, selector) {
  const png = await page.locator(selector).screenshot();
  return probe.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    const { data, width, height } = ctx.getImageData(0, 0, bmp.width, bmp.height);
    const bg = [13, 16, 16];
    let x0 = width, y0 = height, x1 = -1, y1 = -1, area = 0, peak = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        const lift = Math.max(data[i] - bg[0], data[i + 1] - bg[1], data[i + 2] - bg[2]);
        if (lift > 3) {
          x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); area++;
          peak = Math.max(peak, data[i], data[i + 1], data[i + 2]);
        }
      }
    }
    return { cardW: width, cardH: height, w: x1 - x0 + 1, h: y1 - y0 + 1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, area, peak };
  }, png.toString('base64'));
}

await test('Abilities against the prototype at 1920 × 1080: watermarks turned, faint and in the upper part; real logos; the three numbers or one "New"; a step is one line with its command right after it; the origin line whole; nothing cut off, the grid scrolls', async () => {
  const { abilityEvents, liveAbilityEvents, protoEvents, PROTO_ABILITIES } = await import('./abilities.mjs');
  const clock = T0 + 30 * 60_000;
  const today = engine.todayConversation(clock);
  const lab = labEvents();
  const probe = await browser.newPage();
  await probe.goto('about:blank');
  const shot = async (page, name) => screensAt && page.screenshot({ path: join(screensAt, `Z-${name}.png`) });
  const rows = (page, sel) => page.locator(sel).evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) }; }));
  const near = (got, want, tol, what) => assert.ok(Math.abs(got - want) <= tol, `${what}: ${got}, the prototype has ${want}`);

  // --- The prototype's own nine abilities (brief-abilities/prototypes/Abilities.dc.html, boxes measured in it at 1920 × 1080).
  const page = await open('/left', [...lab, ...protoEvents(lab.length, today)], undefined, 'reduce', labFixed);
  await pause(1200);
  await page.locator('button.conversation', { hasText: today.title }).click();
  await page.locator('.hers-notice .ability-card--mini').first().click();
  await page.locator('.abilities').waitFor();
  await page.locator('.abilities-grid .ability-card[data-ability="proto-request-logs-staging"]').click();
  await page.mouse.move(1000, 1060);
  await pause(900);
  await shot(page, '01-the-prototypes-nine');

  // Header and filters: 40 high inside a border (42), the chosen one with none (40); the cards start under them, at y 169.
  const chips = await rows(page, '.abilities-filter');
  assert.deepEqual(chips.map((c) => [c.y, c.h]), [[103, 40], ...Array.from({ length: 7 }, () => [103, 42])]);
  const cards = await rows(page, '.abilities-grid .ability-card');
  assert.deepEqual(cards.map((c) => [c.x, c.y, c.w, c.h]), PROTO_ABILITIES.map((_, i) => [40 + 252 * (i % 5), 169 + 345 * Math.floor(i / 5), 232, 325]));
  assert.equal(await page.locator('.abilities-grid .ability-card').first().evaluate((e) => getComputedStyle(e).borderRadius), '18px', 'the prototype’s corners');

  // Watermarks: turned -8° and at 16%, 90% of the card wide with its centre at 42% down; the card fades to its own colour toward the title.
  const wrap = await page.locator('.abilities-grid .ability-logo-wrap').evaluateAll((els) => els.map((e) => { const s = getComputedStyle(e); const m = new DOMMatrix(s.transform); return { opacity: s.opacity, turned: Math.round(Math.atan2(m.b, m.a) * 180 / Math.PI * 10) / 10, w: e.offsetWidth, top: s.top, left: s.left }; }));
  assert.deepEqual(wrap, PROTO_ABILITIES.map(() => ({ opacity: '0.16', turned: -8, w: 209, top: '136.5px', left: '116px' })));
  assert.match(await page.locator('.abilities-grid .ability-shade').first().evaluate((e) => getComputedStyle(e).backgroundImage), /^linear-gradient\(.*0\) 45%, .* 78%\)$/);
  await page.addStyleTag({ content: '.abilities-grid .ability-top, .abilities-grid .ability-bottom, .abilities-grid .ability-shade, .abilities-grid .ability-recheck { display: none !important; } button.ability-card[aria-pressed="true"] { box-shadow: none !important; }' });
  // The extent each logo has in the prototype's picture (its width in px; Coralogix's is "cx" there, our green circle is the logo you chose).
  const protoWidth = { kubernetes: 197, github: 167, aws: 157, jira: 154, test: 160, teams: 153 };
  const extents = [];
  for (const a of PROTO_ABILITIES) {
    const x = await markExtent(page, probe, `.abilities-grid .ability-card[data-ability="${a[0]}"]`);
    extents.push(`${a[2]}: ${x.w}×${x.h} at ${x.cx},${x.cy}`);
    assert.ok(x.w <= 0.9 * x.cardW && x.h <= 0.75 * x.cardH, `${a[1]}: the mark is ${x.w}×${x.h} in a ${x.cardW}×${x.cardH} card: it fills the card`);
    assert.ok(x.cy < 0.5 * x.cardH, `${a[1]}: the mark is in the upper part (${x.cy} of ${x.cardH})`);
    assert.ok(x.area / (x.w * x.h) <= 0.9, `${a[1]}: the mark is a square tile (${Math.round((100 * x.area) / (x.w * x.h))}% of its box)`);
    assert.ok(x.peak <= 70, `${a[1]}: the mark is too strong (${x.peak})`);
    if (protoWidth[a[2]]) near(x.w, protoWidth[a[2]], Math.round(0.06 * protoWidth[a[2]]), `${a[1]}: the mark's width`);
  }
  console.log(`    watermark extents: ${extents.join('; ')}`);
  await page.reload();
  await pause(1500);
  await page.locator('button.conversation', { hasText: today.title }).click();
  await page.locator('.hers-notice .ability-card--mini').first().click();
  await page.locator('.abilities-grid .ability-card[data-ability="proto-request-logs-staging"]').click();
  await page.mouse.move(1000, 1060);
  await pause(900);

  // The logos are the tools' real ones, never the sparkle: the card of Jira is Jira's mark, AWS's the AWS logo, none a square.
  const srcs = await page.locator('.abilities-grid .ability-logo').evaluateAll((els) => els.map((e) => (e.tagName === 'IMG' ? decodeURIComponent(e.getAttribute('src')) : getComputedStyle(e).maskImage)));
  assert.ok(srcs.every((s) => !/sparkles/.test(s)), 'no card has the sparkle');
  assert.match(srcs[4], /#1868db/, 'Jira’s mark, in its blue');
  assert.doesNotMatch(srcs[4], /M0 6a6 6 0 0 1 6-6/, 'without its square');
  assert.match(srcs[3], /id="Fill-1"/, 'AWS’s logo');
  assert.doesNotMatch(srcs[3], /id="Rectangle"/, 'without its square');

  // The detail: its card 250 × 350 at x 1360; the three numbers at x 1638, 30 px over 13 px, 80 apart.
  assert.deepEqual((await rows(page, '.abilities-detail .ability-card--detail')).map((c) => [c.x, c.y, c.w, c.h]), [[1360, 44, 250, 350]]);
  const numbers = await page.locator('.abilities-number').evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); const [v, l] = e.children; return { text: e.innerText.replace(/\s+/g, ' ').trim(), x: r.x, y: r.y, big: getComputedStyle(v).fontSize + ' ' + getComputedStyle(v).fontWeight, small: l && getComputedStyle(l).fontSize + ' ' + getComputedStyle(l).color }; }));
  assert.deepEqual(numbers.map((x) => [x.text, x.x, x.y, x.big, x.small]), [
    ['23 uses', 1638, 52, '30px 800', '13px rgb(142, 152, 151)'],
    ['96% worked', 1638, 132, '30px 800', '13px rgb(142, 152, 151)'],
    ['~180 steps saved', 1638, 212, '30px 800', '13px rgb(142, 152, 151)'],
  ]);

  // Its steps: 36 high, 42 apart from y 418, the text at x 1398 and each command 12 px after its text on the same line (13 px mono).
  const stepRows = await rows(page, '.abilities-step');
  assert.deepEqual(stepRows.map((r) => [r.x, r.y, r.w, r.h]), [0, 1, 2, 3].map((i) => [1360, 418 + 42 * i, 520, 36]));
  const text = await rows(page, '.abilities-step-text');
  const chipsAt = await rows(page, '.abilities-step code');
  assert.equal(chipsAt.length, 3);
  chipsAt.forEach((c, i) => {
    near(c.x - (text[i].x + text[i].w), 12, 1.5, `step ${i + 1}: the command comes after its text`);
    near(c.y + c.h / 2, text[i].y + text[i].h / 2, 3, `step ${i + 1}: on the same line`);
  });
  assert.equal(await page.locator('.abilities-step code').first().evaluate((e) => { const s = getComputedStyle(e); return `${s.fontSize} ${s.fontFamily.split(',')[0]}`; }), '13px "JetBrains Mono"');
  // The origin: a hairline 28 under the steps, then one line at 15 px in secondary text.
  const hair = await page.locator('.abilities-origin').evaluate((e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return { y: r.y, top: s.borderTopWidth, size: s.fontSize, color: s.color }; });
  assert.deepEqual([hair.top, hair.size, hair.color], ['1px', '15px', 'rgb(185, 193, 192)']);
  near(hair.y - (stepRows[3].y + 36), 28, 1, 'the hairline under the steps');

  // A new ability: one "New", no zeros.
  await page.locator('.abilities-grid .ability-card[data-ability="proto-decision"]').click();
  await pause(300);
  const fresh = await page.locator('.abilities-number').evaluateAll((els) => els.map((e) => [e.innerText.trim(), getComputedStyle(e.firstElementChild).fontSize]));
  assert.deepEqual(fresh, [['New', '30px']], JSON.stringify(fresh));
  await page.locator('.abilities-grid .ability-card[data-ability="proto-request-logs-staging"]').click();
  await page.close();

  // --- The abilities she has now: thirteen, with long steps, long commands and long origins.
  const base = [...lab, ...abilityEvents(lab.length, today)];
  const live = await open('/left', [...base, ...liveAbilityEvents(base.at(-1).seq, clock)], undefined, 'reduce', labFixed);
  await pause(1200);
  await live.locator('button.conversation', { hasText: today.title }).click();
  await live.locator('.hers-notice .ability-card--mini').first().click();
  await live.locator('.abilities').waitFor();
  await live.mouse.move(1000, 1075);
  await pause(900);
  await shot(live, '02-hers-thirteen-the-grid-scrolls');
  // Nothing past the screen: the view is the screen, the grid scrolls inside its area, and the last card can be brought into it.
  assert.equal(await live.evaluate(() => [document.documentElement.scrollHeight, document.documentElement.scrollWidth, document.querySelector('.abilities').getBoundingClientRect().bottom]).then((a) => a.join()), '1080,1920,1080');
  const grid = await live.locator('.abilities-grid').evaluate((e) => { const r = e.getBoundingClientRect(); return { overflow: getComputedStyle(e).overflowY, scrolls: e.scrollHeight > e.clientHeight, bottom: r.bottom }; });
  assert.equal(grid.overflow, 'auto');
  assert.ok(grid.scrolls && grid.bottom <= 1043, `thirteen cards scroll inside a grid that ends at ${grid.bottom}`);
  await live.locator('.abilities-grid').evaluate((e) => e.scrollTo(0, e.scrollHeight));
  await pause(300);
  const last = (await rows(live, '.abilities-grid .ability-card')).at(-1);
  assert.ok(last.y + last.h <= grid.bottom + 1 && last.y >= 0, `the last card is whole inside the grid after scrolling: ${JSON.stringify(last)}`);
  await shot(live, '03-hers-scrolled-to-the-last');
  // The fourth number, the questions it avoided, only when it avoided some: find-request-logs has, the prototype's nine have none.
  await live.locator('.abilities-grid .ability-card[data-ability="find-request-logs"]').click();
  await pause(250);
  const four = await live.locator('.abilities-number').evaluateAll((els) => els.map((e) => [e.innerText.replace(/\s+/g, ' ').trim(), Math.round(e.getBoundingClientRect().y)]));
  assert.equal(four.length, 4, JSON.stringify(four));
  assert.match(four[3][0], /^~[0-9.]+ questions avoided$/);
  assert.deepEqual(four.map((x) => x[1]), [52, 132, 212, 292], 'four numbers, 80 apart, inside the card’s height');
  await live.locator('.abilities-grid .ability-card[data-ability="draft-pr-team-way"]').click();
  await pause(250);
  // The close button is the design system's icon button: its box, its border, its glyph.
  const close = await live.locator('.abilities-close').evaluate((e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); const svg = e.querySelector('svg'); return { cls: e.className, box: [r.right, r.top, r.width, r.height], border: s.borderTopWidth, radius: s.borderTopLeftRadius, glyph: [svg.getAttribute('width'), getComputedStyle(svg).stroke] }; });
  assert.deepEqual(close, { cls: 'icon-button abilities-close', box: [1904, 16, 36, 36], border: '1px', radius: '10px', glyph: ['14', 'rgb(185, 193, 192)'] });
  // The sparkle belongs to no tool: the card that had it is her own workspace's, with her fox, and so is its filter.
  assert.equal(await live.locator('.ability-card--other').count(), 0);
  assert.match(await live.locator('.ability-card[data-ability="why-a-run-failed"] .ability-logo').getAttribute('src'), /fox-quiet/);
  assert.equal(await live.locator('.abilities-filter[aria-label="Elfoqsy, 1"]').count(), 1);
  await live.locator('.abilities-grid').evaluate((e) => e.scrollTo(0, 0));

  // Every ability's steps: one line each with its command after the text; a command too long for what is left goes on whole, never cut.
  const wrapped = [];
  for (const name of await live.locator('.abilities-grid .ability-card').evaluateAll((els) => els.map((e) => e.getAttribute('data-ability')))) {
    await live.locator(`.abilities-grid .ability-card[data-ability="${name}"]`).evaluate((e) => e.scrollIntoView({ block: 'nearest' }));
    await live.locator(`.abilities-grid .ability-card[data-ability="${name}"]`).click();
    await pause(200);
    const steps = await live.locator('.abilities-step').evaluateAll((els) => els.map((li) => {
      const text = li.querySelector('.abilities-step-text').getBoundingClientRect();
      const code = li.querySelector('code');
      const column = li.getBoundingClientRect();
      const rects = code ? [...code.getClientRects()] : [];
      const cs = code && getComputedStyle(code);
      return {
        rowH: Math.round(column.height),
        // A command that does not fit beside its text goes under it, whole: one box, at the text's left edge, below its line.
        under: code ? rects.length === 1 && Math.abs(rects[0].left - text.left) < 1.5 && rects[0].top >= text.bottom - 2 : null,
        beside: code ? rects.length === 1 && rects[0].left >= text.right && Math.abs(rects[0].top + rects[0].height / 2 - (text.top + text.height / 2)) < 6 : null,
        chipRight: Math.max(0, ...rects.map((r) => r.right)),
        right: column.right,
        cut: code ? code.scrollWidth > code.clientWidth + 1 || cs.textOverflow !== 'clip' || cs.overflow !== 'visible' : false,
        // The command starts on the line its text ends on, or (when not even its first word fits) on the next, at the column's left.
        sameLine: code ? Math.abs(rects[0].top + rects[0].height / 2 - (text.top + text.height / 2)) < 6 : true,
        textOnOneLine: text.height < 30,
        chipWide: code ? Math.round(code.getBoundingClientRect().width) : 0,
      };
    }));
    steps.forEach((s, i) => {
      assert.ok(s.chipRight <= s.right + 0.5, `${name} step ${i + 1}: the command ends at ${s.chipRight}, past the column at ${s.right}`);
      assert.ok(!s.cut, `${name} step ${i + 1}: the command is cut`);
      assert.ok(s.textOnOneLine, `${name} step ${i + 1}: its text is on one line`);
      if (s.beside !== null) assert.ok(s.beside || s.under, `${name} step ${i + 1}: its command is beside its text or under it, whole (beside ${s.beside}, under ${s.under})`);
      if (s.rowH > 37) wrapped.push(`${name}#${i + 1}`);
    });
    assert.ok((await live.locator('.abilities-side').evaluate((e) => e.getBoundingClientRect().bottom)) <= 1080, `${name}: the detail is on the screen`);
  }
  assert.equal(await live.locator('.abilities-side').evaluate((e) => getComputedStyle(e).overflowY), 'auto', 'and scrolls where it is longer than the screen');
  console.log(`    steps that take more than one line (a command longer than what is left of the line, under its text whole): ${wrapped.length}: ${wrapped.join(' ')}`);
  await live.locator('.abilities-grid .ability-card[data-ability="draft-pr-team-way"]').click();
  await pause(300);
  await shot(live, '04-hers-a-step-with-a-long-command');
  await live.close();
  await probe.close();
});

await test('logs no errors in the page', async () => {
  assert.deepEqual(errors, []);
});

await browser.close();
await vite.close();
await daemon.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
