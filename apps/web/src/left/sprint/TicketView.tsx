// A ticket in the sprint column (screenshots 20 to 22): everything Jira shows for it, read in full by the
// daemon. The top row stays as it was (the dial on the left; on the right Parent, the type and key, chips for workflow
// status, priority, points and "Blocked by N", the title, created and updated); everything under it scrolls: the filled
// fields in two columns with the empty ones folded, the rich text, Other fields, Sub-tasks, Linked work items,
// Confluence, Development, Attachments, Comments and History. Any ticket opens here by key, in the sprint or not.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Ticket } from '@elfoqsy/contracts';
import {
  agentLabel,
  blockedBy,
  carriedOver,
  categoryOf,
  currentSprint,
  detailLayout,
  fieldIdsOf,
  historyGroups,
  lineDiff,
  type HistoryChange,
  initials,
  isEmptyValue,
  isRichText,
  jiraDate,
  jiraTime,
  linkGroups,
  narrativeRun,
  prKey,
  statusToken,
  ticketTypeOf,
  valueText,
  type JiraFieldIds,
  type LinkedItem,
  type TicketDetailView,
  type WorkspaceState,
} from '@elfoqsy/state';
import { stream } from '../../state/workspace';
import { Adf, ConfluenceChip, TicketLink, type AdfContext } from '../../ui/Adf';
import { FileIcon, StateIcon } from '../../ui/Icons';
import { AgentBadge, TypeIcon } from '../../ui/TicketBits';
import { jiraUrl } from '../../ui/ticket';
import { agentOn, sizeLabel, ticketOrder } from '../model';
import { Dial, keyDigits } from './OrbitMap';
import { PrLine } from './PrLine';
import { AgentWork, type SprintView } from './SprintColumn';
import { NarrativeView, type NarrativeScroll } from './Narrative';
import { CommentsEditor, FactField, LinkForm, RichField, StatusMenu, TitleField, UnlinkButton } from './TicketEditors';

/** The open ticket is read again by the daemon about every 10 seconds while this is renewed. */
const WATCH_RENEW_MS = 20_000;

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** A workflow status as Jira names it, coloured by its category. */
export function WorkflowChip({ name, category }: { name: string; category: 'new' | 'indeterminate' | 'done' }) {
  return (
    <span className="chip-status" style={{ background: `var(${statusToken(name, category)})` }}>
      {name}
    </span>
  );
}

const PRIORITY_LEVEL: Record<string, 'Blocker' | 'Critical' | 'Major' | 'Minor'> = { blocker: 'Blocker', highest: 'Blocker', critical: 'Critical', high: 'Critical', major: 'Major', medium: 'Major' };
const PRIORITY_PATH = {
  Blocker: 'M8 12h8M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17',
  Critical: 'm6 13 6-6 6 6M6 19l6-6 6 6',
  Major: 'm6 15 6-6 6 6',
  Minor: 'm6 9 6 6 6-6',
} as const;

/** Jira's priority icon, by its own name (Blocker, Major, Highest…). */
export function PriorityIcon({ name, size = 18 }: { name: string; size?: number }) {
  const level = PRIORITY_LEVEL[name.toLowerCase()] ?? 'Minor';
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={`priority priority--${level}`} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" role="img" aria-label={name || 'No priority'}>
      <path d={PRIORITY_PATH[level]} />
    </svg>
  );
}

function PersonBadge({ name }: { name: string }) {
  return (
    <span className="person-initials" data-tip={name} aria-label={name}>
      {initials(name)}
    </span>
  );
}

/** The ticket's key-bearing projects, so plain-text keys of theirs become links. */
function projectsOf(state: WorkspaceState, d: TicketDetailView | undefined, key: string): Set<string> {
  const keys = [key, ...Object.keys(state.tickets), ...JSON.stringify([d?.fields.issuelinks ?? [], d?.fields.subtasks ?? [], d?.fields.parent ?? null]).match(/[A-Z][A-Z0-9]+-\d+/g) ?? []];
  return new Set(keys.map((k) => k.split('-')[0]!));
}

export function TicketView({ state, ticketKey, jiraSite, onView, onFind, scrollTo }: { state: WorkspaceState; ticketKey: string; jiraSite: string; onView: (v: SprintView) => void; onFind: () => void; scrollTo?: NarrativeScroll }) {
  const ticket = state.tickets[ticketKey];
  const detail = state.ticketDetails[ticketKey];
  const unreadable = state.unreadable[ticketKey];
  const ids = useMemo(() => fieldIdsOf(state.jiraFields), [state.jiraFields]);

  // While it is open, the daemon reads it from Jira (at once, then about every 10 seconds).
  useEffect(() => {
    stream.watchTicket(ticketKey);
    const id = setInterval(() => stream.watchTicket(ticketKey), WATCH_RENEW_MS);
    return () => clearInterval(id);
  }, [ticketKey]);

  const order = ticketOrder(state);
  const i = order.findIndex((x) => x.key === ticketKey);
  // Where each arrow (and arrow key) goes: the arrows name it.
  const target = (step: number) => {
    const from = i < 0 ? (step > 0 ? -1 : 0) : i;
    return order[(from + step + order.length) % order.length]?.key;
  };
  const go = (step: number) => {
    const next = target(step);
    if (next) onView({ kind: 'ticket', key: next });
  };
  const [prev, next] = [target(-1), target(1)];
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && e.target.closest('input, textarea, [contenteditable="true"]') !== null;
      if (typing || e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === 'ArrowRight') go(1);
      else if (e.key === 'Escape') onView({ kind: 'map' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const ctx: AdfContext = {
    site: jiraSite,
    openTicket: (key) => onView({ kind: 'ticket', key }),
    confluence: detail?.confluence ?? {},
    attachments: (Array.isArray(detail?.fields.attachment) ? (detail!.fields.attachment as Array<Record<string, unknown>>) : []).map((a) => ({
      id: String(a.id),
      filename: str(a.filename) ?? 'file',
      ...(str(a.mimeType) ? { mimeType: str(a.mimeType)! } : {}),
      ...(typeof a.size === 'number' ? { size: a.size } : {}),
    })),
    projects: projectsOf(state, detail, ticketKey),
  };

  return (
    <div className="ticket-view">
      <div className="tv-top">
        <div className="tv-dial">
          <Dial
            state={state}
            selected={ticketKey}
            onSelect={(key) => onView({ kind: 'ticket', key })}
            controls={(tip) => (
              <>
                <button
                  type="button"
                  className="icon-button tv-expand"
                  aria-label="Back to the full sprint map"
                  onClick={() => onView({ kind: 'map' })}
                  {...tip('expand', () => <span className="tip-title">Full sprint map</span>, 'left')}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
                  </svg>
                </button>
                {/* The shortcut shows on hover only, in the dial's tooltip. */}
                <button
                  type="button"
                  className="icon-button tv-find"
                  aria-label="Find a ticket (Ctrl K)"
                  onClick={onFind}
                  {...tip(
                    'find',
                    () => (
                      <span className="tip-title">
                        Find a ticket <kbd>Ctrl K</kbd>
                      </span>
                    ),
                    'left',
                  )}
                >
                  <FindGlyph />
                </button>
              </>
            )}
          />
          <div className="tv-nav">
            <span className="tv-nav-key tv-nav-key--prev" aria-hidden="true">
              {prev && prev !== ticketKey ? keyDigits(prev) : ''}
            </span>
            <button type="button" className="icon-button icon-button--40" aria-label={prev ? `Previous ticket, ${prev}` : 'Previous ticket'} onClick={() => go(-1)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m15 6-6 6 6 6" />
              </svg>
            </button>
            <span className="tv-count">{i >= 0 ? `${i + 1} of ${order.length}` : 'not in sprint'}</span>
            <button type="button" className="icon-button icon-button--40" aria-label={next ? `Next ticket, ${next}` : 'Next ticket'} onClick={() => go(1)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m9 6 6 6-6 6" />
              </svg>
            </button>
            <span className="tv-nav-key" aria-hidden="true">
              {next && next !== ticketKey ? keyDigits(next) : ''}
            </span>
          </div>
        </div>
        <TicketHead state={state} ticketKey={ticketKey} ticket={ticket} detail={detail} ids={ids} jiraSite={jiraSite} ctx={ctx} />
      </div>
      <div className="tv-body">
        <CreatedCheck state={state} ticketKey={ticketKey} />
        {!detail && !ticket ? (
          <p className="tv-reading">{unreadable ? unreadable.reason : `Reading ${ticketKey} from Jira…`}</p>
        ) : (
          <TicketBody state={state} ticketKey={ticketKey} ticket={ticket} detail={detail} ids={ids} ctx={ctx} unreadable={unreadable?.reason} {...(scrollTo ? { scrollTo } : {})} />
        )}
      </div>
    </div>
  );
}

function TicketHead({ state, ticketKey, ticket, detail, ids, jiraSite, ctx }: { state: WorkspaceState; ticketKey: string; ticket?: Ticket; detail?: TicketDetailView; ids: JiraFieldIds; jiraSite: string; ctx: AdfContext }) {
  const f = detail?.fields ?? {};
  const status = obj(f.status);
  const statusName = str(status.name) ?? ticket?.workflowStatus?.name ?? ticket?.status;
  const category = str(status.name) ? categoryOf(status) : (ticket?.workflowStatus?.category ?? 'new');
  const priority = str(obj(f.priority).name) ?? ticket?.priority;
  const pointsRaw = detail ? f[ids.storyPoints] : ticket?.storyPoints;
  const points = typeof pointsRaw === 'number' ? pointsRaw : null;
  const parent = obj(f.parent);
  const parentKey = str(parent.key);
  const blocked = detail ? blockedBy(detail) : 0;
  const flagged = !isEmptyValue(f[ids.flagged]);
  const summary = str(f.summary) ?? ticket?.summary ?? '';
  const type = detail ? ticketTypeOf(f.issuetype) : ticket?.type;
  const creator = valueText(f.creator) || valueText(f.reporter) || ticket?.reporter;
  const created = str(f.created) ? jiraDate(str(f.created)) : ticket?.created;
  const updated = str(f.updated) ? jiraDate(str(f.updated)) : ticket?.updated;
  return (
    <div className="tv-head">
      {parentKey && (
        <div className="tv-parent">
          Parent <TicketLink ticketKey={parentKey} ctx={ctx} /> <span className="tv-parent-name">{str(obj(parent.fields).summary)?.replace(/^\[[^\]]+\]\s*/, '')}</span>
        </div>
      )}
      <div className="tv-key">
        {type && <TypeIcon type={type} />}
        <a href={jiraUrl(jiraSite, ticketKey)} target="_blank" rel="noreferrer noopener">
          {ticketKey}
        </a>
      </div>
      {statusName && (
        <div className="tv-chips">
          {detail ? <StatusMenu state={state} d={detail} ids={ids} name={statusName} category={category} /> : <WorkflowChip name={statusName} category={category} />}
          {priority && (
            <span className="chip-soft">
              <PriorityIcon name={priority} />
              {priority}
            </span>
          )}
          <span className="chip-soft chip-soft--round">{points === null ? 'not estimated' : `${points} pt`}</span>
          {blocked > 0 && (
            <span className="chip-soft chip-soft--round chip-soft--dot">
              <span className="dot dot--blocked" aria-hidden="true" />
              Blocked by {blocked}
            </span>
          )}
          {flagged && <span className="chip-soft chip-soft--round">Flagged</span>}
        </div>
      )}
      {summary && (
        <h2 className="tv-title">
          {detail ? (
            <TitleField state={state} d={detail}>
              {summary}
            </TitleField>
          ) : (
            summary
          )}
        </h2>
      )}
      {created && (
        <span className="tv-dates">
          Created {created}
          {creator ? ` by ${creator}` : ''}
          {updated ? ` · Updated ${updated}` : ''}
        </span>
      )}
    </div>
  );
}

/** A field's value as the view shows it: people, labels as chips, the sprint with its goal, rich text, dates. */
function FieldValue({ d, id, ids, ctx }: { d: TicketDetailView; id: string; ids: JiraFieldIds; ctx: AdfContext }) {
  const v = d.fields[id];
  const schema = d.schema[id];
  if (id === ids.sprint) {
    const s = currentSprint(v);
    return s ? (
      <span>
        {s.name}
        {s.goal && <span className="tv-sub">{s.goal}</span>}
      </span>
    ) : null;
  }
  if (id === 'labels' && Array.isArray(v)) {
    return (
      <span className="tv-chiplist">
        {v.map((l) => (
          <span key={String(l)} className="label-chip">
            {String(l)}
          </span>
        ))}
      </span>
    );
  }
  if (isRichText(schema, v)) return <Adf doc={v} ctx={ctx} className="tv-rich" />;
  return <span>{valueText(v, schema)}</span>;
}

function Section({ title, children, count }: { title: string; children: ReactNode; count?: number }) {
  return (
    <section className="tv-section">
      <h3>
        {title}
        {count !== undefined && <span className="tv-count-muted">{count}</span>}
      </h3>
      {children}
    </section>
  );
}

/** A linked item or sub-task: key, title, workflow status, priority and assignee in fixed columns. */
function IssueRow({ item, ctx, remove }: { item: LinkedItem; ctx: AdfContext; remove?: ReactNode }) {
  return (
    <div className="issue-row">
      <TicketLink ticketKey={item.key} ctx={ctx} />
      <span className="issue-row-title" data-tip={item.summary}>
        {item.summary}
      </span>
      <span className="issue-row-status">
        <WorkflowChip name={item.status} category={item.category} />
      </span>
      <PriorityIcon name={item.priority} />
      {item.assignee ? <PersonBadge name={item.assignee} /> : <span className="person-initials person-initials--none" aria-label="Unassigned" data-tip="Unassigned" />}
      <span className="issue-row-x">{remove}</span>
    </div>
  );
}

const subtaskItems = (d: TicketDetailView): LinkedItem[] =>
  (Array.isArray(d.fields.subtasks) ? (d.fields.subtasks as Array<Record<string, unknown>>) : []).map((s) => {
    const f = obj(s.fields);
    return {
      key: str(s.key) ?? '',
      summary: str(f.summary) ?? '',
      status: str(obj(f.status).name) ?? '',
      category: categoryOf(f.status),
      priority: str(obj(f.priority).name) ?? '',
      type: str(obj(f.issuetype).name) ?? '',
      ...(str(obj(f.assignee).displayName) ? { assignee: str(obj(f.assignee).displayName)! } : {}),
    };
  });

/** "a moment ago", "5 min ago", "3 h ago", or the date. */
function since(at: number, now: number): string {
  const s = Math.max(0, (now - at) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return jiraDate(new Date(at).toISOString());
}

function TicketBody({ state, ticketKey, ticket, detail, ids, ctx, unreadable, scrollTo }: { state: WorkspaceState; ticketKey: string; ticket?: Ticket; detail?: TicketDetailView; ids: JiraFieldIds; ctx: AdfContext; unreadable?: string; scrollTo?: NarrativeScroll }) {
  const run = agentOn(state, ticketKey);
  // "What we know" (N1): written from the reports of the ticket's latest agent, while it works and after.
  const told = narrativeRun(state, ticketKey);
  const narrative = told ? <NarrativeView state={state} runId={told.runId} {...(scrollTo ? { scrollTo } : {})} /> : null;
  const carried = ticket ? carriedOver(ticket) : 0;
  const prs = Object.values(state.prs)
    .filter((p) => p.ticket === ticketKey)
    .sort((a, b) => Number(b.state === 'open' || b.state === 'draft') - Number(a.state === 'open' || a.state === 'draft') || b.number - a.number);
  if (!detail) {
    // The sprint's own copy until Jira's full one arrives.
    return (
      <>
        {run && <AgentWork state={state} run={run} />}
        {narrative}
        <p className="tv-reading">{unreadable ?? `Reading ${ticketKey} from Jira…`}</p>
        {ticket?.description && <p className="tv-plain">{ticket.description}</p>}
      </>
    );
  }
  const layout = detailLayout(detail, ids);
  const groups = linkGroups(detail);
  const subtasks = subtaskItems(detail);
  const pages = detail.remoteLinks.filter((l) => /confluence/i.test(l.application ?? ''));
  const files = ctx.attachments;
  const now = stream.now();
  const changed = (id: string) => detail.changes.find((c) => c.fieldId === id && now - c.seenAt < 8000);
  return (
    <>
      {run && <AgentWork state={state} run={run} />}
      {narrative}
      <div className="tv-fields">
        {layout.facts.map((f) =>
          changed(f.id) ? (
            <Fact key={f.id} name={f.name} change={changed(f.id)}>
              <FieldValue d={detail} id={f.id} ids={ids} ctx={ctx} />
            </Fact>
          ) : (
            <FactField key={f.id} state={state} d={detail} id={f.id} name={f.name} ids={ids} site={ctx.site}>
              <FieldValue d={detail} id={f.id} ids={ids} ctx={ctx} />
            </FactField>
          ),
        )}
        {carried > 0 && (
          <Fact name="Carried over">
            <span className="fact-warning">{carried === 1 ? '1 sprint' : `${carried} sprints`}</span>
          </Fact>
        )}
      </div>
      {layout.emptyFacts.length > 0 && (
        <details className="tv-empty">
          <summary>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m9 6 6 6-6 6" />
            </svg>
            {layout.emptyFacts.length} empty field{layout.emptyFacts.length === 1 ? '' : 's'}
          </summary>
          <div className="tv-fields">
            {layout.emptyFacts.map((f) => (
              <FactField key={f.id} state={state} d={detail} id={f.id} name={f.name} ids={ids} site={ctx.site}>
                <span className="tv-none">None</span>
              </FactField>
            ))}
          </div>
        </details>
      )}
      {layout.rich.map((r) => {
        const v = detail.fields[r.id];
        const isDesign = r.role === 'design' && !isRichText(detail.schema[r.id], v);
        return (
          <Section key={r.id} title={r.name}>
            {changed(r.id) && <ChangeMark change={changed(r.id)!} />}
            {isDesign ? (
              isEmptyValue(v) ? <div className="tv-add tv-add--locked">No design linked</div> : <p className="tv-plain">{valueText(v, detail.schema[r.id])}</p>
            ) : isRichText(detail.schema[r.id], v) || isEmptyValue(v) ? (
              <RichField state={state} d={detail} id={r.id} label={r.name} ctx={ctx} site={ctx.site} />
            ) : (
              <p className="tv-plain">{valueText(v, detail.schema[r.id])}</p>
            )}
          </Section>
        );
      })}
      {layout.other.length > 0 && (
        <Section title="Other fields">
          <div className="tv-fields tv-fields--wide">
            {layout.other.map((o) => (
              <FactField key={o.id} state={state} d={detail} id={o.id} name={o.name} ids={ids} site={ctx.site}>
                <FieldValue d={detail} id={o.id} ids={ids} ctx={ctx} />
              </FactField>
            ))}
          </div>
        </Section>
      )}
      {subtasks.length > 0 && (
        <Section title="Sub-tasks" count={subtasks.length}>
          <div className="issue-rows">
            {subtasks.map((s) => (
              <IssueRow key={s.key} item={s} ctx={ctx} />
            ))}
          </div>
        </Section>
      )}
      <Links state={state} d={detail} groups={groups} ctx={ctx} />
      {pages.length > 0 && (
        <Section title="Confluence">
          {pages.map((p) => (
            <div key={p.id} className="tv-page">
              <ConfluenceChip url={p.url} title={p.title || p.url} />
              <span className="tv-muted">{p.relationship === 'mentioned in' ? 'mentions this ticket' : (p.relationship ?? 'linked')}</span>
            </div>
          ))}
        </Section>
      )}
      <Section title="Development">
        {prs.length || run ? (
          <div className="tv-prs">
            {run && (
              <span className="tv-branch">
                <AgentBadge run={run} size={22} />
                <StateIcon name="branch" />
                <code>{run.branch}</code>
                <span className="tv-muted">{agentLabel(run.model, run.effort)}</span>
              </span>
            )}
            {prs.map((pr) => (
              <PrLine key={prKey(pr)} state={state} pr={pr} onDismiss={() => stream.dismissCi(pr.repo, pr.number)} />
            ))}
          </div>
        ) : (
          <p className="tv-muted">No branches or pull requests on GitHub.</p>
        )}
      </Section>
      {files.length > 0 && (
        <Section title="Attachments" count={files.length}>
          <div className="tv-files">
            {files.map((a) =>
              /^image\//.test(a.mimeType ?? '') ? (
                <a key={a.id} className="tv-image" href={`/jira/attachments/${a.id}`} target="_blank" rel="noreferrer noopener" data-tip={a.filename}>
                  <img src={`/jira/attachments/${a.id}`} alt={a.filename} loading="lazy" />
                </a>
              ) : (
                <div key={a.id} className="tv-file">
                  <FileIcon filename={a.filename} {...(a.mimeType ? { mimeType: a.mimeType } : {})} />
                  <span className="tv-file-name">{a.filename}</span>
                  <span className="tv-muted">{a.size !== undefined ? sizeLabel(a.size) : ''}</span>
                  <a className="button-outline button-outline--small" href={`/jira/attachments/${a.id}`}>
                    Open
                  </a>
                </div>
              ),
            )}
          </div>
        </Section>
      )}
      <Section title="Comments" count={detail.comments.length}>
        <CommentsEditor state={state} d={detail} ctx={ctx} />
      </Section>
      <History detail={detail} ids={ids} now={now} />
    </>
  );
}

/** Linked work items, with "+ Link" and a remove on each row. */
function Links({ state, d, groups, ctx }: { state: WorkspaceState; d: TicketDetailView; groups: ReturnType<typeof linkGroups>; ctx: AdfContext }) {
  const [adding, setAdding] = useState(false);
  const can = (d.editmeta.issuelinks?.operations ?? []).includes('add');
  if (!groups.length && !can) return null;
  return (
    <Section title="Linked work items">
      {groups.length > 0 && (
        <div className="issue-rows">
          {groups.map((g) => (
            <div key={g.relation} className="issue-group">
              <span className="issue-group-name">{g.relation}</span>
              {g.items.map((item) => (
                <IssueRow key={`${g.relation}-${item.key}`} item={item} ctx={ctx} {...(can && item.linkId ? { remove: <UnlinkButton state={state} d={d} linkId={item.linkId} label={item.key} /> } : {})} />
              ))}
            </div>
          ))}
        </div>
      )}
      {can &&
        (adding ? (
          <LinkForm state={state} d={d} onClose={() => setAdding(false)} />
        ) : (
          <button type="button" className="tv-add tv-add--small" onClick={() => setAdding(true)}>
            + Link
          </button>
        ))}
    </Section>
  );
}

/** The magnifier of "Find a ticket". */
export function FindGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-4-4" />
    </svg>
  );
}

const CHECK_WORDS = { links: 'its links', sprint: 'its sprint', parent: 'its parent' } as const;

/** A ticket he just created: what Jira did not keep of what he set, read back after creating it. */
function CreatedCheck({ state, ticketKey }: { state: WorkspaceState; ticketKey: string }) {
  const c = Object.values(state.created).find((x) => x.key === ticketKey);
  const missed = Object.entries(c?.checks ?? {}).flatMap(([k, ok]) => (ok ? [] : [CHECK_WORDS[k as keyof typeof CHECK_WORDS]]));
  if (!missed.length) return null;
  return <p className="tv-created-warn">Created, but Jira did not keep {missed.join(' or ')}. Set {missed.length === 1 ? 'it' : 'them'} below.</p>;
}

/**
 * History: one line, "History · N changes", until he opens it. Then the changes by people, newest first, a
 * person's changes on one day together; Rank and the automation's are left out, and a long text's change is named,
 * with its diff on request.
 */
function History({ detail, ids, now }: { detail: TicketDetailView; ids: JiraFieldIds; now: number }) {
  const groups = useMemo(() => historyGroups(detail.history, detail, ids), [detail, ids]);
  const count = groups.reduce((n, g) => n + g.changes.length, 0);
  if (!count) return null;
  return (
    <details className="tv-section tv-history-box">
      <summary>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m9 6 6 6-6 6" />
        </svg>
        <h3>
          History <span className="tv-count-muted">· {count} change{count === 1 ? '' : 's'}</span>
        </h3>
      </summary>
      <ol className="tv-history">
        {groups.slice(0, 40).map((g) => (
          <li key={g.id} className="tv-history-group">
            <span className="tv-history-who">
              <b>{g.by}</b>
              <span className="tv-muted"> · {since(jiraTime(g.at), now)}</span>
            </span>
            <ul>
              {g.changes.map((c, n) => (
                <HistoryLine key={n} change={c} />
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </details>
  );
}

function HistoryLine({ change: c }: { change: HistoryChange }) {
  const [diff, setDiff] = useState(false);
  if (c.long) {
    return (
      <li>
        {c.from && c.to ? 'changed' : c.to ? 'wrote' : 'cleared'} {c.field}{' '}
        {c.from || c.to ? (
          <button type="button" className="link-button" aria-expanded={diff} onClick={() => setDiff(!diff)}>
            {diff ? 'Hide diff' : 'Show diff'}
          </button>
        ) : null}
        {diff && (
          <div className="diff diff--plain tv-history-diff">
            {lineDiff(c.from, c.to).map((r, i) => (
              <div key={i} className={`diff-row${r.sign === '+' ? ' diff-row--add' : r.sign === '-' ? ' diff-row--del' : ''}`}>
                <span className="diff-sign">{r.sign === '-' ? '−' : r.sign === '+' ? '+' : r.sign === '…' ? '…' : ''}</span>
                <span className="diff-text">{r.text}</span>
              </div>
            ))}
          </div>
        )}
      </li>
    );
  }
  // "changed Priority from Major to Blocker", "set Story point estimate to 8", "cleared Assignee (was Quinn Bauer)";
  // links and attachments are added or removed.
  const value = (v: string) => <span className="tv-history-value">{v}</span>;
  if (c.field === 'Linked work item' || c.field === 'Attachment' || c.field === 'Remote link') {
    return <li>{c.to ? <>added {c.field === 'Attachment' ? 'an attachment' : 'a link'}: {value(c.to)}</> : <>removed {c.field === 'Attachment' ? 'an attachment' : 'a link'}: {value(c.from)}</>}</li>;
  }
  return (
    <li>
      {c.from && c.to ? (
        <>
          changed {c.field} from {value(c.from)} to {value(c.to)}
        </>
      ) : c.to ? (
        <>
          set {c.field} to {value(c.to)}
        </>
      ) : (
        <>
          cleared {c.field}
          {c.from ? <> (was {value(c.from)})</> : null}
        </>
      )}
    </li>
  );
}

function ChangeMark({ change }: { change: { by: string; at: string } }) {
  return (
    <span className="change-mark">
      {change.by}, {jiraDate(change.at, true).split(', ')[1] ?? ''}
    </span>
  );
}

function Fact({ name, children, change }: { name: string; children: ReactNode; change?: { by: string; at: string } }) {
  return (
    <>
      <span className="tv-label">{name}</span>
      <span className={`tv-value${change ? ' tv-value--changed' : ''}`}>
        {children}
        {change && <ChangeMark change={change} />}
      </span>
    </>
  );
}
