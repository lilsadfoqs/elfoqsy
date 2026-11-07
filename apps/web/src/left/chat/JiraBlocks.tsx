// Jira in the conversation. A drafted ticket (right): Elfoqsy or an agent drafted it; it waits for
// alex with "Create in Jira", "Edit first" and "Discard", and only his press creates it. Jira news :
// what others did on his tickets, and where they mentioned him, while he was away.
import { useEffect, useMemo, useState } from 'react';
import { fieldIdsOf, initials, jiraTime, type WorkspaceState } from '@elfoqsy/state';
import { stream } from '../../state/workspace';
import { TypeIcon } from '../../ui/TicketBits';
import { createFields, extraRequired, formFromDraft, linkWords, typeIdOf } from '../sprint/createForm';
import { shortSprint, typeOfName } from '../sprint/find';
import type { BlockActions } from './Blocks';

const hhmm = (ms: number): string => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const newCreateId = (): string => `create-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export function DraftBlock({ state, draftId, actions }: { state: WorkspaceState; draftId: string; actions: BlockActions }) {
  const entry = state.drafts[draftId];
  const [createId, setCreateId] = useState<string | null>(null);
  const ids = useMemo(() => fieldIdsOf(state.jiraFields), [state.jiraFields]);
  const d = entry?.draft;
  const meta = d ? state.createMeta[d.project] : undefined;
  const typeId = d && meta ? typeIdOf(meta.types, d.type) : '';
  const screen = typeId ? meta?.fields[typeId] : undefined;
  const open = !!entry && !entry.closed;
  const outcome = createId ? state.created[createId] : undefined;
  const pending = !!createId && !outcome;

  // To create it as it is, the project's types and that type's create screen are needed.
  useEffect(() => {
    if (open && d && !meta) stream.jiraCreatemeta(d.project);
  }, [open, !!meta]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (open && d && typeId && !screen) stream.jiraCreatemeta(d.project, typeId);
  }, [open, typeId, !!screen]); // eslint-disable-line react-hooks/exhaustive-deps
  // Created: the new ticket opens in the sprint column.
  useEffect(() => {
    if (outcome?.key) actions.openTicket(outcome.key);
  }, [outcome?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!entry || !d) return <div className="block block--missing">That draft is not in the workspace any more.</div>;
  const types = state.jiraOptions[d.project]?.linkTypes ?? [];
  // What Jira's screen requires beyond the draft: it is edited first, never sent half-filled.
  const needs = extraRequired(screen, ids).map((f) => f.name);
  const create = () => {
    if (!typeId || !screen || needs.length || stream.tester) return;
    const id = newCreateId();
    const form = { ...formFromDraft(d), typeId };
    if (stream.jiraCreate({ createId: id, project: d.project, typeId, fields: createFields(form, ids, screen), ...(d.links?.length ? { links: d.links } : {}), draftId })) setCreateId(id);
  };
  const chips = [
    d.priority,
    d.storyPoints !== undefined ? `${d.storyPoints} pt` : undefined,
    d.sprint ? shortSprint(d.sprint.name) : undefined,
    ...(d.links ?? []).map((l) => `${linkWords(types, l)} ${l.other}`),
    d.parent ? `parent ${d.parent}` : undefined,
    ...(d.labels ?? []),
  ].filter((c): c is string => !!c);

  return (
    <div className="block draft">
      <div className="draft-head">
        <TypeIcon type={typeOfName(d.type)} size={18} />
        <span>
          New {d.type} · {d.project}
        </span>
        {open && (
          <span className="draft-wait">
            <span className="dot dot--needs-you" aria-hidden="true" />
            waiting for you
          </span>
        )}
      </div>
      <b className="draft-title">{d.summary}</b>
      {chips.length > 0 && (
        <div className="draft-chips">
          {chips.map((c) => (
            <span key={c} className="tag-outline">
              {c}
            </span>
          ))}
        </div>
      )}
      {entry.closed ? (
        <p className="draft-closed">
          {entry.closed.how === 'created' && entry.closed.key ? (
            <>
              Created as{' '}
              <button type="button" className="news-key" onClick={() => actions.openTicket(entry.closed!.key!)}>
                {entry.closed.key}
              </button>
            </>
          ) : (
            'Discarded'
          )}
        </p>
      ) : (
        <>
          <div className="draft-actions">
            <button type="button" className="button-solid" disabled={!screen || needs.length > 0 || pending || stream.tester} onClick={create}>
              {pending ? 'Creating…' : 'Create in Jira'}
            </button>
            <button type="button" className="button-outline" disabled={pending || stream.tester} onClick={() => actions.editDraft(draftId)}>
              Edit first
            </button>
            <button type="button" className="button-outline" disabled={pending || stream.tester} onClick={() => stream.discardDraft(draftId)}>
              Discard
            </button>
          </div>
          {outcome?.error ? (
            <p className="draft-note">
              <span className="ed-error">Jira refused it: {outcome.error}</span>
            </p>
          ) : needs.length > 0 ? (
            <p className="draft-note">Jira also needs {needs.join(', ')}: edit it first.</p>
          ) : stream.tester ? (
            <p className="draft-note">Only alex creates tickets.</p>
          ) : null}
        </>
      )}
    </div>
  );
}

export function JiraNewsBlock({ state, newsId, actions }: { state: WorkspaceState; newsId: string; actions: BlockActions }) {
  const n = state.jiraNews[newsId];
  if (!n) return <div className="block block--missing">That Jira news is not in the workspace any more.</div>;
  return (
    <div className="block digest">
      <div className="digest-head">
        <b>In Jira since {hhmm(Date.parse(n.since))}</b>
        <span className="digest-note">your tickets and mentions</span>
      </div>
      <ul className="decision-list">
        {n.items.map((i, k) => (
          <li key={k} className="news-row">
            <span className="person-initials" aria-hidden="true">
              {initials(i.who)}
            </span>
            <span className="news-text">
              <b>{i.who}</b> {i.what}{' '}
              <button type="button" className="news-key" onClick={() => actions.openTicket(i.key)}>
                {i.key}
              </button>
            </span>
            <span className="news-time">{hhmm(jiraTime(i.at))}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
