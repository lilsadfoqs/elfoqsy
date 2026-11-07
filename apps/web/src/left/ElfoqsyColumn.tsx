// Elfoqsy's column: her portrait for her state (one of three, picked when the state changes) with her fox
// badge, her name and one line of her own, the conversations like Claude web's sidebar, and Claude usage
// at the bottom (the only place it is shown). Hidden, it is a rail with her avatar and her agents' badges.
import type { WorkspaceState } from '@elfoqsy/state';
import { conversationGroups, todayConversation } from '@elfoqsy/state';
import { stream } from '../state/workspace';
import { CollapseButton } from '../ui/CollapseButton';
import { ART, AVATAR, type Look } from '../ui/elfoqsy';
import { FoxBadge } from '../ui/FoxBadge';
import { AgentBadge } from '../ui/TicketBits';
import { Meter } from './sprint/SprintColumn';
import { EARLIER, activeAgents, conversationTime, elfoqsyLine, hasEarlierMessages, threadOf } from './model';
import { refTo, useLayer } from '../ui/layers';
import { DelegationSheet } from './DelegationSheet';
import { abilitiesView } from '../ui/abilitiesView';

interface Props {
  state: WorkspaceState;
  look: Look;
  /** The open conversation, EARLIER for messages outside any, or null for a new one. */
  selected: string | null;
  onSelect: (conversationId: string | null) => void;
  open: boolean;
  lastOpen: boolean;
  /** Alone in the panel: it fills it. */
  alone: boolean;
  /** Today's column hides to a rail; a pane in a layout of its own does not (P2), and has no button for it. */
  onToggle?: () => void;
}

export function ElfoqsyColumn({ state, look, selected, onSelect, open, lastOpen, alone, onToggle }: Props) {
  const sheet = useLayer('menu');
  if (!open) {
    return (
      <div className="elf elf--rail" aria-label="Elfoqsy, hidden">
        {onToggle && <CollapseButton cells={3} index={1} shown={false} label="Show Elfoqsy and her agents" onClick={onToggle} />}
        <img className="rail-portrait rail-portrait--panel" src={AVATAR} alt="Elfoqsy" />
        {activeAgents(state).map((run) => (
          <AgentBadge key={run.runId} run={run} size={30} />
        ))}
      </div>
    );
  }
  const now = stream.now();
  const groups = conversationGroups(state, now);
  const earlier = hasEarlierMessages(state);
  return (
    <div className={`elf${alone ? ' elf--alone' : ''}`} aria-label="Elfoqsy">
      <div className="elf-control">
        <button ref={refTo(sheet.anchor)} type="button" className="elf-settings" aria-label="What Elfoqsy decides for you" data-tip="What Elfoqsy decides for you" aria-haspopup="dialog" aria-expanded={sheet.open} onClick={sheet.toggle}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" />
            <circle cx="16" cy="6" r="2" />
            <circle cx="10" cy="12" r="2" />
            <circle cx="18" cy="18" r="2" />
          </svg>
        </button>
        <button
          type="button"
          className="elf-settings"
          aria-label="What Elfoqsy decided"
          data-tip="What Elfoqsy decided since your last digest"
          onClick={() => {
            // In the open conversation, or Today's when none is open; then show it there.
            const here = selected && selected !== EARLIER ? selected : undefined;
            if (stream.digest(here)) onSelect(here ?? todayConversation(stream.now()).conversationId);
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m4 7 2 2 4-4M4 17l2 2 4-4M13 7h7M13 17h7" />
          </svg>
        </button>
        <button type="button" className="elf-settings" aria-label="Abilities" data-tip="Abilities: what Elfoqsy and her agents have learned" onClick={() => abilitiesView.open()}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="5" width="11" height="15" rx="2" />
            <path d="M17 6.5 20.2 7.6a1 1 0 0 1 .6 1.3l-3.6 10" />
          </svg>
        </button>
        {onToggle && <CollapseButton cells={3} index={1} shown label="Hide Elfoqsy and her agents" disabled={lastOpen} onClick={onToggle} />}
      </div>
      <DelegationSheet state={state} layer={sheet} />
      <div className="elf-portrait">
        <img src={ART[look.mood].portraits[look.variant]} alt={ART[look.mood].alt} />
        <FoxBadge mood={look.mood} size={56} />
      </div>
      <div className="elf-name">
        <span className="elf-title">Elfoqsy</span>
        <span className="elf-line">{elfoqsyLine(state)}</span>
      </div>
      <nav className="conversations" aria-label="Conversations">
        <button type="button" className="new-conversation" aria-current={selected === null} onClick={() => onSelect(null)}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
          New conversation
        </button>
        <div className="conversation-list">
          {groups.map((g) => (
            <div key={g.label} className="conversation-group">
              <span className="conversation-day">{g.label}</span>
              {g.conversations.map((c) => (
                <button key={c.conversationId} type="button" className="conversation" aria-current={selected === c.conversationId} onClick={() => onSelect(c.conversationId)}>
                  <span className="conversation-title">{c.title}</span>
                  <span className="conversation-meta">
                    {c.ticket && <b>{c.ticket}</b>}
                    <span>{conversationTime(c.lastAt, now)}</span>
                  </span>
                </button>
              ))}
            </div>
          ))}
          {earlier && (
            <div className="conversation-group">
              <span className="conversation-day">Before conversations</span>
              <button type="button" className="conversation" aria-current={selected === EARLIER} onClick={() => onSelect(EARLIER)}>
                <span className="conversation-title">Earlier messages</span>
                <span className="conversation-meta">
                  <span>{threadOf(state, EARLIER).length} messages</span>
                </span>
              </button>
            </div>
          )}
        </div>
      </nav>
      {state.usage && (
        <div className="usage">
          <span className="usage-title">Claude usage</span>
          <div className="usage-grid">
            <span>5 hours</span>
            <Meter share={state.usage.fiveHourPct / 100} tone="plain" />
            <span>{state.usage.fiveHourPct}%</span>
            <span>7 days</span>
            <Meter share={state.usage.sevenDayPct / 100} tone="plain" />
            <span>{state.usage.sevenDayPct}%</span>
          </div>
        </div>
      )}
    </div>
  );
}
