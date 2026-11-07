// Editing a ticket in place ( and TicketEdit.dc.html). His edits go straight to Jira as frames; each
// carries the value his editor started from, so a save over someone else's newer value comes back with theirs instead
// of overwriting it. Rich text opens the WYSIWYG editor (read-only, with "Edit in Jira", when it holds what the editor
// cannot keep or what the workspace masks); other fields get an editor by their schema. After a conflict, Save asks once,
// "Replace Quinn Bauer's version?", before writing over theirs: never one click (his answer 7). The status chip offers only the
// transitions Jira returns, asking first for the fields a transition's screen requires; comments are his to write,
// edit and delete; links take a type and a ticket. Elfoqsy's edits show "Elfoqsy, 10:20" with Undo.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { JiraChange, JiraEditMeta, JiraFieldSchema, JiraTransition } from '@elfoqsy/contracts';
import { currentSprint, isEmptyValue, isRichText, jiraDate, statusToken, valueText, type JiraFieldIds, type TicketDetailView, type WorkspaceState } from '@elfoqsy/state';
import { stream } from '../../state/workspace';
import { editable } from '../../editor/adfSchema';
import { RichEditor } from '../../editor/RichEditor';
import { jiraUrl } from '../../ui/ticket';
import { Adf, type AdfContext } from '../../ui/Adf';
import { Floating, refTo, useLayer } from '../../ui/layers';
import { usePlainClick } from '../../ui/plainClick';

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const hhmm = (ms: number): string => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const newEditId = (): string => `e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** An empty editor is an empty field. */
const isEmptyDoc = (doc: { content?: Array<{ type: string; content?: unknown[] }> }): boolean => !doc.content?.length || doc.content.every((n) => n.type === 'paragraph' && !n.content?.length);

/**
 * One edit in flight and how it ended (state.jiraEdits, by its id). After a conflict, save asks first: the change
 * waits in `asking` until he presses Replace, so overwriting a teammate's edit is never one click.
 */
export function useEdit(state: WorkspaceState, key: string) {
  const [editId, setEditId] = useState<string | null>(null);
  const [asking, setAsking] = useState<JiraChange | null>(null);
  const outcome = editId ? state.jiraEdits[editId] : undefined;
  const send = (change: JiraChange): boolean => {
    const id = newEditId();
    if (!stream.jiraEdit(id, key, change)) return false;
    setEditId(id);
    setAsking(null);
    return true;
  };
  return {
    pending: !!editId && !outcome,
    outcome,
    send,
    /** His Save: sent at once, or, after someone else's change came back, asked about first. */
    save(change: JiraChange): boolean {
      if (outcome?.conflict) {
        setAsking(change);
        return true;
      }
      return send(change);
    },
    /** Whose version Save would replace, while it asks. */
    asking: asking ? (outcome?.conflict?.by ?? null) : undefined,
    replace: () => asking && send(asking),
    keepEditing: () => setAsking(null),
    clear: () => (setEditId(null), setAsking(null)),
  };
}

/** "Replace Quinn Bauer's version?" with Keep editing and Replace, while a Save after a conflict waits for his answer. */
export function ReplaceAsk({ edit }: { edit: ReturnType<typeof useEdit> }) {
  if (edit.asking === undefined) return null;
  return (
    <span className="replace-ask" role="alertdialog" aria-label="Replace their version?">
      <span className="replace-ask-text">Replace {edit.asking ? `${edit.asking}’s` : 'their'} version?</span>
      <button type="button" className="button-outline button-outline--small" onClick={edit.keepEditing}>
        Keep editing
      </button>
      <button type="button" className="button-solid button-solid--small" onClick={edit.replace}>
        Replace
      </button>
    </span>
  );
}

/** Why a field cannot be edited here, or null when it can. */
export function notEditable(d: TicketDetailView, id: string): string | null {
  if (!(d.editmeta[id]?.operations ?? []).includes('set')) return 'Not on this ticket’s edit screen';
  if (d.locked.includes(id)) return 'Holds text the workspace masks';
  const v = d.fields[id];
  if (isRichText(d.schema[id], v) && v !== undefined && !editable(v)) return 'Holds content this editor cannot keep';
  return null;
}

/** "Elfoqsy, 10:20" with Undo, beside a field she (or an agent) filled, while hers is the latest edit of it. */
export function WorkspaceMark({ state, ticketKey, fieldId }: { state: WorkspaceState; ticketKey: string; fieldId: string }) {
  const e = state.fieldEdits[ticketKey]?.[fieldId];
  if (!e || (e.by !== 'elfoqsy' && e.by !== 'agent')) return null;
  const change = e.recordId ? state.changes[e.recordId] : undefined;
  return (
    <span className="ws-mark">
      {e.by === 'elfoqsy' ? 'Elfoqsy' : 'An agent'}, {hhmm(e.at)}
      {change?.undo && !change.undone && (
        <button type="button" className="button-outline button-outline--small" onClick={() => stream.undo(e.recordId!)}>
          Undo
        </button>
      )}
    </span>
  );
}

/** A rich-text section, read or edited in place. */
export function RichField({ state, d, id, label, ctx, placeholder = 'Add text', site }: { state: WorkspaceState; d: TicketDetailView; id: string; label: string; ctx: AdfContext; placeholder?: string; site: string }) {
  const [editing, setEditing] = useState(false);
  const [base, setBase] = useState<unknown>(null);
  const [theirs, setTheirs] = useState(false);
  const edit = useEdit(state, d.key);
  const value = d.fields[id];
  const why = notEditable(d, id);
  const plain = usePlainClick(() => {
    setBase(value ?? null);
    setEditing(true);
  }, !why && !editing);
  useEffect(() => {
    if (edit.outcome?.ok) {
      setEditing(false);
      setTheirs(false);
      edit.clear();
    }
  }, [edit.outcome?.ok]); // eslint-disable-line react-hooks/exhaustive-deps
  const conflict = edit.outcome?.conflict;
  if (editing) {
    return (
      <>
        <RichEditor
          label={label}
          initial={base}
          saving={edit.pending}
          {...(conflict ? { conflict, onSeeTheirs: () => setTheirs(!theirs) } : {})}
          {...(edit.outcome?.error ? { error: edit.outcome.error } : {})}
          {...(edit.asking !== undefined ? { ask: <ReplaceAsk edit={edit} /> } : {})}
          onCancel={() => {
            setEditing(false);
            setTheirs(false);
            edit.clear();
          }}
          onSave={(doc) => {
            // After a conflict he has been told theirs: saving over it is his choice, asked once.
            const startedFrom = conflict ? conflict.theirs : base;
            edit.save({ op: 'field', fieldId: id, value: isEmptyDoc(doc) ? null : doc, base: startedFrom ?? null });
          }}
        />
        {conflict && theirs && (
          <div className="ed-theirs">
            <span className="ed-theirs-head">
              {conflict.by ?? 'Someone'}’s version{conflict.at ? `, ${jiraDate(conflict.at, true)}` : ''}
            </span>
            {isEmptyValue(conflict.theirs) ? <p className="tv-muted">Empty.</p> : <Adf doc={conflict.theirs} ctx={ctx} className="tv-rich" />}
            <button
              type="button"
              className="button-outline button-outline--small"
              onClick={() => {
                setEditing(false);
                setTheirs(false);
                edit.clear();
              }}
            >
              Keep theirs
            </button>
          </div>
        )}
      </>
    );
  }
  const open = () => {
    setBase(value ?? null);
    setEditing(true);
  };
  return (
    <div className="rich-field">
      {/* Edits on a plain click only; dragging, double and triple clicks select text, and links open. */}
      {isEmptyValue(value) ? (
        why ? (
          <div className="tv-add tv-add--locked">{placeholder === 'Add text' ? 'Empty' : placeholder}</div>
        ) : (
          <button type="button" className="tv-add" onClick={open}>
            {placeholder}
          </button>
        )
      ) : (
        <div className={`rich-read${why ? '' : ' rich-read--editable'}`} {...(why ? {} : { ...plain, 'aria-label': `Edit ${label}` })}>
          <Adf doc={value} ctx={ctx} className="tv-rich" />
        </div>
      )}
      <span className="rich-field-side">
        <WorkspaceMark state={state} ticketKey={d.key} fieldId={id} />
        {why && (
          <a className="edit-in-jira" href={jiraUrl(site, d.key)} target="_blank" rel="noreferrer noopener" data-tip={why}>
            Edit in Jira
          </a>
        )}
      </span>
    </div>
  );
}

type Option = { id?: string; name?: string; value?: string };

/** Whether FieldControl edits a field of this schema. */
export function hasControl(schema: JiraFieldSchema | undefined, meta: { allowedValues?: Option[] } | undefined, id: string, ids: JiraFieldIds): boolean {
  const type = schema?.type ?? 'any';
  const allowed = (meta?.allowedValues ?? []).length > 0;
  if (id === ids.sprint || schema?.custom?.endsWith(':gh-sprint')) return true;
  if (type === 'user' || type === 'number' || type === 'date') return true;
  if (type === 'array') return schema?.items === 'user' || schema?.items === 'string' || allowed;
  if (['option', 'priority', 'resolution', 'version', 'component', 'securitylevel'].includes(type)) return allowed;
  return type === 'string' && !isRichText(schema);
}
const optionLabel = (o: Option): string => o.name ?? o.value ?? o.id ?? '';

/**
 * The control for one non-rich field, by its schema: people, a select of the allowed values, several of them, labels
 * with suggestions, a number, a date, a sprint, or plain text. Returns null for a type it does not edit.
 */
export function FieldControl({ state, project, schema, meta, value, onChange, label, ids, id }: { state: WorkspaceState; project: string; schema?: JiraFieldSchema; meta?: JiraEditMeta | { allowedValues?: Option[] }; value: unknown; onChange: (v: unknown) => void; label: string; ids: JiraFieldIds; id: string }): ReactNode {
  const options = state.jiraOptions[project];
  const allowed = (meta?.allowedValues ?? []) as Option[];
  const type = schema?.type ?? 'any';
  const items = schema?.items;
  if (id === ids.sprint || schema?.custom?.endsWith(':gh-sprint')) {
    const current = Array.isArray(value) ? (value as Array<{ id?: number }>).find((s) => s && typeof s === 'object')?.id : typeof value === 'number' ? value : undefined;
    return (
      <select className="fc-select" aria-label={label} value={current ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
        <option value="">No sprint</option>
        {(options?.sprints ?? []).map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
            {s.state === 'future' ? ' (next)' : ''}
          </option>
        ))}
      </select>
    );
  }
  if (type === 'user') {
    const current = obj(value).accountId as string | undefined;
    return (
      <select className="fc-select" aria-label={label} value={current ?? ''} onChange={(e) => onChange(e.target.value ? { accountId: e.target.value } : null)}>
        <option value="">Unassigned</option>
        {(options?.users ?? []).map((u) => (
          <option key={u.accountId} value={u.accountId}>
            {u.displayName}
          </option>
        ))}
      </select>
    );
  }
  if (type === 'array' && items === 'user') {
    const chosen = (Array.isArray(value) ? value : []) as Array<{ accountId?: string; displayName?: string }>;
    const ids2 = new Set(chosen.map((u) => u.accountId));
    return (
      <span className="fc-multi">
        {chosen.map((u) => (
          <span key={u.accountId} className="label-chip">
            {u.displayName ?? options?.users.find((x) => x.accountId === u.accountId)?.displayName ?? u.accountId}
            <button type="button" className="chip-x" aria-label={`Remove ${u.displayName ?? ''}`} onClick={() => onChange(chosen.filter((x) => x.accountId !== u.accountId).map((x) => ({ accountId: x.accountId })))}>
              ×
            </button>
          </span>
        ))}
        <select className="fc-select fc-select--add" aria-label={`Add to ${label}`} value="" onChange={(e) => e.target.value && onChange([...chosen.map((x) => ({ accountId: x.accountId })), { accountId: e.target.value }])}>
          <option value="">Add…</option>
          {(options?.users ?? [])
            .filter((u) => !ids2.has(u.accountId))
            .map((u) => (
              <option key={u.accountId} value={u.accountId}>
                {u.displayName}
              </option>
            ))}
        </select>
      </span>
    );
  }
  if (type === 'array' && items === 'string') {
    const labels = (Array.isArray(value) ? value : []) as string[];
    return <LabelsControl labels={labels} suggestions={options?.labels ?? []} onChange={onChange} label={label} />;
  }
  if (type === 'array' && allowed.length) {
    const chosen = (Array.isArray(value) ? value : []) as Option[];
    const has = new Set(chosen.map((c) => c.id ?? c.value ?? c.name));
    return (
      <span className="fc-multi" role="group" aria-label={label}>
        {allowed.map((o) => {
          const k = o.id ?? o.value ?? o.name ?? '';
          const on = has.has(k);
          return (
            <button key={k} type="button" className={`label-chip label-chip--toggle${on ? ' label-chip--on' : ''}`} aria-pressed={on} onClick={() => onChange(on ? chosen.filter((c) => (c.id ?? c.value ?? c.name) !== k).map((c) => (c.id ? { id: c.id } : c)) : [...chosen.map((c) => (c.id ? { id: c.id } : c)), o.id ? { id: o.id } : o])}>
              {optionLabel(o)}
            </button>
          );
        })}
      </span>
    );
  }
  if ((type === 'option' || type === 'priority' || type === 'resolution' || type === 'version' || type === 'component' || type === 'securitylevel') && allowed.length) {
    const current = obj(value).id as string | undefined;
    return (
      <select className="fc-select" aria-label={label} value={current ?? ''} onChange={(e) => onChange(e.target.value ? { id: e.target.value } : null)}>
        <option value="">None</option>
        {allowed.map((o) => (
          <option key={o.id ?? optionLabel(o)} value={o.id ?? ''}>
            {optionLabel(o)}
          </option>
        ))}
      </select>
    );
  }
  if (type === 'number') {
    return <input className="fc-input fc-input--number" type="number" step="any" aria-label={label} defaultValue={typeof value === 'number' ? value : ''} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} />;
  }
  if (type === 'date') {
    return <input className="fc-input" type="date" aria-label={label} defaultValue={typeof value === 'string' ? value.slice(0, 10) : ''} onChange={(e) => onChange(e.target.value || null)} />;
  }
  if (type === 'string' && !isRichText(schema, value)) {
    return <input className="fc-input fc-input--wide" type="text" aria-label={label} defaultValue={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} />;
  }
  return null;
}

function LabelsControl({ labels, suggestions, onChange, label }: { labels: string[]; suggestions: string[]; onChange: (v: unknown) => void; label: string }) {
  const [typed, setTyped] = useState('');
  const list = useMemo(() => `labels-${Math.random().toString(36).slice(2, 8)}`, []);
  const add = () => {
    const l = typed.trim().replace(/\s+/g, '-');
    if (l && !labels.includes(l)) onChange([...labels, l]);
    setTyped('');
  };
  return (
    <span className="fc-multi">
      {labels.map((l) => (
        <span key={l} className="label-chip">
          {l}
          <button type="button" className="chip-x" aria-label={`Remove ${l}`} onClick={() => onChange(labels.filter((x) => x !== l))}>
            ×
          </button>
        </span>
      ))}
      <input className="fc-input" list={list} aria-label={`Add to ${label}`} placeholder="Add a label" value={typed} onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), add())} onBlur={add} />
      <datalist id={list}>
        {suggestions.filter((s) => !labels.includes(s) && s.toLowerCase().includes(typed.toLowerCase())).slice(0, 30).map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
    </span>
  );
}

/** A non-rich field, read or edited in place. */
export function FactField({ state, d, id, name, ids, children, site }: { state: WorkspaceState; d: TicketDetailView; id: string; name: string; ids: JiraFieldIds; children: ReactNode; site: string }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<unknown>(undefined);
  const edit = useEdit(state, d.key);
  const project = d.key.split('-')[0]!;
  const why = notEditable(d, id);
  const control = !why && editing ? <FieldControl state={state} project={project} schema={d.schema[id]} meta={d.editmeta[id]} value={draft === undefined ? (id === ids.sprint ? currentSprintId(d.fields[id]) : d.fields[id]) : draft} onChange={setDraft} label={name} ids={ids} id={id} /> : null;
  useEffect(() => {
    if (edit.outcome?.ok) {
      setEditing(false);
      setDraft(undefined);
      edit.clear();
    }
  }, [edit.outcome?.ok]); // eslint-disable-line react-hooks/exhaustive-deps
  const canEdit = !why && hasControl(d.schema[id], d.editmeta[id], id, ids);
  const plain = usePlainClick(() => setEditing(true), canEdit && !editing);
  const conflict = edit.outcome?.conflict;
  return (
    <>
      <span className="tv-label">{name}</span>
      <span className="tv-value">
        {editing && control ? (
          <span className="fc">
            {control}
            <span className="fc-actions">
              <button type="button" className="button-outline button-outline--small" onClick={() => (setEditing(false), setDraft(undefined), edit.clear())}>
                Cancel
              </button>
              <button
                type="button"
                className="button-solid button-solid--small"
                disabled={edit.pending}
                onClick={() => edit.save({ op: 'field', fieldId: id, value: draft === undefined ? (d.fields[id] ?? null) : draft, base: conflict ? conflict.theirs : (d.fields[id] ?? null) })}
              >
                {edit.pending ? 'Saving…' : 'Save'}
              </button>
            </span>
            {conflict && (
              <span className="fc-conflict">
                {conflict.by ?? 'Someone'} changed it to “{valueText(conflict.theirs, d.schema[id]) || 'empty'}” while you were editing.
              </span>
            )}
            <ReplaceAsk edit={edit} />
            {edit.outcome?.error && <span className="ed-error">{edit.outcome.error}</span>}
          </span>
        ) : canEdit ? (
          <span className="fact-edit" aria-label={`Edit ${name}`} {...plain}>
            {children}
          </span>
        ) : (
          children
        )}
        <WorkspaceMark state={state} ticketKey={d.key} fieldId={id} />
        {why && editing && <a className="edit-in-jira" href={jiraUrl(site, d.key)} target="_blank" rel="noreferrer noopener">Edit in Jira</a>}
      </span>
    </>
  );
}

const currentSprintId = (v: unknown): number | null => {
  const s = Array.isArray(v) ? (v as Array<{ id?: number; state?: string }>) : [];
  return (s.find((x) => x.state === 'active') ?? s.find((x) => x.state === 'future') ?? s.at(-1))?.id ?? null;
};

/** The title, edited in place. */
export function TitleField({ state, d, children }: { state: WorkspaceState; d: TicketDetailView; children: ReactNode }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const edit = useEdit(state, d.key);
  const can = !notEditable(d, 'summary');
  const plain = usePlainClick(() => (setText(String(d.fields.summary ?? '')), setEditing(true)), can && !editing);
  useEffect(() => {
    if (edit.outcome?.ok) {
      setEditing(false);
      edit.clear();
    }
  }, [edit.outcome?.ok]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!editing) {
    return can ? (
      <span className="title-edit" aria-label="Edit the title" {...plain}>
        {children}
      </span>
    ) : (
      <>{children}</>
    );
  }
  const save = () => text.trim() && edit.save({ op: 'field', fieldId: 'summary', value: text.trim(), base: edit.outcome?.conflict ? edit.outcome.conflict.theirs : (d.fields.summary ?? null) });
  return (
    <span className="title-form">
      <input
        autoFocus
        className="fc-input fc-input--title"
        aria-label="Title"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') save();
          else if (e.key === 'Escape') setEditing(false);
        }}
      />
      {edit.outcome?.conflict && <span className="fc-conflict">{edit.outcome.conflict.by ?? 'Someone'} changed the title to “{String(edit.outcome.conflict.theirs ?? '')}” meanwhile.</span>}
      <ReplaceAsk edit={edit} />
      {edit.outcome?.error && <span className="ed-error">{edit.outcome.error}</span>}
    </span>
  );
}

/** The workflow status chip: a menu of the transitions Jira offers now, each naming its target status. */
export function StatusMenu({ state, d, ids, name, category }: { state: WorkspaceState; d: TicketDetailView; ids: JiraFieldIds; name: string; category: 'new' | 'indeterminate' | 'done' }) {
  const [screen, setScreen] = useState<JiraTransition | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  // A floating layer: it closes on a click outside, on Escape, or when another layer opens.
  const menu = useLayer('menu', {
    onClose: () => {
      setScreen(null);
      setValues({});
    },
  });
  const edit = useEdit(state, d.key);
  const transitions = state.transitions[d.key];
  useEffect(() => {
    if (edit.outcome?.ok) {
      menu.hide(true);
      edit.clear();
    }
  }, [edit.outcome?.ok]); // eslint-disable-line react-hooks/exhaustive-deps
  const go = (t: JiraTransition) => {
    const required = t.fields.filter((f) => f.required && isEmptyValue(d.fields[f.id]));
    if (required.length && !screen) {
      setScreen(t);
      return;
    }
    edit.send({ op: 'transition', transitionId: t.id, ...(Object.keys(values).length ? { fields: values } : {}) });
  };
  return (
    <span className="status-menu">
      <button
        ref={refTo(menu.anchor)}
        type="button"
        className="chip-status chip-status--button"
        style={{ background: `var(${statusToken(name, category)})` }}
        aria-haspopup="menu"
        aria-expanded={menu.open}
        onClick={() => {
          if (!menu.open) stream.jiraTransitions(d.key);
          menu.toggle();
        }}
      >
        {name}
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      <Floating layer={menu} side="bottom" align="start" className="status-pop" role="menu" aria-label="Move to">
          {!transitions ? (
            <span className="tv-muted">Reading the workflow…</span>
          ) : screen ? (
            <div className="status-screen">
              <b>{screen.name}</b>
              {screen.fields
                .filter((f) => f.required && isEmptyValue(d.fields[f.id]))
                .map((f) => (
                  <label key={f.id} className="status-field">
                    <span className="tv-label">{f.name}</span>
                    <FieldControl state={state} project={d.key.split('-')[0]!} {...(f.schema ? { schema: f.schema } : {})} meta={{ ...(f.allowedValues ? { allowedValues: f.allowedValues } : {}) }} value={values[f.id] ?? null} onChange={(v) => setValues({ ...values, [f.id]: v })} label={f.name} ids={ids} id={f.id} />
                  </label>
                ))}
              <span className="fc-actions">
                <button type="button" className="button-outline button-outline--small" onClick={() => setScreen(null)}>
                  Back
                </button>
                <button type="button" className="button-solid button-solid--small" disabled={edit.pending || screen.fields.some((f) => f.required && isEmptyValue(d.fields[f.id]) && isEmptyValue(values[f.id]))} onClick={() => go(screen)}>
                  {edit.pending ? 'Moving…' : `Move to ${screen.to.name}`}
                </button>
              </span>
            </div>
          ) : transitions.length ? (
            transitions.map((t) => (
              <button key={t.id} type="button" role="menuitem" className="status-item" disabled={edit.pending} onClick={() => go(t)}>
                <span>{t.name}</span>
                <span className="chip-status" style={{ background: `var(${statusToken(t.to.name, t.to.category)})` }}>
                  {t.to.name}
                </span>
              </button>
            ))
          ) : (
            <span className="tv-muted">Jira offers no transitions from here.</span>
          )}
          {edit.outcome?.error && <span className="ed-error">{edit.outcome.error}</span>}
      </Floating>
    </span>
  );
}

/** Comments: his new one, and edit or delete on his own. */
export function CommentsEditor({ state, d, ctx }: { state: WorkspaceState; d: TicketDetailView; ctx: AdfContext }) {
  const project = d.key.split('-')[0]!;
  const options = state.jiraOptions[project];
  const me = options?.me.accountId;
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const edit = useEdit(state, d.key);
  useEffect(() => {
    if (edit.outcome?.ok) {
      setAdding(false);
      setEditing(null);
      setDeleting(null);
      edit.clear();
    }
  }, [edit.outcome?.ok]); // eslint-disable-line react-hooks/exhaustive-deps
  const people = (options?.users ?? []).flatMap((u) => (u.accountId ? [{ accountId: u.accountId, displayName: u.displayName }] : []));
  return (
    <>
      {d.comments.length ? (
        <ol className="tv-comments">
          {d.comments.map((c) => {
            const mine = !!me && c.author?.accountId === me;
            const locked = d.locked.includes(`comment:${c.id}`) || !editable(c.body);
            return (
              <li key={c.id} className="tv-comment">
                <span className="person-initials" data-tip={c.author?.displayName} aria-hidden="true">
                  {(c.author?.displayName ?? '?')
                    .split(/\s+/)
                    .map((w) => w[0])
                    .join('')
                    .slice(0, 2)
                    .toUpperCase()}
                </span>
                <div className="tv-comment-body">
                  <span className="tv-comment-head">
                    <b>{c.author?.displayName ?? 'Someone'}</b> <span className="tv-muted">{jiraDate(c.created, true)}{c.updated ? ' · edited' : ''}</span>
                    {mine && editing !== c.id && (
                      <span className="tv-comment-actions">
                        {!locked && (
                          <button type="button" className="link-button" onClick={() => (edit.clear(), setEditing(c.id))}>
                            Edit
                          </button>
                        )}
                        {deleting === c.id ? (
                          <>
                            <span className="tv-muted">Delete it?</span>
                            <button type="button" className="link-button" onClick={() => edit.send({ op: 'comment_delete', commentId: c.id })}>
                              Delete
                            </button>
                            <button type="button" className="link-button" onClick={() => setDeleting(null)}>
                              Keep
                            </button>
                          </>
                        ) : (
                          <button type="button" className="link-button" onClick={() => setDeleting(c.id)}>
                            Delete
                          </button>
                        )}
                      </span>
                    )}
                  </span>
                  {editing === c.id ? (
                    <RichEditor
                      label="Comment"
                      initial={c.body}
                      people={people}
                      saving={edit.pending}
                      {...(edit.outcome?.conflict ? { conflict: edit.outcome.conflict } : {})}
                      {...(edit.outcome?.error ? { error: edit.outcome.error } : {})}
                      {...(edit.asking !== undefined ? { ask: <ReplaceAsk edit={edit} /> } : {})}
                      onCancel={() => (setEditing(null), edit.clear())}
                      onSave={(doc) => edit.save({ op: 'comment_edit', commentId: c.id, body: doc, base: edit.outcome?.conflict ? edit.outcome.conflict.theirs : c.body })}
                    />
                  ) : (
                    <Adf doc={c.body} ctx={ctx} className="tv-rich tv-rich--comment" />
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="tv-muted">No comments.</p>
      )}
      {adding ? (
        <RichEditor label="Comment" initial={null} people={people} saving={edit.pending} {...(edit.outcome?.error ? { error: edit.outcome.error } : {})} onCancel={() => (setAdding(false), edit.clear())} onSave={(doc) => !isEmptyDoc(doc) && edit.send({ op: 'comment_add', body: doc })} />
      ) : (
        <button type="button" className="tv-add" onClick={() => (edit.clear(), setAdding(true))}>
          Add a comment
        </button>
      )}
    </>
  );
}

/** "+ Link": a link type in either direction, and a ticket found by key or words. */
export function LinkForm({ state, d, onClose }: { state: WorkspaceState; d: TicketDetailView; onClose: () => void }) {
  const types = state.jiraOptions[d.key.split('-')[0]!]?.linkTypes ?? [];
  const relations = types.flatMap((t) => (t.inward === t.outward ? [{ key: `${t.name}/outward`, type: t.name, direction: 'outward' as const, words: t.outward }] : [{ key: `${t.name}/outward`, type: t.name, direction: 'outward' as const, words: t.outward }, { key: `${t.name}/inward`, type: t.name, direction: 'inward' as const, words: t.inward }]));
  const [relation, setRelation] = useState(relations[0]?.key ?? '');
  const [query, setQuery] = useState('');
  const edit = useEdit(state, d.key);
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return;
    const t = setTimeout(() => stream.searchTickets(q), 300);
    return () => clearTimeout(t);
  }, [query]);
  useEffect(() => {
    if (edit.outcome?.ok) onClose();
  }, [edit.outcome?.ok]); // eslint-disable-line react-hooks/exhaustive-deps
  const found = state.ticketSearch && state.ticketSearch.query === query.trim() ? state.ticketSearch.results.filter((r) => r.key !== d.key) : [];
  const chosen = relations.find((r) => r.key === relation);
  return (
    <div className="link-form">
      <select className="fc-select" aria-label="Link type" value={relation} onChange={(e) => setRelation(e.target.value)}>
        {relations.map((r) => (
          <option key={r.key} value={r.key}>
            {r.words}
          </option>
        ))}
      </select>
      <input className="fc-input fc-input--wide" autoFocus aria-label="Find a ticket" placeholder="A key or words from its title" value={query} onChange={(e) => setQuery(e.target.value)} />
      <button type="button" className="button-outline button-outline--small" onClick={onClose}>
        Cancel
      </button>
      {found.length > 0 && (
        <div className="link-results" role="listbox" aria-label="Tickets">
          {found.slice(0, 8).map((r) => (
            <button key={r.key} type="button" role="option" aria-selected={false} className="link-result" disabled={!chosen || edit.pending} onClick={() => chosen && edit.send({ op: 'link_add', linkType: chosen.type, direction: chosen.direction, other: r.key })}>
              <b>{r.key}</b>
              <span className="issue-row-title">{r.summary}</span>
              <span className="chip-status" style={{ background: `var(${statusToken(r.status.name, r.status.category)})` }}>
                {r.status.name}
              </span>
            </button>
          ))}
        </div>
      )}
      {edit.outcome?.error && <span className="ed-error">{edit.outcome.error}</span>}
    </div>
  );
}

/** Removes a link, from its row. */
export function UnlinkButton({ state, d, linkId, label }: { state: WorkspaceState; d: TicketDetailView; linkId: string; label: string }) {
  const edit = useEdit(state, d.key);
  return (
    <button type="button" className="row-x" aria-label={`Remove the link to ${label}`} data-tip="Remove the link" disabled={edit.pending} onClick={() => edit.send({ op: 'link_remove', linkId })}>
      ×
    </button>
  );
}

export { currentSprint };
