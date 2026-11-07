// Her state at a glance: a fox on a dark disc ringed in the state's colour, on the top-left corner of her
// portrait (56px) and of her circle on the map (40px).
import type { CSSProperties } from 'react';
import type { Mood } from '@elfoqsy/state';
import { ART } from './elfoqsy';

export function FoxBadge({ mood, size }: { mood: Mood; size: 40 | 56 }) {
  const art = ART[mood];
  return (
    <span className={`fox-badge fox-badge--${size}`} role="img" aria-label={`Elfoqsy: ${art.label.toLowerCase()}`} data-tip={art.label} style={{ '--ring': art.ring } as CSSProperties}>
      <img src={art.fox} alt="" />
    </span>
  );
}
