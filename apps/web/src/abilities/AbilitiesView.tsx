// The Abilities view: the skills Elfoqsy
// and her agents learned, as cards, over the whole screen it was opened on. Left: "Abilities" with the steps saved this
// month, the tools as logos with their counts to filter by, and the cards. Right: the selected card with its three numbers
// (uses, worked, steps saved, and the questions it avoided when it has avoided any; one "New" in their place until it has a use) and its steps, one line each with its command right
// after the text; under them, where it came from in one line at 15 px (abilityOrigin). Her notice of a new
// ability is a message in the conversation, not part of this view. Nothing more: details live behind the card. Read from the
// ability.* events alone.
import { useEffect } from 'react';
import type { AbilityTool } from '@elfoqsy/contracts';
import { abilityList, abilityOrigin, abilityOriginFull, abilityTools, stepsSavedThisMonth, workedPercent, type AbilityView, type WorkspaceState } from '@elfoqsy/state';
import { AbilityCard, AbilityLogo, toolName } from '../ui/AbilityCard';
import { abilitiesView, useAbilitiesView } from '../ui/abilitiesView';
import { openLayers } from '../ui/layers';

const whole = (n: number): string => Math.round(n).toLocaleString('en-US');
/** A few questions to one decimal (0.3, 3), many as a whole number: "~0" would say none when there were some. */
const few = (n: number): string => (n < 10 ? String(Math.round(n * 10) / 10) : whole(n));

/** `now`: the daemon's time (stream.now), for this month's steps saved. */
export function AbilitiesView({ state, now }: { state: WorkspaceState; now: number }) {
  const view = useAbilitiesView();
  const all = abilityList(state);
  const shown = view.filter ? all.filter((a) => a.tool === view.filter) : all;
  const selected = (view.selected ? state.abilities[view.selected] : undefined) ?? shown[0] ?? all[0];

  // Escape closes it, once no floating layer is open above it (the top layer hears Escape first).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || openLayers().length) return;
      abilitiesView.close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <section className="abilities" aria-label="Abilities">
      <button type="button" className="icon-button abilities-close" aria-label="Close Abilities" data-tip="Close (Esc)" onClick={() => abilitiesView.close()}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
          <path d="M6 6l12 12M18 6 6 18" />
        </svg>
      </button>
      <div className="abilities-main">
        <div className="abilities-head">
          <h1>Abilities</h1>
          <span className="abilities-saved">
            <b>{whole(stepsSavedThisMonth(state, now))}</b>
            <span>steps saved this month</span>
          </span>
        </div>
        <div className="abilities-filters" role="group" aria-label="Filter by tool">
          <Filter label="All" count={all.length} on={view.filter === null} onClick={() => abilitiesView.filter(null)} />
          {abilityTools(state).map(({ tool, count }) => (
            <Filter key={tool} tool={tool} count={count} on={view.filter === tool} onClick={() => abilitiesView.filter(view.filter === tool ? null : tool)} />
          ))}
        </div>
        {all.length === 0 ? (
          <p className="abilities-empty">No abilities yet.</p>
        ) : (
          <div className="abilities-grid">
            {shown.map((a) => (
              <AbilityCard key={a.name} ability={a} size="grid" selected={a.name === selected?.name} onOpen={() => abilitiesView.select(a.name)} />
            ))}
          </div>
        )}
      </div>
      <div className="abilities-side">
        {selected && <Detail ability={selected} />}
      </div>
    </section>
  );
}

function Filter({ label, tool, count, on, onClick }: { label?: string; tool?: AbilityTool; count: number; on: boolean; onClick: () => void }) {
  return (
    <button type="button" className={`abilities-filter${on ? ' abilities-filter--on' : ''}`} aria-pressed={on} aria-label={`${label ?? toolName(tool!)}, ${count}`} data-tip={tool ? toolName(tool) : undefined} onClick={onClick}>
      {tool ? <AbilityLogo tool={tool} className="abilities-filter-logo" bare={!on} /> : <span className="abilities-filter-label">{label}</span>}
      <span className="abilities-filter-count">{count}</span>
    </button>
  );
}

function Detail({ ability }: { ability: AbilityView }) {
  const worked = workedPercent(ability);
  const origin = abilityOrigin(ability);
  const full = abilityOriginFull(ability);
  return (
    <div className="abilities-detail">
      <div className="abilities-detail-top">
        <AbilityCard ability={ability} size="detail" />
        <div className="abilities-numbers">
          {worked === null ? (
            <Number value="New" />
          ) : (
            <>
              <Number value={whole(ability.uses)} label={ability.uses === 1 ? 'use' : 'uses'} />
              <Number value={`${worked}%`} label="worked" />
              <Number value={`~${whole(ability.stepsSaved)}`} label="steps saved" />
              {ability.questionsAvoided > 0 && <Number value={`~${few(ability.questionsAvoided)}`} label="questions avoided" />}
            </>
          )}
        </div>
      </div>
      <ol className="abilities-steps" aria-label="Steps">
        {ability.steps.map((s, i) => (
          <li key={i} className="abilities-step">
            <span className="abilities-step-n">{i + 1}</span>
            <span className="abilities-step-line">
              <span className="abilities-step-text">{s.text}</span>
              {s.code && (
                <>
                  <wbr />
                  <code>{s.code}</code>
                </>
              )}
            </span>
          </li>
        ))}
      </ol>
      <p className="abilities-origin" data-tip={full === origin ? undefined : full}>
        {origin}
      </p>
    </div>
  );
}

function Number({ value, label }: { value: string; label?: string }) {
  return (
    <div className="abilities-number">
      <span className="abilities-number-value">{value}</span>
      {label && <span className="abilities-number-label">{label}</span>}
    </div>
  );
}
