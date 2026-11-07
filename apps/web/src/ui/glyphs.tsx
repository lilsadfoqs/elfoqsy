// Ticket-type and pull-request glyphs, white inside their status circle. One set of paths for both
// the SVG on /left and the canvas on /right, taken from the prototypes.
import type { TicketType } from '@elfoqsy/contracts';

type Glyph = 'bug' | 'story' | 'task';

export const GLYPH_PATHS: Record<Glyph, { d: string; fill: boolean; stroke: number }> = {
  bug: {
    d: 'M12 8a4 4 0 0 1 4 4v4a4 4 0 0 1-8 0v-4a4 4 0 0 1 4-4zM9.5 8a2.5 2.5 0 0 1 5 0M8 12H4M20 12h-4M8 16H5M19 16h-3',
    fill: false,
    stroke: 2.4,
  },
  story: { d: 'M6 3h12v18l-6-4.5L6 21z', fill: true, stroke: 0 },
  task: { d: 'm5 12 4.5 4.5L19 7', fill: false, stroke: 3 },
};

/** Jira's three: bookmark for Story, check for Task, bug for Bug. Epic and Sub-task borrow the closest. */
export function glyphFor(type: TicketType): Glyph {
  switch (type) {
    case 'Bug':
      return 'bug';
    case 'Story':
    case 'Epic':
      return 'story';
    case 'Task':
    case 'Sub-task':
      return 'task';
  }
}

/** Glyph size is about 42% of the circle. */
export const glyphSize = (diameter: number): number => Math.round(diameter * 0.42);

export function TypeGlyph({ type, size }: { type: TicketType; size: number }) {
  const g = GLYPH_PATHS[glyphFor(type)];
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="glyph">
      {g.fill ? (
        <path d={g.d} fill="var(--glyph)" />
      ) : (
        <path d={g.d} fill="none" stroke="var(--glyph)" strokeWidth={g.stroke} strokeLinecap="round" strokeLinejoin="round" />
      )}
    </svg>
  );
}

export function PullRequestGlyph({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="var(--glyph)" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="18" r="2.5" />
      <path d="M6 8.5v7M18 15.5V10a4 4 0 0 0-4-4h-3" />
      <path d="m12 3.5-2.5 2.5 2.5 2.5" />
    </svg>
  );
}
