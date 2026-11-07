// What a pane in a free layout knows of where it is (P2), for the controls drawn in its own header: the screen's columns, for
// the icon that draws them, and how to take the pane off the screens (the x beside its hide button). A pane in today's
// columns has none of this, and draws today's controls.
import { createContext } from 'react';
import type { GlyphPane } from './layoutGlyph';

export interface PaneArrangement {
  pane: string;
  /** A name for the x's label: "the sprint", "Elfoqsy". */
  name: string;
  columns: GlyphPane[][];
  /** Takes the pane off the screens; none while it is folded. */
  remove?: () => void;
}

export const PaneArrangementContext = createContext<PaneArrangement | null>(null);
