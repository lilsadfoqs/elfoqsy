import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MOODS, foldAll, pickVariant } from '@elfoqsy/state';
import { StatusBar, longDate } from '../src/stage/StatusBar';
import { ART, AVATAR, LookKeeper, lookOf } from '../src/ui/elfoqsy';
import { eventFactory } from './helpers';
import { FoxBadge } from '../src/ui/FoxBadge';
import { Hint, KeyRow } from '../src/ui/Hint';

const at = new Date(2026, 9, 8, 14, 24).getTime();

describe('status bar', () => {
  it('shows each pair as an icon and a count, the sentence on hover, then the date tile and the time', () => {
    const html = renderToStaticMarkup(
      <StatusBar
        items={[
          { kind: 'waiting', count: 1, sentence: '1 agent needs you' },
          { kind: 'blocked', count: 1, sentence: '1 ticket is blocked' },
        ]}
        now={at}
        lines={[]}
      />,
    );
    expect(html).toContain('role="status" aria-label="1 agent needs you, 1 ticket is blocked"');
    expect(html).toContain('data-tip="1 agent needs you"><span class="status-icon status-icon--waiting"');
    expect(html).toContain('data-tip="1 ticket is blocked"><span class="status-icon status-icon--blocked"');
    expect(html).toContain('<span class="calendar-tile" role="img" aria-label="Thursday 8 October 2026" data-tip="Thursday 8 October 2026"><span class="calendar-month">OCT</span><span class="calendar-day">8</span></span>');
    expect(html).toContain('<span class="status-time">14:24</span>');
  });

  it('shows no pairs when nothing needs looking at, and keeps the quiet status lines', () => {
    const html = renderToStaticMarkup(<StatusBar items={[]} now={at} lines={['Offline since 14:20']} />);
    expect(html).not.toContain('status-pair');
    expect(html).toContain('aria-label="Nothing needs you"');
    expect(html).toContain('<span class="status-line">Offline since 14:20</span>');
  });

  it('names months in three letters, September too', () => {
    expect(longDate(new Date(2026, 8, 3).getTime())).toBe('Thursday 3 September 2026');
    expect(renderToStaticMarkup(<StatusBar items={[]} now={new Date(2026, 8, 3).getTime()} lines={[]} />)).toContain('>SEP<');
  });
});

describe("Elfoqsy's art", () => {
  it('has three portraits and three faces per state, a fox for each, and her avatar', () => {
    for (const m of MOODS) {
      expect(ART[m].portraits).toHaveLength(3);
      expect(ART[m].faces).toHaveLength(3);
      expect(ART[m].fox).toBeTruthy();
      expect(ART[m].ring).toBe(`var(--mood-${m})`);
    }
    expect(AVATAR).toMatch(/quiet-1-face/);
    expect(ART.needs.label).toBe('Needs you');
  });

  it('never picks the same portrait twice in a row for a state', () => {
    for (let previous = 0; previous < 3; previous++) {
      for (const r of [0, 0.34, 0.67, 0.999]) expect(pickVariant(previous, 3, () => r)).not.toBe(previous);
    }
  });

  it('keeps her picture while the state holds and picks again when it changes', () => {
    let calls = 0;
    const keeper = new LookKeeper(() => (calls++ % 2 ? 0.9 : 0));
    const first = keeper.lookFor('working');
    expect(keeper.lookFor('working')).toBe(first);
    expect(keeper.lookFor('needs').mood).toBe('needs');
    const again = keeper.lookFor('working');
    expect(again.variant).not.toBe(first.variant);
  });

  it("shows the daemon's pick once there is one, so both screens show the same picture", () => {
    const e = eventFactory();
    const s = foldAll([e('elfoqsy.look', { mood: 'needs', variant: 2 })]);
    expect(lookOf(s, at)).toEqual({ mood: 'needs', variant: 2 });
    expect(s.lastVariant).toEqual({ needs: 2 });
  });

  it('draws the fox badge with the state colour and says the state', () => {
    const html = renderToStaticMarkup(<FoxBadge mood="needs" size={56} />);
    expect(html).toContain('class="fox-badge fox-badge--56" role="img" aria-label="Elfoqsy: needs you" data-tip="Needs you"');
    expect(html).toContain('--ring:var(--mood-needs)');
  });
});

describe('hints', () => {
  it('sit behind an icon; the panel is a tooltip layer drawn only on hover or focus (v1.4.1)', () => {
    const html = renderToStaticMarkup(
      <Hint label="Keyboard shortcuts" icon={<svg />}>
        <KeyRow keys={['Alt', 'N']}>New pane</KeyRow>
      </Hint>,
    );
    expect(html).toContain('aria-label="Keyboard shortcuts"');
    expect(html).not.toContain('role="tooltip"');
    // KeyRow on its own: key caps, then what they do.
    expect(renderToStaticMarkup(<KeyRow keys={['Alt', 'N']}>New pane</KeyRow>)).toContain('<kbd>Alt</kbd><kbd>N</kbd>');
  });
});
