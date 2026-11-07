// An ability as a card: portrait, its tool's official logo faded and
// turned behind it, its level in a ring that fills toward the next level, its title, and who found it (Elfoqsy's face, or
// the agent's number, or his picture for one he asked for); a red dot when it needs a re-check. Three sizes: the grid's, the selected card's, and the small card
// of Elfoqsy's notice. Colours, type and spacing are tokens (styles.css, .ability-*).
import type { ReactNode } from 'react';
import type { AbilityTool } from '@elfoqsy/contracts';
import { abilityProgress, type AbilityView } from '@elfoqsy/state';
import { AVATAR } from './elfoqsy';
import { HIS_AVATAR, PERSON_ICON } from './people';
import { TILES, type TileName } from './toolIcons';

export type CardSize = 'grid' | 'detail' | 'mini';

export const TOOL_TILE: Record<AbilityTool, TileName> = {
  kubernetes: 'kubernetes',
  coralogix: 'coralogix',
  github: 'github',
  aws: 'aws',
  jira: 'jira',
  confluence: 'confluence',
  docker: 'docker',
  test: 'test',
  teams: 'teams',
  outlook: 'outlook',
  sharepoint: 'sharepoint',
  onedrive: 'onedrive',
  elfoqsy: 'elfoqsy',
  other: 'other',
};

const TOOL_NAME: Record<AbilityTool, string> = {
  kubernetes: 'Kubernetes',
  coralogix: 'Coralogix',
  github: 'GitHub',
  aws: 'AWS',
  jira: 'Jira',
  confluence: 'Confluence',
  docker: 'Docker',
  test: 'Tests',
  teams: 'Teams',
  outlook: 'Outlook',
  sharepoint: 'SharePoint',
  onedrive: 'OneDrive',
  elfoqsy: 'Elfoqsy',
  other: 'Other',
};

export const toolName = (tool: AbilityTool): string => TOOL_NAME[tool];

/**
 * How much of its box a logo fills as a watermark. The prototype draws each at the size that looks right for it, none edge to edge
 * (57% to 94% of the 209 px box) and where it sits: these are the factors that give each real logo the extent and the place it has
 * there (a file draws its mark anywhere in its square, so the place is a shift, in percent of the box), measured from the
 * prototype's picture; a tool the prototype has no logo for takes the usual 80%, centred.
 */
const MARK: Partial<Record<AbilityTool, { scale: number; x?: number; y?: number }>> = {
  kubernetes: { scale: 0.95, y: -0.5 },
  coralogix: { scale: 0.72 },
  github: { scale: 0.8, y: -0.7 },
  aws: { scale: 1.07, x: -1.9, y: 5 },
  jira: { scale: 1.2, x: 1.2, y: -1.4 },
  test: { scale: 1.04, x: 5.5, y: -8.1 },
  teams: { scale: 0.78, x: -0.7, y: -1.9 },
};
const MARK_USUAL = { scale: 0.8 };

/**
 * A tool's official logo, alone: in its brand colour (a neutral tile's logo in the primary text colour), as in the prototype.
 * `bare`: the mark without the square a vendor's file draws it on (Jira, Confluence, AWS), as the prototype's logos are; `placed`,
 * for a watermark: at the size and place the prototype gives it in the card.
 */
export function AbilityLogo({ tool, className, bare, placed }: { tool: AbilityTool; className?: string; bare?: boolean; placed?: boolean }) {
  const tile = TILES[TOOL_TILE[tool]]();
  const m = MARK[tool] ?? MARK_USUAL;
  const shift = placed ? { transform: `translate(${(m as { x?: number }).x ?? 0}%, ${(m as { y?: number }).y ?? 0}%) scale(${m.scale})` } : {};
  const src = bare && tile.mark ? tile.mark : tile.src;
  if (tile.kind === 'img') return <img className={className} src={src} alt="" aria-hidden="true" style={shift} />;
  const ink = tile.bg === '--tile-neutral' ? tile.ink : tile.bg;
  return <span className={className} aria-hidden="true" style={{ backgroundColor: `var(${ink})`, maskImage: `url("${src}")`, WebkitMaskImage: `url("${src}")`, ...shift }} />;
}

const RING = { grid: 44, detail: 56, mini: 28 } as const;

/** The level, in a ring that fills toward the next one (full at level 5). */
export function LevelRing({ ability, size }: { ability: Pick<AbilityView, 'level' | 'worked'>; size: CardSize }) {
  const d = RING[size];
  const r = d / 2 - 3;
  const c = 2 * Math.PI * r;
  const filled = abilityProgress(ability.worked) * c;
  return (
    <span className={`ability-ring ability-ring--${size}`} aria-label={`Level ${ability.level}`} style={{ width: d, height: d }}>
      <svg width={d} height={d} aria-hidden="true">
        <circle className="ability-ring-track" cx={d / 2} cy={d / 2} r={r} />
        {filled > 0 && <circle className="ability-ring-fill" cx={d / 2} cy={d / 2} r={r} strokeDasharray={`${filled.toFixed(1)} ${c.toFixed(1)}`} />}
      </svg>
      <span className="ability-ring-level">{ability.level}</span>
    </span>
  );
}

/** Who found it: Elfoqsy's face, the agent's number on her colour, or his own picture for one he asked for (the person icon until he gives one). */
export function FinderBadge({ ability, size }: { ability: Pick<AbilityView, 'finder'>; size: CardSize }) {
  const f = ability.finder;
  if (f.by === 'elfoqsy') return <img className={`ability-finder ability-finder--${size}`} src={AVATAR} alt="Found by Elfoqsy" data-tip="Found by Elfoqsy" />;
  if (f.by === 'alex') {
    const tip = 'You asked for it';
    if (HIS_AVATAR) return <img className={`ability-finder ability-finder--${size}`} src={HIS_AVATAR} alt={tip} data-tip={tip} />;
    return (
      <span className={`ability-finder ability-finder--you ability-finder--${size}`} aria-label={tip} data-tip={tip}>
        <span className="ability-finder-icon" style={{ maskImage: `url("${PERSON_ICON}")`, WebkitMaskImage: `url("${PERSON_ICON}")` }} />
      </span>
    );
  }
  const tip = `Found by Agent ${f.agentNumber}${f.ticket ? ` on ${f.ticket}` : ''}`;
  return (
    <span className={`ability-finder ability-finder--agent ability-finder--${size}`} aria-label={tip} data-tip={tip}>
      {f.agentNumber}
    </span>
  );
}

function Face({ ability, size }: { ability: AbilityView; size: CardSize }): ReactNode {
  return (
    <>
      <span className="ability-logo-wrap" aria-hidden="true">
        <AbilityLogo tool={ability.tool} className="ability-logo" bare placed />
      </span>
      <span className="ability-shade" aria-hidden="true" />
      <span className="ability-top">
        <LevelRing ability={ability} size={size} />
      </span>
      {ability.needsRecheck && <span className="ability-recheck" aria-label="Needs re-check" data-tip={`Needs re-check: ${ability.needsRecheck.reason}`} />}
      <span className="ability-bottom">
        {size !== 'mini' && <span className="ability-title">{ability.title}</span>}
        <FinderBadge ability={ability} size={size} />
      </span>
    </>
  );
}

/** A card. With onOpen it is a button (the grid's card, the notice's); without, the selected card in the detail. */
export function AbilityCard({ ability, size, selected, onOpen }: { ability: AbilityView; size: CardSize; selected?: boolean; onOpen?: () => void }) {
  const className = `ability-card ability-card--${size} ability-card--${ability.tool}`;
  const label = `${ability.title}, level ${ability.level}${ability.needsRecheck ? ', needs re-check' : ''}`;
  if (!onOpen) {
    return (
      <div className={className} aria-label={label}>
        <Face ability={ability} size={size} />
      </div>
    );
  }
  return (
    <button type="button" className={className} aria-label={label} aria-pressed={size === 'grid' ? !!selected : undefined} data-ability={ability.name} onClick={onOpen}>
      <Face ability={ability} size={size} />
    </button>
  );
}
