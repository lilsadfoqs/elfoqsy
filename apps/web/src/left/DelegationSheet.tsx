// What Elfoqsy decides for alex (item 7): each category decided by her, decided and told, or asked of him;
// his precedents ("Let Elfoqsy decide this kind next time"), each with Remove; how many agents may work at once; and how
// often he changed her decisions. Only his changes count; the tester's are refused by the daemon.
import type { DelegationSetting } from '@elfoqsy/contracts';
import { DEFAULT_MAX_AGENTS, DELEGATION_CATEGORIES, type WorkspaceState } from '@elfoqsy/state';
import { stream } from '../state/workspace';
import { Floating, type Layer } from '../ui/layers';

const SETTINGS: Array<{ setting: DelegationSetting; label: string }> = [
  { setting: 'decide', label: 'Decide' },
  { setting: 'decide_and_tell', label: 'Decide and tell me' },
  { setting: 'ask', label: 'Ask me' },
];

/** A panel (a floating layer, at menu level) under the settings button above her portrait. */
export function DelegationSheet({ state, layer }: { state: WorkspaceState; layer: Layer }) {
  const precedents = Object.values(state.precedents).sort((a, b) => b.at - a.at);
  const max = state.settings.maxAgents ?? DEFAULT_MAX_AGENTS;
  const decisions = Object.values(state.decisions);
  const changed = decisions.filter((d) => d.changed?.by === 'you').length;
  const label = (c: string) => DELEGATION_CATEGORIES.find((x) => x.category === c)?.label ?? c;
  return (
    <Floating layer={layer} side="bottom" align="start" className="sheet" role="dialog" aria-label="What Elfoqsy decides for you">
      <div className="sheet-head">
        <b>What Elfoqsy decides for you</b>
        <button type="button" className="sheet-close" aria-label="Close" onClick={() => layer.hide(true)}>
          ×
        </button>
      </div>
      <ul className="deleg">
        {DELEGATION_CATEGORIES.map((c) => (
          <li key={c.category}>
            <span className="deleg-what">{c.label}</span>
            <span className="seg" role="radiogroup" aria-label={c.label}>
              {SETTINGS.map((s) => (
                <button key={s.setting} type="button" role="radio" aria-checked={state.delegation[c.category] === s.setting} onClick={() => stream.setDelegation(c.category, s.setting)}>
                  {s.label}
                </button>
              ))}
            </span>
          </li>
        ))}
      </ul>
      <div className="sheet-section">
        <b>Precedents</b>
        {precedents.length === 0 ? (
          <span className="sheet-muted">None yet. Tick “Let Elfoqsy decide this kind next time” on a question to add one.</span>
        ) : (
          <ul className="precedents">
            {precedents.map((p) => (
              <li key={p.precedentId}>
                <span className="precedent-text">
                  <span>
                    {label(p.category)}, {p.ticketType} tickets
                  </span>
                  <span className="sheet-muted">
                    “{p.question}” → {p.answer}
                  </span>
                </span>
                <button type="button" className="button-outline button-outline--small" onClick={() => stream.removePrecedent(p.precedentId)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="sheet-section sheet-row">
        <b>Agents at once</b>
        <span className="stepper">
          <button type="button" aria-label="One fewer" disabled={max <= 1} onClick={() => stream.setMaxAgents(max - 1)}>
            −
          </button>
          <span aria-live="polite">{max}</span>
          <button type="button" aria-label="One more" disabled={max >= 20} onClick={() => stream.setMaxAgents(max + 1)}>
            +
          </button>
        </span>
      </div>
      <div className="sheet-section sheet-row">
        <b>Her decisions</b>
        <span className="sheet-muted">
          {decisions.length} made, {changed} changed by you
        </span>
      </div>
    </Floating>
  );
}
