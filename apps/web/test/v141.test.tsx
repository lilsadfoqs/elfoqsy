// v1.4.1: floating layers placed on screen and off each other, in one stacking order from the tokens; the dial's labels
// clear of every dot and label; History folded, grouped and quiet; a click edits only when it is a plain one.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PayloadOf, Ticket } from '@elfoqsy/contracts';
import { applyDetail, fieldIdsOf, historyGroups, isAutomation, lineDiff } from '@elfoqsy/state';
import { CLICK_SETTLE_MS, DRAG_PX, isPlainClick } from '../src/ui/plainClick';
import { intersects, inside, place, SCREEN, type Rect } from '../src/ui/place';
import { LAYER_ORDER } from '../src/ui/layers';
import { layoutOrbit } from '../src/left/sprint/layout';
import { DIAL_KEEP_OFF, DIAL_SIZE, dialDots, dialLabels, type DialDot, type DialLabel } from '../src/left/sprint/dialLabels';
import { mockSprint } from './helpers';

const root = join(__dirname, '..', '..', '..');
const css = readFileSync(join(__dirname, '..', 'src', 'styles.css'), 'utf8');
const tokens = readFileSync(join(root, 'design', 'tokens.css'), 'utf8');

describe("the browser's own tooltips (his answer 5)", () => {
  it('are used nowhere: every element that had a title has a data-tip, shown as a tooltip layer', () => {
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []));
    const found = files(join(__dirname, '..', 'src')).flatMap((f) =>
      readFileSync(f, 'utf8')
        .split('\n')
        .map((line, i) => ({ line, at: `${f.split('/src/')[1]}:${i + 1}` }))
        // A title attribute (not a prop of our own components: a section's or a Confluence chip's title).
        .filter(({ line }) => /(^|\s)title=/.test(line) && !/<(Section|ConfluenceChip)\b/.test(line))
        .map(({ at }) => at),
    );
    expect(found).toEqual([]);
    expect(css).not.toMatch(/\[title\]/);
  });
});

describe('placing a floating layer', () => {
  const size = { w: 200, h: 120 };
  it('goes on its side, aligned to its anchor, when it fits', () => {
    expect(place({ x: 100, y: 100, w: 80, h: 30 }, size, { side: 'bottom' })).toEqual({ x: 100, y: 136, side: 'bottom', clean: true });
    expect(place({ x: 100, y: 100, w: 80, h: 30 }, size, { side: 'bottom', align: 'end' })).toMatchObject({ x: -20 + 8 + 20, side: 'bottom' });
  });

  it('flips to the other side at the bottom of the screen, and shifts along its side to stay on it', () => {
    expect(place({ x: 1800, y: 1040, w: 80, h: 30 }, size, { side: 'bottom' })).toEqual({ x: SCREEN.w - 8 - size.w, y: 1040 - 6 - size.h, side: 'top', clean: true });
    expect(place({ x: 1880, y: 500, w: 30, h: 30 }, size, { side: 'right' })).toMatchObject({ side: 'left', x: 1880 - 6 - size.w, clean: true });
  });

  it('keeps off another open layer, sliding past it or taking another side', () => {
    const anchor = { x: 400, y: 400, w: 80, h: 30 };
    const other: Rect = { x: 380, y: 440, w: 300, h: 200 };
    const p = place(anchor, size, { side: 'bottom', avoid: [other] });
    expect(p.clean).toBe(true);
    expect(intersects({ ...p, ...size }, other)).toBe(false);
    expect(inside({ ...p, ...size }, SCREEN)).toBe(true);
  });

  it('says when nothing fits, and then takes the least bad place', () => {
    const p = place({ x: 0, y: 0, w: 1920, h: 1080 }, { w: 400, h: 400 }, { side: 'bottom' });
    expect(p.clean).toBe(false);
  });
});

describe('the stacking order', () => {
  it('comes from the tokens, bottom to top: grown dial, tooltip, menu, search', () => {
    const z = (name: string) => Number(new RegExp(`--z-${name}: (\\d+);`).exec(tokens)![1]);
    expect(LAYER_ORDER).toEqual(['dial', 'tooltip', 'menu', 'search']);
    expect(LAYER_ORDER.map(z)).toEqual([...LAYER_ORDER.map(z)].sort((a, b) => a - b));
    expect(new Set(LAYER_ORDER.map(z)).size).toBe(4);
    for (const k of LAYER_ORDER) expect(css).toMatch(new RegExp(`\\[data-layer='${k}'\\][^{]*\\{\\s*z-index: var\\(--z-${k}\\);`));
  });

  it('leaves no floating layer with a place or a stacking of its own', () => {
    for (const cls of ['status-pop', 'ed-menu', 'hint-panel', 'pmenu', 'sheet', 'find', 'tip']) {
      const rule = new RegExp(`\\n\\.${cls} \\{([^}]*)\\}`).exec(css)?.[1] ?? '';
      expect(rule, cls).not.toMatch(/position:|z-index:|\b(top|left|right|bottom):/);
    }
  });
});

describe("the dial's labels (B+)", () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const PRI = ['Blocker', 'Critical', 'Major', 'Major', 'Minor'] as const;
  const ticket = (key: string, priority?: Ticket['priority'], points?: number | null): Ticket => ({
    key,
    board: 'SHOP',
    summary: key,
    type: 'Story',
    status: 'To do',
    priority: priority ?? PRI[Math.floor(rnd() * PRI.length)]!,
    storyPoints: points !== undefined ? points : [null, 1, 2, 3, 5, 8, 13][Math.floor(rnd() * 7)]!,
    sprint: 'SHOP Sprint 52',
    sprintsCarried: 1,
    epic: null,
    reporter: '',
    created: '',
    updated: '',
    labels: [],
    linked: [],
    description: '',
  });
  /** Every label clear: no dot under it (its own neither), no other label, off the buttons and centre, inside. */
  const problems = (dots: DialDot[], labels: Map<string, DialLabel>): string[] => {
    const out: string[] = [];
    const all = [...labels.values()];
    for (const l of all) {
      for (const d of dots) {
        const cx = Math.max(l.x - d.x, 0, d.x - (l.x + l.w));
        const cy = Math.max(l.y - d.y, 0, d.y - (l.y + l.h));
        if (cx * cx + cy * cy < (d.d / 2) ** 2) out.push(`${l.text} on ${d.key}'s dot`);
      }
      for (const m of all) if (m !== l && intersects(l, m)) out.push(`${l.text} on ${m.text}`);
      for (const k of DIAL_KEEP_OFF) if (intersects(l, k)) out.push(`${l.text} on a button`);
      if (!inside(l, { x: 0, y: 0, ...DIAL_SIZE })) out.push(`${l.text} outside`);
    }
    return out;
  };

  it('keeps 3539 off 3537 when they are neighbours on a crowded ring, with dots sized by points', () => {
    const sprint = [ticket('SHOP-3537', 'Critical', 8), ticket('SHOP-3539', 'Critical', 5), ticket('SHOP-3538', 'Critical', 8), ticket('SHOP-3543', 'Critical', 13), ticket('SHOP-3559', 'Major', 3), ticket('SHOP-3049', 'Critical', 5), ticket('SHOP-3472', 'Major', 2), ticket('SHOP-1164', 'Minor', 1)];
    const dots = dialDots(layoutOrbit(sprint, [], { done: [], cancelled: [] }));
    for (const open of sprint) expect(problems(dots, dialLabels(dots, open.key)), open.key).toEqual([]);
  });

  it('places every label clear in 500 sprints of 4 to 15 tickets, of every priority and size', () => {
    const found: string[] = [];
    for (let s = 0; s < 500; s++) {
      let k = 3500;
      const sprint = Array.from({ length: 4 + Math.floor(rnd() * 12) }, () => ticket(`SHOP-${(k += 1 + Math.floor(rnd() * 3))}`));
      const dots = dialDots(layoutOrbit(sprint, [], { done: [], cancelled: [] }));
      const labels = dialLabels(dots, sprint[Math.floor(rnd() * sprint.length)]!.key);
      expect([...labels.values()].every((l) => l.clear)).toBe(problems(dots, labels).length === 0);
      found.push(...problems(dots, labels).map((p) => `sprint ${s}: ${p}`));
    }
    expect(found).toEqual([]);
  });

  it('ties a label placed farther away to its dot with a hairline', () => {
    let tied = 0;
    for (let s = 0; s < 200; s++) {
      let k = 3500;
      const sprint = Array.from({ length: 12 }, () => ticket(`SHOP-${(k += 1 + Math.floor(rnd() * 3))}`, 'Critical'));
      const dots = dialDots(layoutOrbit(sprint, [], { done: [], cancelled: [] }));
      for (const l of dialLabels(dots, sprint[0]!.key).values()) {
        if (!l.leader) continue;
        tied++;
        const d = dots.find((x) => x.key === l.key)!;
        expect(Math.hypot(l.leader.x1 - d.x, l.leader.y1 - d.y)).toBeCloseTo(d.d / 2, 5);
      }
    }
    expect(tied).toBeGreaterThan(0);
  });

  it('places the mock sprint the same way every time', () => {
    const dots = dialDots(layoutOrbit(mockSprint().open, [], { done: [], cancelled: [] }));
    expect(problems(dots, dialLabels(dots, 'SHOP-3049'))).toEqual([]);
    expect([...dialLabels(dots, 'SHOP-3049').values()]).toEqual([...dialLabels(dots, 'SHOP-3049').values()]);
  });
});

describe('History', () => {
  const ids = fieldIdsOf();
  const view = (key: string) => applyDetail(undefined, JSON.parse(readFileSync(join(__dirname, '..', 'e2e', 'fixtures', `${key}.detail.json`), 'utf8')) as PayloadOf<'ticket.detail'>, 0)!;

  it("leaves out Rank, timestamps and Automation for Jira's changes", () => {
    const d = view('SHOP-2430');
    const groups = historyGroups(d.history, d, ids);
    const fields = groups.flatMap((g) => g.changes.map((c) => c.field));
    expect(fields).not.toContain('Rank');
    expect(fields).not.toContain('End Ticket Timestamp');
    expect(groups.map((g) => g.by)).not.toContain('Automation for Jira');
    expect(isAutomation({ displayName: 'Automation for Jira' })).toBe(true);
    expect(isAutomation({ displayName: 'Quinn Bauer' })).toBe(false);
    expect(d.history.flatMap((h) => h.items).length).toBeGreaterThan(fields.length);
  });

  it('groups consecutive changes by the same person on the same day, newest first', () => {
    const d = view('SHOP-2430');
    const groups = historyGroups(d.history, d, ids);
    for (let i = 1; i < groups.length; i++) expect(groups[i - 1]!.by === groups[i]!.by && groups[i - 1]!.day === groups[i]!.day).toBe(false);
    expect(groups.length).toBeLessThan(d.history.length);
    expect(Date.parse(groups[0]!.at.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'))).toBeGreaterThan(Date.parse(groups.at(-1)!.at.replace(/([+-]\d{2})(\d{2})$/, '$1:$2')));
  });

  it("names a long text's change instead of showing both texts", () => {
    const d = view('SHOP-2430');
    const long = historyGroups(d.history, d, ids)
      .flatMap((g) => g.changes)
      .filter((c) => c.long);
    expect(long.map((c) => c.field)).toEqual(expect.arrayContaining(['Acceptance criteria']));
    const short = historyGroups(d.history, d, ids)
      .flatMap((g) => g.changes)
      .find((c) => c.field === 'Status');
    expect(short).toMatchObject({ long: false });
  });

  it('diffs two texts line by line, with a little context and the rest folded', () => {
    const before = ['Why', 'one', 'two', 'three', 'four', 'five', 'six', 'Done when the copy is verified.'].join('\n');
    const after = ['Why', 'one', 'two', 'three', 'four', 'five', 'six', 'Done when the copy is verified and purged.'].join('\n');
    expect(lineDiff(before, after)).toEqual([
      { sign: '…', text: '' },
      { sign: ' ', text: 'five' },
      { sign: ' ', text: 'six' },
      { sign: '-', text: 'Done when the copy is verified.' },
      { sign: '+', text: 'Done when the copy is verified and purged.' },
    ]);
    expect(lineDiff('', 'new')).toEqual([
      { sign: '-', text: '' },
      { sign: '+', text: 'new' },
    ]);
  });
});

describe('click to edit, select to read', () => {
  const plain = { detail: 1, button: 0, moved: 0, onControl: false, selected: false };
  it('edits only on one still press on the field itself that leaves nothing selected', () => {
    expect(isPlainClick(plain)).toBe(true);
    expect(isPlainClick({ ...plain, moved: DRAG_PX + 1 })).toBe(false); // the end of a drag
    expect(isPlainClick({ ...plain, detail: 2 })).toBe(false); // a double click
    expect(isPlainClick({ ...plain, detail: 3 })).toBe(false); // a triple click
    expect(isPlainClick({ ...plain, selected: true })).toBe(false);
    expect(isPlainClick({ ...plain, onControl: true })).toBe(false); // a link inside opens
    expect(isPlainClick({ ...plain, button: 1 })).toBe(false);
    expect(CLICK_SETTLE_MS).toBeGreaterThanOrEqual(250);
  });
});
