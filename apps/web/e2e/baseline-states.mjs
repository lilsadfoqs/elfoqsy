// The two screens in a fixed set of states, captured as PNGs (P1, criterion 6: with no layout saved, both screens look exactly
// as today). The clock is fixed and motion reduced, so the same code gives the same pixels; her portrait is pinned with an
// elfoqsy.look event, which the daemon would record.
import { scenario, T0 } from './scenario.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fixed = (page) => page.clock.setFixedTime(new Date(T0 + 30 * 60_000));
const looked = (events) => [...events, { seq: events.at(-1).seq + 1, id: 'E-look', ts: new Date(T0).toISOString(), source: 'orchestrator', type: 'elfoqsy.look', payload: { mood: 'working', variant: 0 } }];

export function baselineStates() {
  const s = scenario();
  const n = s.narrative();
  const click = async (page, label) => {
    await page.locator(`button[aria-label="${label}"]`).click();
    await wait(400);
  };
  const openTicket = async (page, key) => {
    await page.locator(`button.ticket:has(.ticket-circle[aria-label^="${key},"])`).click();
    await page.locator('.tv-key a').waitFor();
    await wait(600);
  };
  return [
    ['left-sprint-map', '/left', s.tickets(), async () => {}],
    ['left-ticket-open', '/left', s.tickets(), (p) => openTicket(p, 'SHOP-3538')],
    ['left-narrative', '/left', [...n.base, ...n.mid, ...n.end], (p) => openTicket(p, 'SHOP-3546')],
    ['left-sprint-hidden', '/left', s.tickets(), (p) => click(p, 'Hide the sprint')],
    ['left-elfoqsy-hidden', '/left', s.tickets(), (p) => click(p, 'Hide Elfoqsy and her agents')],
    ['left-conversation-hidden', '/left', s.tickets(), (p) => click(p, 'Hide the conversation')],
    ['right-four-agents', '/right', s.design(), async () => wait(1200)],
    ['right-map-hidden', '/right', s.design(), (p) => click(p, 'Hide the live map')],
    ['right-terminals-hidden', '/right', s.design(), (p) => click(p, 'Hide the agent terminals')],
    ['right-one-agent', '/right', s.oneAgent(), async () => wait(1200)],
  ];
}

/** Opens each state on its own page, does what puts it in that state, and saves the screenshot as <dir>/<name>.png. */
export async function captureStates(stack, dir, log = () => {}) {
  for (const [name, path, events, act] of baselineStates()) {
    const page = await stack.open(path, looked(events), undefined, 'reduce', fixed);
    // The grip, the x and the + are hover affordances (P2, C): a pointer that rests over a pane after a click shows them. The pictures are of the screens, not of them.
    await page.addStyleTag({ content: '.pgrip, .pane-xf, .fplus { visibility: hidden !important; }' });
    await wait(1500);
    await act(page);
    await wait(600);
    await page.screenshot({ path: `${dir}/${name}.png` });
    await page.close();
    log(name);
  }
}
