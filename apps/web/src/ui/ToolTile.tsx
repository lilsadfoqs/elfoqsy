// A tool's tile: a rounded square in its colour with its official logo, next to the tool's name, which stays as text for
// screen readers. A vendor's own icon that is its own tile (Atlassian's, Microsoft's) is drawn as it is, with no tile behind it.
// Sizes: 18px on a terminal line, 16px in a group chip and beside a link, 20px in Elfoqsy's thinking indicator, 24px elsewhere.
import type { CSSProperties } from 'react';
import { TILES, type TileName } from './toolIcons';

export function ToolTile({ name, size = 24 }: { name: TileName; size?: 16 | 18 | 20 | 24 }) {
  const tile = TILES[name]();
  const style = { '--tile-bg': tile.bg ? `var(${tile.bg})` : 'transparent' } as CSSProperties;
  if (tile.kind === 'img') {
    return (
      <span className={`tile tile--${size} tile--img`} data-tile={name} style={style} aria-hidden="true">
        <img src={tile.src} alt="" />
      </span>
    );
  }
  return (
    <span className={`tile tile--${size}`} data-tile={name} style={{ ...style, '--tile-fg': `var(${tile.ink})` } as CSSProperties} aria-hidden="true">
      <span className="tile-logo" style={{ maskImage: `url("${tile.src}")`, WebkitMaskImage: `url("${tile.src}")` }} />
    </span>
  );
}
