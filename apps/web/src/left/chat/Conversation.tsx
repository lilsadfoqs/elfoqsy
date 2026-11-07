// The conversation column: its title, the thread, and the composer. His messages sit on the right in a
// bubble with "You, 14:15" (the tester's say so); each turn of Elfoqsy's opens with her avatar (always
// the same: it is who she is, not how she is), name and time, then her short text and her blocks. Hidden, it is a rail with a yellow dot when
// something waits for him.
import { useEffect, useRef } from 'react';
import type { ActivityView, MessageView, WorkspaceState } from '@elfoqsy/state';
import { pendingApprovals } from '@elfoqsy/state';
import { CollapseButton } from '../../ui/CollapseButton';
import { Markdown } from '../../ui/Markdown';
import { ART, AVATAR } from '../../ui/elfoqsy';
import { ToolTile } from '../../ui/ToolTile';
import { activityTile } from '../../ui/toolIcons';
import { useNow } from '../../ui/useNow';
import { stream } from '../../state/workspace';
import { EARLIER, messageTime, sizeLabel, thinkingOf, threadOf } from '../model';
import { ApprovalBatch, Block, type BlockActions } from './Blocks';
import { Composer } from './Composer';

interface Props {
  state: WorkspaceState;
  /** The open conversation, EARLIER, or null for a new one. */
  conversationId: string | null;
  actions: BlockActions;
  onSent: () => void;
  open: boolean;
  lastOpen: boolean;
  /** Today's column hides to a rail; a pane in a layout of its own does not (P2), and has no button for it. */
  onToggle?: () => void;
}

const WHO = { you: 'You', test: 'The tester' } as const;

/** Changes when her activity changes, so the thread scrolls to the indicator's newest line. */
const thinkingKey = (s: WorkspaceState, messages: MessageView[]): number => {
  const id = messages.at(-1)?.conversationId;
  return id ? (s.activities[id]?.length ?? 0) : 0;
};

export function Conversation({ state, conversationId, actions, onSent, open, lastOpen, onToggle }: Props) {
  if (!open) {
    const waiting = pendingApprovals(state).length;
    return (
      <div className="chat chat--rail" aria-label="Conversation, hidden">
        {onToggle && <CollapseButton cells={3} index={2} shown={false} label="Show the conversation" onClick={onToggle} />}
        <span className="chat-rail-icon" aria-label={waiting ? `Conversation, ${waiting} waiting for you` : 'Conversation'}>
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 5h16v11H9l-5 4z" />
          </svg>
          {waiting > 0 && <span className="chat-rail-dot" />}
        </span>
      </div>
    );
  }
  const conversation = conversationId && conversationId !== EARLIER ? state.conversations[conversationId] : undefined;
  const title = conversation?.title ?? (conversationId === EARLIER ? 'Earlier messages' : 'New conversation');
  const messages = conversationId ? threadOf(state, conversationId) : [];
  return (
    <div className="chat" aria-label="Conversation">
      <div className="chat-head">
        <span className="chat-title">{title}</span>
        {onToggle && <CollapseButton cells={3} index={2} shown label="Hide the conversation" disabled={lastOpen} onClick={onToggle} />}
      </div>
      <Thread state={state} messages={messages} actions={actions} empty={!conversationId} />
      <Composer conversationId={conversation?.conversationId} onSent={onSent} />
    </div>
  );
}

/** A message of hers that is only a notice of abilities: their cards, and her line. */
const isNotice = (m: MessageView): boolean => m.blocks.length > 0 && m.blocks.every((b) => b.type === 'ability');

function Thread({ state, messages, actions, empty }: { state: WorkspaceState; messages: MessageView[]; actions: BlockActions; empty: boolean }) {
  const el = useRef<HTMLDivElement>(null);
  const last = messages.at(-1)?.messageId;
  useEffect(() => {
    if (el.current) el.current.scrollTop = el.current.scrollHeight;
  }, [last, messages.length, thinkingKey(state, messages)]);
  const now = stream.now();
  const conversationId = messages.at(-1)?.conversationId;
  const thinking = conversationId ? thinkingOf(state, conversationId, messages, now) : null;
  return (
    <div className="thread" role="log" aria-label="Conversation with Elfoqsy" ref={el}>
      <div className="thread-inner">
        {empty && <p className="thread-empty">A new conversation starts clean; Elfoqsy still knows the sprint, her agents and what she remembers.</p>}
        {messages.map((m, i) => {
          const hers = m.role === 'elfoqsy';
          if (!hers) {
            return (
              <div key={m.messageId} className="mine">
                <span className="mine-label">
                  {WHO[m.role as keyof typeof WHO]}, {messageTime(m.at, now)}
                </span>
                <div className="bubble">{m.text}</div>
                {m.attachments.length > 0 && (
                  <div className="mine-attachments">
                    {m.attachments.map((a) =>
                      a.mediaType.startsWith('image/') ? (
                        <a key={a.attachmentId} href={`/attachments/${a.attachmentId}`} target="_blank" rel="noreferrer" data-tip={a.name}>
                          <img className="attachment-image" src={`/attachments/${a.attachmentId}`} alt={a.name} />
                        </a>
                      ) : (
                        <a key={a.attachmentId} className="attachment-chip" href={`/attachments/${a.attachmentId}`} data-tip={a.name}>
                          {a.name} <span>{sizeLabel(a.bytes)}</span>
                        </a>
                      ),
                    )}
                  </div>
                )}
              </div>
            );
          }
          const opensTurn = messages[i - 1]?.role !== 'elfoqsy';
          return (
            <div key={m.messageId} className="hers">
              {opensTurn && (
                <div className="hers-head">
                  <img src={AVATAR} alt="" />
                  <span className="hers-name">Elfoqsy</span>
                  <span className="hers-time">{messageTime(m.at, now)}</span>
                </div>
              )}
              {isNotice(m) ? (
                // Her notice of a new ability: its small card beside her line, opening the Abilities view on it.
                <div className={`hers-notice${m.blocks.length > 1 ? ' hers-notice--many' : ''}`}>
                  <div className="hers-notice-cards">
                    {m.blocks.map((b, j) => (
                      <Block key={j} block={b} state={state} actions={actions} />
                    ))}
                  </div>
                  {m.text && <Markdown className="hers-text" text={m.text} />}
                </div>
              ) : (
                <>
                  {m.text && <Markdown className="hers-text" text={m.text} />}
                  <ApprovalBatch state={state} blocks={m.blocks} />
                  {m.blocks.map((b, j) => (
                    <Block key={j} block={b} state={state} actions={actions} />
                  ))}
                </>
              )}
            </div>
          );
        })}
        {thinking && conversationId && <Thinking since={thinking.since} activities={thinking.activities} opensTurn={messages.at(-1)?.role !== 'elfoqsy'} />}
      </div>
    </div>
  );
}

/**
 * Her thinking indicator, under her name and avatar with the thinking fox: what she has done since the message, each
 * with a check and its tile, and what she is doing now with three dots and the seconds it has taken. It gives way to her
 * reply. The dots stay still for reduced motion.
 */
export function Thinking({ since, activities, opensTurn }: { since: number; activities: ActivityView[]; opensTurn: boolean }) {
  const now = useNow(1000);
  const current = activities.filter((a) => a.state === 'running').at(-1);
  const done = activities.filter((a) => a !== current && a.state !== 'running');
  return (
    <div className="hers">
      {opensTurn && (
        <div className="hers-head">
          <span className="hers-avatar">
            <img src={AVATAR} alt="" />
            <span className="hers-thinking-badge">
              <img src={ART.thinking.fox} alt="" />
            </span>
          </span>
          <span className="hers-name">Elfoqsy</span>
          <span className="hers-time">{messageTime(since, now)}</span>
        </div>
      )}
      <div className="thinking" role="status" aria-live="polite" aria-label="Elfoqsy is thinking">
        {done.map((a) => (
          <div key={a.activityId} className={`thinking-row thinking-row--${a.state}`}>
            {a.state === 'failed' ? (
              <svg className="thinking-mark thinking-mark--failed" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-label="failed">
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            ) : (
              <svg className="thinking-mark" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-label="done">
                <path d="m5 12 4.5 4.5L19 7" />
              </svg>
            )}
            <ToolTile name={activityTile(a.tool)} size={20} />
            <span>{a.text}</span>
          </div>
        ))}
        <div className="thinking-row thinking-row--now">
          <span className="dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          {current ? <ToolTile name={activityTile(current.tool)} size={20} /> : <ToolTile name="claude" size={20} />}
          <span>{current?.text ?? 'Thinking'}</span>
          <span className="thinking-time">{Math.max(0, Math.round((now - (current?.at ?? since)) / 1000))}s</span>
        </div>
      </div>
    </div>
  );
}
