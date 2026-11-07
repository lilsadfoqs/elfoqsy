// A small picture of each pane, for the add menu (P2). The sprint, conversation and terminals are the pictures their rails
// already draw; the map's is its agents round Elfoqsy; Elfoqsy's is her avatar.
import type { PaneId } from '@elfoqsy/state';
import { AVATAR } from '../ui/elfoqsy';

const base = { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'var(--text-primary)', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;

export function PaneIcon({ pane }: { pane: PaneId }) {
  switch (pane) {
    case 'sprint':
      return (
        <svg {...base}>
          <circle cx="12" cy="12" r="10" />
          <circle cx="12" cy="12" r="6" />
          <circle cx="12" cy="12" r="2" fill="var(--text-primary)" stroke="none" />
        </svg>
      );
    case 'elfoqsy':
      return <img src={AVATAR} alt="" width="20" height="20" style={{ borderRadius: '50%', objectFit: 'cover' }} />;
    case 'conversation':
      return (
        <svg {...base}>
          <path d="M4 5h16v11H9l-5 4z" />
        </svg>
      );
    case 'map':
      return (
        <svg {...base}>
          <circle cx="12" cy="12" r="3" />
          <circle cx="5" cy="5" r="2" />
          <circle cx="19" cy="5" r="2" />
          <circle cx="5" cy="19" r="2" />
          <circle cx="19" cy="19" r="2" />
          <path d="M7 7l3 3M17 7l-3 3M7 17l3-3M17 17l-3-3" />
        </svg>
      );
    case 'terminals':
      return (
        <svg {...base}>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="m7 9 3 3-3 3M12 15h5" />
        </svg>
      );
  }
}
