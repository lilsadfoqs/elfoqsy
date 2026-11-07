// His create form ( and TicketCreate.dc.html), in the sprint column: project, type, priority,
// summary, the Description in the same editor as his edits, sprint (the current one by default), story points, labels,
// links, assignee, and whatever else Jira's create screen requires for that project and type. Nothing reaches Jira until
// he presses Create; then the new ticket opens here, and what Jira did not keep is said on it.
import { useEffect, useMemo, useState } from 'react';
import type { JiraCreateField } from '@elfoqsy/contracts';
import { fieldIdsOf, type WorkspaceState } from '@elfoqsy/state';
import { stream } from '../../state/workspace';
import { RichEditor } from '../../editor/RichEditor';
import { TypeIcon } from '../../ui/TicketBits';
import { createFields, emptyForm, extraRequired, formFromDraft, linkWords, missing, typeIdOf, type CreateForm } from './createForm';
import { typeOfName } from './find';
import type { SprintView } from './SprintColumn';
import { PriorityIcon } from './TicketView';

const KEY = /^[A-Z][A-Z0-9_]+-\d+$/;
const newCreateId = (): string => `create-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** The project most of the sprint's tickets are in. */
function usualProject(state: WorkspaceState): string {
  const counts = new Map<string, number>();
  for (const k of Object.keys(state.tickets)) counts.set(k.split('-')[0]!, (counts.get(k.split('-')[0]!) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'SHOP';
}

export function CreateTicket({ state, draftId, onView, onClose }: { state: WorkspaceState; draftId?: string; onView: (v: SprintView) => void; onClose: () => void }) {
  const draft = draftId ? state.drafts[draftId] : undefined;
  const [form, setForm] = useState<CreateForm>(() => (draft ? formFromDraft(draft.draft) : emptyForm(usualProject(state))));
  const [createId, setCreateId] = useState<string | null>(null);
  const set = (patch: Partial<CreateForm>) => setForm((f) => ({ ...f, ...patch }));
  const ids = useMemo(() => fieldIdsOf(state.jiraFields), [state.jiraFields]);
  const meta = state.createMeta[form.project];
  const types = (meta?.types ?? []).filter((t) => !t.subtask);
  const screen: JiraCreateField[] | undefined = form.typeId ? meta?.fields[form.typeId] : undefined;
  const options = state.jiraOptions[form.project];
  const people = (options?.users ?? []).flatMap((u) => (u.accountId ? [{ accountId: u.accountId, displayName: u.displayName }] : []));
  const me = options?.me.accountId;
  const outcome = createId ? state.created[createId] : undefined;
  const pending = !!createId && !outcome;

  // The project's create screen and pickers, then the chosen type's fields.
  const projectOk = /^[A-Z][A-Z0-9_]+$/.test(form.project);
  useEffect(() => {
    if (projectOk && !meta) stream.jiraCreatemeta(form.project);
  }, [form.project, projectOk, !!meta]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (form.typeId || !types.length) return;
    // A draft's type by name; otherwise a story.
    set({ typeId: typeIdOf(types, form.typeName || 'Story') || types[0]!.id });
  }, [types.length, form.typeId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (projectOk && form.typeId && !screen) stream.jiraCreatemeta(form.project, form.typeId);
  }, [form.project, form.typeId, !!screen]); // eslint-disable-line react-hooks/exhaustive-deps
  // The current sprint by default, once the board's sprints are known.
  useEffect(() => {
    if (draft || form.sprintId !== null || !options) return;
    const active = options.sprints.find((s) => s.state === 'active');
    if (active) set({ sprintId: active.id });
  }, [!!options]); // eslint-disable-line react-hooks/exhaustive-deps
  // Created: the new ticket opens here.
  useEffect(() => {
    if (outcome?.key) onView({ kind: 'ticket', key: outcome.key });
  }, [outcome?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  const lacking = missing(form, screen, ids);
  const extras = extraRequired(screen, ids);
  const priorities = screen?.find((f) => f.id === 'priority')?.allowedValues ?? [];
  const sprints = (options?.sprints ?? []).filter((s) => s.state === 'active' || s.state === 'future');
  const create = () => {
    if (lacking.length || pending || stream.tester) return;
    const id = newCreateId();
    const sent = stream.jiraCreate({
      createId: id,
      project: form.project,
      typeId: form.typeId,
      fields: createFields(form, ids, screen),
      ...(form.links.length ? { links: form.links } : {}),
      ...(draft && !draft.closed ? { draftId: draft.draftId } : {}),
    });
    if (sent) setCreateId(id);
  };

  return (
    <form
      className="create"
      aria-label="New ticket"
      // Only the Create button creates: Enter in a field never does.
      onSubmit={(e) => e.preventDefault()}
    >
      <div className="create-head">
        <h2>New ticket</h2>
        <span className="create-note">Nothing reaches Jira until you press Create</span>
      </div>
      <div className="create-grid">
        <Labelled label="Project">
          <input className="create-input" value={form.project} spellCheck={false} onChange={(e) => set({ project: e.target.value.toUpperCase().trim(), typeId: '', extra: {} })} />
        </Labelled>
        <Labelled label="Type">
          <span className="create-select">
            {form.typeId && <TypeIcon type={typeOfName(types.find((t) => t.id === form.typeId)?.name ?? '')} size={18} />}
            <select value={form.typeId} onChange={(e) => set({ typeId: e.target.value, typeName: types.find((t) => t.id === e.target.value)?.name ?? '', extra: {} })}>
              {!types.length && <option value="">Reading Jira…</option>}
              {types.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </span>
        </Labelled>
        <Labelled label="Priority">
          <span className="create-select">
            {form.priority && <PriorityIcon name={form.priority} size={16} />}
            <select value={form.priority} onChange={(e) => set({ priority: e.target.value })}>
              <option value="">Jira’s default</option>
              {form.priority && !priorities.some((p) => p.name === form.priority) && <option value={form.priority}>{form.priority}</option>}
              {priorities.map((p) => (
                <option key={p.id ?? p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
            </select>
          </span>
        </Labelled>
      </div>
      <Labelled label="Summary">
        <input className="create-input" value={form.summary} onChange={(e) => set({ summary: e.target.value })} />
      </Labelled>
      <div className="create-field">
        <span className="create-label">Description</span>
        <RichEditor label="Description" initial={form.description} autoFocus={false} onSave={() => undefined} onCancel={() => undefined} onChange={(doc) => set({ description: doc })} />
      </div>
      <div className="create-grid">
        <Labelled label="Sprint">
          <span className="create-select">
            <select value={form.sprintId ?? ''} onChange={(e) => set({ sprintId: e.target.value ? Number(e.target.value) : null })}>
              <option value="">No sprint (backlog)</option>
              {form.sprintId !== null && !sprints.some((s) => s.id === form.sprintId) && <option value={form.sprintId}>{draft?.draft.sprint?.name ?? `Sprint ${form.sprintId}`}</option>}
              {sprints.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </span>
        </Labelled>
        <Labelled label="Story points">
          <input className="create-input" inputMode="decimal" value={form.storyPoints} onChange={(e) => set({ storyPoints: e.target.value.replace(/[^\d.]/g, '') })} />
        </Labelled>
        <div className="create-field">
          <span className="create-label">Labels</span>
          <Labels labels={form.labels} known={options?.labels ?? []} onChange={(labels) => set({ labels })} />
        </div>
      </div>
      <div className="create-field">
        <span className="create-label">Links</span>
        <Links form={form} types={options?.linkTypes ?? []} onChange={(links) => set({ links })} />
      </div>
      <div className="create-grid">
        <Labelled label="Assignee">
          <span className="create-select">
            <select value={form.assignee} onChange={(e) => set({ assignee: e.target.value })}>
              <option value="">Unassigned</option>
              {me && <option value={me}>{options!.me.displayName} (you)</option>}
              {people
                .filter((u) => u.accountId !== me)
                .map((u) => (
                  <option key={u.accountId} value={u.accountId}>
                    {u.displayName}
                  </option>
                ))}
            </select>
          </span>
        </Labelled>
        {form.parent && (
          <div className="create-field">
            <span className="create-label">Parent</span>
            <span className="create-chipline">
              <span className="create-key">{form.parent}</span>
              <button type="button" className="create-x" aria-label={`No parent ${form.parent}`} onClick={() => set({ parent: '' })}>
                ×
              </button>
            </span>
          </div>
        )}
      </div>
      {extras.length > 0 && (
        <div className="create-grid">
          {extras.map((f) => (
            <ExtraField key={f.id} field={f} value={form.extra[f.id]} users={people} onChange={(v) => set({ extra: { ...form.extra, [f.id]: v } })} />
          ))}
        </div>
      )}
      <div className="create-foot">
        <span className="create-status">
          {outcome?.error ? <span className="ed-error">Jira refused it: {outcome.error}</span> : stream.tester ? 'Only alex creates tickets.' : lacking.length && !pending ? `Still needed: ${lacking.join(', ')}.` : pending ? 'Creating in Jira…' : ''}
        </span>
        <button type="button" className="button-outline" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="button-solid" disabled={lacking.length > 0 || pending || stream.tester} onClick={create}>
          {pending ? 'Creating…' : 'Create'}
        </button>
      </div>
    </form>
  );
}

function Labelled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="create-field">
      <span className="create-label">{label}</span>
      {children}
    </label>
  );
}

/** Labels as chips; Enter or a comma adds what is typed, with the project's labels suggested. */
function Labels({ labels, known, onChange }: { labels: string[]; known: string[]; onChange: (l: string[]) => void }) {
  const [typed, setTyped] = useState('');
  const add = () => {
    const l = typed.trim().replace(/\s+/g, '-');
    if (l && !labels.includes(l)) onChange([...labels, l]);
    setTyped('');
  };
  return (
    <span className="create-input create-chips">
      {labels.map((l) => (
        <span key={l} className="label-chip">
          {l}
          <button type="button" className="create-x" aria-label={`Remove label ${l}`} onClick={() => onChange(labels.filter((x) => x !== l))}>
            ×
          </button>
        </span>
      ))}
      <input
        aria-label="Add a label"
        list="create-labels"
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        onBlur={add}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            add();
          }
        }}
      />
      <datalist id="create-labels">
        {known.slice(0, 200).map((l) => (
          <option key={l} value={l} />
        ))}
      </datalist>
    </span>
  );
}

/** Links from the new ticket, in Jira's wording; "+ Link" takes a type and a key. */
function Links({ form, types, onChange }: { form: CreateForm; types: Array<{ id: string; name: string; inward: string; outward: string }>; onChange: (l: CreateForm['links']) => void }) {
  const relations = (types.length ? types : [{ id: '', name: 'Relates', inward: 'relates to', outward: 'relates to' }]).flatMap((t) =>
    t.inward === t.outward ? [{ type: t.name, direction: 'outward' as const, words: t.outward }] : [{ type: t.name, direction: 'outward' as const, words: t.outward }, { type: t.name, direction: 'inward' as const, words: t.inward }],
  );
  const [adding, setAdding] = useState(false);
  const [relation, setRelation] = useState(0);
  const [other, setOther] = useState('');
  const key = other.trim().toUpperCase();
  return (
    <div className="create-input create-links">
      {form.links.map((l, n) => (
        <span key={`${l.linkType}-${l.direction}-${l.other}`} className="create-chipline">
          <span className="create-muted">{linkWords(types, l)}</span>
          <span className="create-key">{l.other}</span>
          <button type="button" className="create-x" aria-label={`Remove link to ${l.other}`} onClick={() => onChange(form.links.filter((_, i) => i !== n))}>
            ×
          </button>
        </span>
      ))}
      {adding ? (
        <span className="create-chipline">
          <select aria-label="Link type" value={relation} onChange={(e) => setRelation(Number(e.target.value))}>
            {relations.map((r, n) => (
              <option key={`${r.type}-${r.direction}`} value={n}>
                {r.words}
              </option>
            ))}
          </select>
          <input aria-label="Ticket key" placeholder="SHOP-1234" value={other} onChange={(e) => setOther(e.target.value)} />
          <button
            type="button"
            className="button-outline button-outline--small"
            disabled={!KEY.test(key)}
            onClick={() => {
              const r = relations[relation]!;
              onChange([...form.links, { linkType: r.type, direction: r.direction, other: key }]);
              setOther('');
              setAdding(false);
            }}
          >
            Add
          </button>
        </span>
      ) : (
        <button type="button" className="tv-add tv-add--small" onClick={() => setAdding(true)}>
          + Link
        </button>
      )}
    </div>
  );
}

const optionLabel = (v: { name?: string; value?: string; id?: string }): string => v.value ?? v.name ?? v.id ?? '';

/** A field Jira's create screen requires that the form has no control of its own for, by its schema. */
function ExtraField({ field, value, users, onChange }: { field: JiraCreateField; value: unknown; users: Array<{ accountId: string; displayName: string }>; onChange: (v: unknown) => void }) {
  const s = field.schema;
  const many = s?.type === 'array';
  const kind = many ? s?.items : s?.type;
  if (kind === 'option' || field.allowedValues?.length) {
    const chosen = many ? ((value as Array<{ id: string }> | undefined) ?? []).map((v) => v.id) : [(value as { id?: string } | undefined)?.id ?? ''];
    return (
      <Labelled label={field.name}>
        <span className="create-select">
          <select multiple={many} value={many ? chosen : chosen[0]} onChange={(e) => (many ? onChange([...e.target.selectedOptions].map((o) => ({ id: o.value }))) : onChange(e.target.value ? { id: e.target.value } : null))}>
            {!many && <option value="">Choose…</option>}
            {(field.allowedValues ?? []).map((v) => (
              <option key={v.id} value={v.id}>
                {optionLabel(v)}
              </option>
            ))}
          </select>
        </span>
      </Labelled>
    );
  }
  if (kind === 'user') {
    const id = many ? (value as Array<{ accountId: string }> | undefined)?.[0]?.accountId : (value as { accountId?: string } | undefined)?.accountId;
    return (
      <Labelled label={field.name}>
        <span className="create-select">
          <select value={id ?? ''} onChange={(e) => onChange(e.target.value ? (many ? [{ accountId: e.target.value }] : { accountId: e.target.value }) : null)}>
            <option value="">Choose…</option>
            {users.map((u) => (
              <option key={u.accountId} value={u.accountId}>
                {u.displayName}
              </option>
            ))}
          </select>
        </span>
      </Labelled>
    );
  }
  if (kind === 'string' && /textarea/.test(s?.custom ?? '')) {
    // Multi-line text is rich text in Jira's API: the same editor.
    return (
      <div className="create-field create-field--wide">
        <span className="create-label">{field.name}</span>
        <RichEditor label={field.name} initial={value ?? null} autoFocus={false} onSave={() => undefined} onCancel={() => undefined} onChange={onChange} />
      </div>
    );
  }
  return (
    <Labelled label={field.name}>
      <input
        className="create-input"
        type={kind === 'number' ? 'number' : kind === 'date' ? 'date' : 'text'}
        value={value === undefined || value === null ? '' : String(value)}
        onChange={(e) => onChange(kind === 'number' ? (e.target.value === '' ? null : Number(e.target.value)) : e.target.value)}
      />
    </Labelled>
  );
}
