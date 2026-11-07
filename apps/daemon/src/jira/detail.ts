// A ticket read from Jira as the log keeps it: trimmed to what the screens and Elfoqsy use, then compared with
// what the log already has, so after the first snapshot only what changed is written.
// - Kept: every non-empty field that is not hidden, with its name and schema; the edit metadata of the fields shown;
//   comments out of the field list; the newest 100 history entries; remote links.
// - Locked: a field (or comment:<id>) the redactor changed. What was masked cannot be written back without losing the
//   real text, so it opens read-only.
// - Changes: history entries since the last read made by someone other than alex, for the few seconds' mark.
import type { JiraComment, JiraEditMeta, JiraFieldChange, JiraFieldSchema, JiraHistory, JiraRemoteLink, PayloadOf } from '@elfoqsy/contracts';
import { HISTORY_KEPT, isEmptyValue, isHiddenField, type JiraFieldIds, type TicketDetailView } from '@elfoqsy/state';
import { canonical } from '../sync/tracker';
import { redactDeep } from '../redact';
import type { IssueBundle, RawUser } from './issues';

export type DetailPayload = PayloadOf<'ticket.detail'>;

/** Fields kept out of `fields`: comments have their own list, and these say nothing the view shows. */
const OUT_OF_FIELDS = new Set(['comment', 'watches', 'votes', 'worklog', 'lastViewed']);
const MAX_ALLOWED = 300;

const user = (u: RawUser | undefined): { accountId?: string; displayName: string } | undefined =>
  u ? { ...(u.accountId ? { accountId: u.accountId } : {}), displayName: u.displayName ?? 'someone' } : undefined;

const trimAllowed = (values: unknown[] | undefined) =>
  values?.slice(0, MAX_ALLOWED).map((v) => {
    const o = (v ?? {}) as Record<string, unknown>;
    return {
      ...(typeof o.id === 'string' ? { id: o.id } : typeof o.id === 'number' ? { id: String(o.id) } : {}),
      ...(typeof o.name === 'string' ? { name: o.name } : {}),
      ...(typeof o.value === 'string' ? { value: o.value } : {}),
    };
  });

const changed = (a: unknown, b: unknown): boolean => canonical(a) !== canonical(b);

/** The full snapshot of an issue, as it would be stored. */
export function toDetail(b: IssueBundle, ids: JiraFieldIds): DetailPayload {
  const i = b.issue;
  const names = i.names ?? {};
  const fields: Record<string, unknown> = {};
  for (const [id, v] of Object.entries(i.fields)) {
    if (OUT_OF_FIELDS.has(id) || isEmptyValue(v) || isHiddenField(id, names[id], ids)) continue;
    fields[id] = v;
  }
  const editmeta: Record<string, JiraEditMeta> = {};
  for (const [id, m] of Object.entries(i.editmeta?.fields ?? {})) {
    if (isHiddenField(id, names[id], ids) && id !== ids.development) continue;
    const allowed = trimAllowed(m.allowedValues);
    editmeta[id] = { required: !!m.required, operations: m.operations ?? [], ...(allowed ? { allowedValues: allowed } : {}) };
  }
  const shown = new Set([...Object.keys(fields), ...Object.keys(editmeta)]);
  const pick = <T>(all: Record<string, T> | undefined): Record<string, T> => Object.fromEntries(Object.entries(all ?? {}).filter(([id]) => shown.has(id)));
  const rawComments = ((i.fields.comment as { comments?: Array<Record<string, unknown>> } | undefined)?.comments ?? []) as Array<{ id: string; author?: RawUser; created: string; updated?: string; body?: unknown }>;
  const comments: JiraComment[] = rawComments.map((c) => ({ id: String(c.id), ...(user(c.author) ? { author: user(c.author)! } : {}), created: c.created, ...(c.updated && c.updated !== c.created ? { updated: c.updated } : {}), body: c.body ?? null }));
  const history: JiraHistory[] = [...(i.changelog?.histories ?? [])]
    .sort((x, y) => x.created.localeCompare(y.created))
    .slice(-HISTORY_KEPT)
    .map((h) => ({
      id: String(h.id),
      ...(user(h.author) ? { author: user(h.author)! } : {}),
      created: h.created,
      items: (h.items ?? []).map((it) => ({
        field: String(it.field ?? ''),
        ...(typeof it.fieldId === 'string' ? { fieldId: it.fieldId } : {}),
        ...(it.from !== undefined ? { from: it.from === null ? null : String(it.from) } : {}),
        ...(it.fromString !== undefined ? { fromString: it.fromString === null ? null : String(it.fromString) } : {}),
        ...(it.to !== undefined ? { to: it.to === null ? null : String(it.to) } : {}),
        ...(it.toString !== undefined ? { toString: it.toString === null ? null : String(it.toString) } : {}),
      })),
    }));
  const remoteLinks: JiraRemoteLink[] = b.remoteLinks.map((l) => ({
    id: String(l.id),
    url: l.object?.url ?? '',
    title: l.object?.title ?? '',
    ...(l.application?.type ? { application: l.application.type } : {}),
    ...(l.relationship ? { relationship: l.relationship } : {}),
  }));
  // What the redactor would change cannot be edited here.
  const locked = [
    ...Object.entries(fields)
      .filter(([, v]) => changed(redactDeep(v), v))
      .map(([id]) => id),
    ...comments.filter((c) => changed(redactDeep(c.body), c.body)).map((c) => `comment:${c.id}`),
  ];
  return {
    key: i.key,
    id: String(i.id),
    full: true,
    fields,
    names: pick(names),
    schema: Object.fromEntries(
      Object.entries(pick(i.schema)).map(([id, sc]): [string, JiraFieldSchema] => [
        id,
        { type: String(sc.type ?? 'any'), ...(sc.items ? { items: String(sc.items) } : {}), ...(sc.custom ? { custom: String(sc.custom) } : {}), ...(sc.system ? { system: String(sc.system) } : {}) },
      ]),
    ),
    editmeta,
    comments,
    history,
    remoteLinks,
    locked,
    updated: String(i.fields.updated ?? ''),
    fetchedAt: new Date(b.fetchedAt).toISOString(),
  };
}

/**
 * What changed between what the log has and a new snapshot, or null when nothing did. Values are compared as the log
 * stores them (redacted). me: alex's account id, whose own changes are not marked.
 */
export function diffDetail(prev: TicketDetailView | undefined, next: DetailPayload, me: string): DetailPayload | null {
  if (!prev) return next;
  const stored = redactDeep(next);
  const patch: DetailPayload = { key: next.key, id: next.id, updated: next.updated, fetchedAt: next.fetchedAt };
  const fields: Record<string, unknown> = {};
  for (const [id, v] of Object.entries(stored.fields ?? {})) if (changed(prev.fields[id], v)) fields[id] = v;
  const removed = Object.keys(prev.fields).filter((id) => !(id in (stored.fields ?? {})));
  if (Object.keys(fields).length) patch.fields = fields;
  if (removed.length) patch.removed = removed;
  if (changed(prev.names, stored.names)) patch.names = stored.names!;
  if (changed(prev.schema, stored.schema)) patch.schema = stored.schema!;
  if (changed(prev.editmeta, stored.editmeta)) patch.editmeta = stored.editmeta!;
  if (changed(prev.comments, stored.comments)) patch.comments = stored.comments!;
  if (changed(prev.remoteLinks, stored.remoteLinks)) patch.remoteLinks = stored.remoteLinks!;
  if (changed(prev.locked, stored.locked)) patch.locked = stored.locked!;
  const known = new Set(prev.history.map((h) => h.id));
  const fresh = (stored.history ?? []).filter((h) => !known.has(h.id));
  if (fresh.length) {
    patch.history = fresh;
    const theirs: JiraFieldChange[] = fresh
      .filter((h) => h.author?.accountId !== me)
      .flatMap((h) => h.items.map((it) => ({ fieldId: it.fieldId ?? it.field, name: (it.fieldId && stored.names?.[it.fieldId]) || it.field, by: h.author?.displayName ?? 'someone', at: h.created })));
    if (theirs.length) patch.changes = theirs;
  }
  const meaningful = ['fields', 'removed', 'names', 'schema', 'editmeta', 'comments', 'remoteLinks', 'locked', 'history'].some((k) => k in patch);
  return meaningful ? patch : null;
}

/** Confluence page ids named in links of the ticket's rich text and comments (…/wiki/…/pages/<id>…). */
export function confluencePageIds(d: { fields?: Record<string, unknown>; comments?: JiraComment[] }, site: string): string[] {
  const host = site.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const found = new Set<string>();
  const re = new RegExp(`https?://${host.replace(/\./g, '\\.')}/wiki/[^\\s"'<>]*?pages/(?:viewpage\\.action\\?pageId=)?(\\d+)`, 'g');
  const scan = (v: unknown) => {
    for (const m of JSON.stringify(v ?? null).matchAll(re)) found.add(m[1]!);
  };
  for (const v of Object.values(d.fields ?? {})) scan(v);
  for (const c of d.comments ?? []) scan(c.body);
  return [...found];
}
