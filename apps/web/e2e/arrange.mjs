// What the browser tests of the free layout (P2) do with two windows, as a person does: hover a pane for its grip, take the
// grip, carry the pane over a zone, look, and let go; across windows too. The browser's own drag and drop does the carrying
// inside a window; across windows (headless Chrome has one pointer) the other window is sent the same drag events a real
// drag out of the first one would give it, with the pane in the drag's types, and the first window's drag is let go outside.
//
// Expectations come from the layout engine itself (packages/state/src/layout.ts, loaded through Vite), so these tests check
// the wiring: pointer, zones, skeleton, drop, event, both windows. The engine's own rules are unit-tested.

export const PANES = ['sprint', 'elfoqsy', 'conversation', 'map', 'terminals'];
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** Each pane's box in today's columns (no layout saved); a free screen's boxes name themselves. */
const CLASSIC = {
  sprint: '.lcol-wrap:has(> .lcol--sprint)',
  elfoqsy: '.elf',
  conversation: '.chat:not(.chat--rail)',
  map: '.rcol--map',
  terminals: '.rcol--terminals',
};

/** A pane's box on a page, in page pixels (the stage is 1920 × 1080 at scale 1 in these windows), or null. */
export async function paneBox(page, pane) {
  const free = page.locator(`.fpane[data-fpane="${pane}"]`);
  if ((await free.count()) && (await free.first().evaluate((e) => getComputedStyle(e).visibility)) !== 'hidden') return free.first().boundingBox();
  const classic = page.locator(CLASSIC[pane]);
  return (await classic.count()) ? classic.first().boundingBox() : null;
}

/** What a window shows of the arrangement: the mode, each pane's box, the skeleton, the chip, the empty screen. */
export function readWindow(page) {
  return page.evaluate(() => {
    const rect = (e) => {
      const r = e.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    };
    const shown = (e) => getComputedStyle(e).visibility !== 'hidden';
    const sk = document.querySelector('[data-skeleton]');
    const plus = document.querySelector('.fplus');
    const menu = document.querySelector('[data-layer="menu"].addmenu');
    return {
      classic: !!document.querySelector('.screen--left, .screen--right'),
      free: !!document.querySelector('.screen--free'),
      panes: Object.fromEntries([...document.querySelectorAll('.fpane')].filter(shown).map((e) => [e.dataset.fpane, rect(e)])),
      // What each pane shows of its fold: rail, bar or open.
      folds: Object.fromEntries([...document.querySelectorAll('.fpane')].filter(shown).map((e) => [e.dataset.fpane, e.dataset.fold ?? null])),
      // Each pane's hide (or show) button and its x, and what the hide button's icon draws: cells, and how many are dashed or filled.
      controls: Object.fromEntries(
        [...document.querySelectorAll('.fpane')].filter(shown).map((e) => {
          const hide = e.querySelector('button.collapse:not(.pane-x)');
          const x = e.querySelector('button.pane-x');
          const cells = hide ? [...hide.querySelectorAll('svg rect')] : [];
          return [
            e.dataset.fpane,
            {
              hide: hide ? { ...rect(hide), label: hide.getAttribute('aria-label') } : null,
              x: x ? { ...rect(x), opacity: Number(getComputedStyle(x).opacity), label: x.getAttribute('aria-label') } : null,
              cells: cells.length,
              dashed: cells.filter((c) => c.getAttribute('stroke-dasharray')).length,
              filled: cells.filter((c) => c.getAttribute('fill') !== 'none').length,
            },
          ];
        }),
      ),
      skeleton: sk ? { pane: sk.dataset.skeleton, ...rect(sk) } : null,
      chip: document.querySelector('[data-chip]')?.dataset.chip ?? null,
      empty: !!document.querySelector('[data-empty-screen]'),
      emptyOffers: [...document.querySelectorAll('.fempty-pane')].map((b) => b.textContent),
      grip: (() => {
        const g = document.querySelector('.pgrip--shown');
        return g ? { pane: g.dataset.grip, ...rect(g) } : null;
      })(),
      pluses: document.querySelectorAll('.fplus').length,
      plus: plus ? { at: plus.dataset.plus, ...rect(plus) } : null,
      menu: menu ? { title: menu.querySelector('.addmenu-title')?.textContent ?? '', items: [...menu.querySelectorAll('.addmenu-item')].map((b) => ({ name: b.querySelector('.addmenu-name').textContent, note: b.querySelector('.addmenu-note').textContent, disabled: b.disabled })) } : null,
    };
  });
}

/** The point in a pane's box that a zone kind names: the top quarter, the bottom quarter, the left or the right half. */
export function zonePoint(kind, r) {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  return { above: { x: cx, y: r.y + r.h * 0.1 }, below: { x: cx, y: r.y + r.h * 0.9 }, left: { x: r.x + r.w * 0.2, y: cy }, right: { x: r.x + r.w * 0.8, y: cy } }[kind];
}

/**
 * Hover a pane for its grip, take it, and lift the pane: the pointer goes down on the grip and moves a little, which is where
 * the browser starts the drag. Returns where the pointer is.
 */
export async function takeGrip(page, pane) {
  const box = await paneBox(page, pane);
  if (!box) throw new Error(`no ${pane} on this screen`);
  // Then onto the grip that appears there.
  // To the pane's top area at the pace of a hand (a rail is narrower than that: over its middle).
  await page.mouse.move(box.x + box.width / 2 + Math.min(90, Math.max(0, box.width / 2 - 8)), box.y + 70, { steps: 6 });
  await pause(150);
  const grip = await page.locator('.pgrip--shown').boundingBox();
  if (!grip) throw new Error(`no grip on ${pane}`);
  const g = { x: grip.x + grip.width / 2, y: grip.y + grip.height / 2 };
  await page.mouse.move(g.x, g.y, { steps: 4 });
  await pause(100);
  await page.mouse.down();
  await page.mouse.move(g.x + 14, g.y + 14, { steps: 3 });
  await pause(250);
  return { x: g.x + 14, y: g.y + 14 };
}

/** Along the top row (over no pane), and then onto the target in one move: a drag that has no zone behind it when it arrives. */
export async function approach(page, from, to) {
  await page.mouse.move(from.x, 40, { steps: 6 });
  await page.mouse.move(to.x, 40, { steps: 10 });
  await pause(120);
  await page.mouse.move(to.x, to.y);
  await pause(350);
}

/** Drag events as a drag out of another window gives this one, with the pane in the drag's types. */
export async function dragEvents(page, pane) {
  const cdp = await page.context().newCDPSession(page);
  const data = { items: [{ mimeType: 'application/x-elfoqsy-pane', data: pane }, { mimeType: `application/x-elfoqsy-pane-${pane}`, data: pane }], dragOperationsMask: 1 | 2 | 16 };
  const send = (type, x, y) => cdp.send('Input.dispatchDragEvent', { type, x, y, data });
  return { enter: (x, y) => send('dragEnter', x, y), over: (x, y) => send('dragOver', x, y), drop: (x, y) => send('drop', x, y), leave: () => send('dragCancel', 0, 0), cdp };
}

/** The pointer leaves a window while a drag is on: the browser sends it a dragleave and then nothing more. */
export async function leaveWindow(page) {
  await page.evaluate(() => document.querySelector('.stage').dispatchEvent(new DragEvent('dragleave', { bubbles: true, cancelable: true, clientX: 0, clientY: 0, relatedTarget: null })));
  await pause(300);
}

/**
 * The first window's pane carried to the second. The second window is sent the drag at its top row, then at the target; the
 * moment to look is between `carry` and `release`. The first window sees the pointer leave, and when the drop is done it is
 * let go outside it, which is a cancel for it (its `dragend`).
 */
export async function carryAcross(source, target, pane) {
  const hand = await takeGrip(source, pane);
  const events = await dragEvents(target, pane);
  await leaveWindow(source);
  return {
    events,
    async carry(to) {
      await events.enter(to.x, 40);
      await events.over(to.x, 40);
      await pause(150);
      await events.over(to.x, to.y);
      await pause(350);
    },
    async release(to, drops = true) {
      if (drops) await events.drop(to.x, to.y);
      else await events.leave();
      await pause(100);
      // Let go outside the first window, as the person did: over no pane of it, which an empty screen would take for a drop.
      await source.mouse.move(hand.x, -30);
      await source.mouse.up();
    },
  };
}
