// A column's collapse control: a miniature of the screen's layout, never an arrow. The column's own cell
// is filled when it is shown and dashed when it is hidden; the others are outlined. The last open
// column cannot collapse, so its control is dimmed and does nothing. In a free layout (P2) the miniature draws that layout, and
// an x beside it takes the pane off the screens.
import { useContext } from 'react';
import { PaneArrangementContext } from './arrangement';
import { layoutGlyph, todaysGlyph, type GlyphCell } from './layoutGlyph';

interface Props {
  cells: 2 | 3;
  index: number;
  shown: boolean;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}

function Glyph({ cells }: { cells: GlyphCell[] }) {
  return (
    <svg width="26" height="18" viewBox="0 0 26 18" aria-hidden="true">
      {cells.map((c, i) =>
        c.filled ? (
          <rect key={i} x={c.x - 0.8} y={c.y} width={c.w + 1.5} height={c.h} rx="1.5" fill="var(--text-primary)" />
        ) : (
          <rect
            key={i}
            x={c.x}
            y={c.y}
            width={c.w}
            height={c.h}
            rx="1.5"
            fill="none"
            stroke={c.own ? 'var(--text-primary)' : 'var(--text-disabled)'}
            strokeWidth="1.5"
            strokeDasharray={c.own ? '2.5 2' : undefined}
          />
        ),
      )}
    </svg>
  );
}

export function CollapseButton({ cells, index, shown, label, disabled = false, onClick }: Props) {
  const arrangement = useContext(PaneArrangementContext);
  const glyph = arrangement ? layoutGlyph(arrangement.columns, arrangement.pane) : todaysGlyph(cells, index, shown);
  const button = (
    <button
      type="button"
      className="collapse"
      aria-label={label}
      data-tip={label}
      aria-disabled={disabled}
      onClick={() => {
        if (!disabled) onClick();
      }}
    >
      <Glyph cells={glyph} />
    </button>
  );
  if (!arrangement?.remove || !shown) return button;
  const remove = arrangement.remove;
  const removeLabel = `Remove ${arrangement.name} from this screen`;
  return (
    <span className="collapse-group">
      {button}
      <button type="button" className="collapse pane-x" aria-label={removeLabel} data-tip={removeLabel} onClick={remove}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
          <path d="M6 6l12 12M18 6 6 18" />
        </svg>
      </button>
    </span>
  );
}
