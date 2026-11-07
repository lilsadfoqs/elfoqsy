// The small icons that stand beside text (never a letter): the icon of the tool a link goes to, of what kind of file an
// attachment is, and of a pull request's or its CI's state. Official files, in assets/tool-icons (SOURCES.md).
import type { CSSProperties } from 'react';
import { STATE_ICONS, fileIconSrc, fileKind, tileForUrl, type StateIconName } from './linkIcons';
import { ToolTile } from './ToolTile';
import { iconUrl, type TileName } from './toolIcons';

/** The icon of the tool an address belongs to, 16 px beside the link; nothing for an address nobody here knows. */
export function LinkIcon({ url }: { url: string }) {
  const tile = tileForUrl(url);
  return tile ? (
    <span className="link-icon">
      <ToolTile name={tile} size={16} />
    </span>
  ) : null;
}

/** A tool's icon at link size, by name. */
export const ToolMark = ({ name }: { name: TileName }) => (
  <span className="link-icon">
    <ToolTile name={name} size={16} />
  </span>
);

/** The file type icon of an attachment (Microsoft's), by its name and media type. */
export function FileIcon({ filename, mimeType }: { filename: string; mimeType?: string }) {
  const kind = fileKind(filename, mimeType);
  return <img className="file-icon" data-file-kind={kind} src={fileIconSrc(kind)} alt="" aria-hidden="true" width="20" height="20" />;
}

/** GitHub's icon for a pull request's state or its CI's, in the state's colour. */
export function StateIcon({ name }: { name: StateIconName }) {
  const spec = STATE_ICONS[name];
  const src = iconUrl(`github/${spec.file}.svg`);
  const style = { '--state-ink': `var(${spec.ink})`, maskImage: `url("${src}")`, WebkitMaskImage: `url("${src}")` } as CSSProperties;
  return <span className="state-icon" data-state-icon={name} style={style} aria-hidden="true" />;
}
