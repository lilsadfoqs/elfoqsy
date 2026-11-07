// Elfoqsy's art (assets/elfoqsy, from the design notes): three portraits and three face crops per state, a fox
// badge per state, and her avatar. Which of the three she shows is the daemon's pick (elfoqsy.look), so
// both screens agree; until one is recorded, this screen picks.
import type { Mood, WorkspaceState } from '@elfoqsy/state';
import { MOODS, mood, pickVariant } from '@elfoqsy/state';
import manifest from '../../../../assets/elfoqsy/manifest.json';

const files = import.meta.glob<string>('../../../../assets/elfoqsy/**/*.png', { eager: true, import: 'default' });

function art(path: string): string {
  const src = files[`../../../../assets/elfoqsy/${path}`];
  if (!src) throw new Error(`assets/elfoqsy/${path} is missing`);
  return src;
}

const ALT: Record<Mood, string> = {
  quiet: 'Elfoqsy, relaxed: all quiet',
  working: 'Elfoqsy at work',
  thinking: 'Elfoqsy thinking it through',
  needs: 'Elfoqsy glancing over, waiting for your answer',
  broken: 'Elfoqsy, alert: something broke',
  done: 'Elfoqsy, pleased: an agent just finished',
};

export interface MoodArt {
  /** "Needs you": the badge's tooltip. */
  label: string;
  /** The badge ring, a token from design/tokens.css. */
  ring: string;
  fox: string;
  portraits: string[];
  faces: string[];
  alt: string;
}

export const ART = Object.fromEntries(
  MOODS.map((m) => {
    const entry = manifest.states[m];
    return [m, { label: entry.label, ring: `var(--mood-${m})`, fox: art(entry.fox), portraits: entry.portraits.map(art), faces: entry.faces.map(art), alt: ALT[m] }];
  }),
) as Record<Mood, MoodArt>;

/** Her identity in the chat and on the rails, whatever her state. */
export const AVATAR = art(manifest.avatar);

export interface Look {
  mood: Mood;
  variant: number;
}

/** Keeps her picture steady while her state holds, and picks a new one when it changes. */
export class LookKeeper {
  private current: Look | null = null;
  private readonly last: Partial<Record<Mood, number>> = {};

  constructor(private readonly random: () => number = Math.random) {}

  lookFor(mood: Mood): Look {
    if (this.current?.mood !== mood) {
      const variant = pickVariant(this.last[mood], ART[mood].portraits.length, this.random);
      this.last[mood] = variant;
      this.current = { mood, variant };
    }
    return this.current;
  }
}

const keeper = new LookKeeper();
/** Her look: the left column shows the portrait, the map's centre the matching face. */
export function lookOf(s: WorkspaceState, now: number): Look {
  return s.look ? { mood: s.look.mood, variant: s.look.variant } : keeper.lookFor(mood(s, now));
}
