// Creating Jira tickets. Only alex creates one: from his form, or from a draft card's "Create in Jira",
// both a jira_create frame he sends. Elfoqsy and the agents can only draft (ticket.drafted, a card that waits for him);
// creating is not a delegation category, cannot be granted, and no tool of theirs reaches it. After he creates one, its
// links are added and the new ticket is read back to confirm its links, sprint and parent were set.
import type { JiraCreateField, PayloadOf, TicketDraft } from '@elfoqsy/contracts';
import type { EventLog } from '../eventLog';
import type { IssueStore } from '../jira/issues';
import type { JiraWriter } from '../jira/writer';
import { redact } from '../redact';
import { ulid } from '../ulid';
import type { TicketDetails } from './details';

export interface TicketCreatesDeps {
  log: EventLog;
  store: IssueStore;
  writer: JiraWriter;
  details: TicketDetails;
  /** The sprint field's id, to confirm the sprint was set. */
  sprintField: () => string;
}

/** A field of the create screen. Required means he must fill it: one Jira fills by default is not. */
const fieldOf = (f: { fieldId: string; name: string; required: boolean; hasDefaultValue?: boolean; schema?: Record<string, unknown>; allowedValues?: unknown[] }): JiraCreateField => ({
  id: f.fieldId,
  name: f.name,
  required: !!f.required && !f.hasDefaultValue,
  ...(f.schema ? { schema: { type: String(f.schema.type ?? 'any'), ...(f.schema.items ? { items: String(f.schema.items) } : {}), ...(f.schema.custom ? { custom: String(f.schema.custom) } : {}), ...(f.schema.system ? { system: String(f.schema.system) } : {}) } } : {}),
  ...(f.allowedValues
    ? {
        allowedValues: f.allowedValues.slice(0, 300).map((v) => {
          const o = (v ?? {}) as Record<string, unknown>;
          return { ...(o.id !== undefined ? { id: String(o.id) } : {}), ...(typeof o.name === 'string' ? { name: o.name } : {}), ...(typeof o.value === 'string' ? { value: o.value } : {}) };
        }),
      }
    : {}),
});

export class TicketCreates {
  constructor(private readonly d: TicketCreatesDeps) {}

  /** Jira's create screen for a project, and for one of its types when asked. */
  async meta(project: string, typeId?: string): Promise<void> {
    const types = await this.d.writer.createTypes(project);
    const fields = typeId ? (await this.d.writer.createFields(project, typeId)).map(fieldOf) : undefined;
    this.d.log.append('jira', 'ticket.createmeta', { project, types, ...(typeId ? { typeId } : {}), ...(fields ? { fields } : {}) });
  }

  /** His Create: the ticket, its links, then a read-back of what was set. */
  async create(f: { createId: string; project: string; typeId: string; fields: Record<string, unknown>; links?: TicketDraft['links']; draftId?: string }): Promise<void> {
    let key: string;
    try {
      key = await this.d.writer.create({ ...f.fields, project: { key: f.project }, issuetype: { id: f.typeId } });
    } catch (error) {
      this.d.log.append('jira', 'ticket.create_failed', { createId: f.createId, error: redact(error instanceof Error ? error.message : String(error)).slice(0, 400) });
      return;
    }
    const linkErrors: string[] = [];
    for (const l of f.links ?? []) {
      // From the new ticket: "relates to X", "is blocked by X" (Jira's own direction, as for his edits).
      await (l.direction === 'inward' ? this.d.writer.addLink(l.linkType, l.other, key) : this.d.writer.addLink(l.linkType, key, l.other)).catch((e: unknown) => linkErrors.push(e instanceof Error ? e.message : String(e)));
    }
    // Read back: are the links, the sprint and the parent there?
    const back = await this.d.store.get(key).catch(() => undefined);
    const fields = back?.issue.fields ?? {};
    const linked = new Set(((fields.issuelinks as Array<{ inwardIssue?: { key?: string }; outwardIssue?: { key?: string } }> | undefined) ?? []).map((l) => l.inwardIssue?.key ?? l.outwardIssue?.key));
    const sprintAsked = f.fields[this.d.sprintField()];
    const sprints = (fields[this.d.sprintField()] as Array<{ id?: number }> | undefined) ?? [];
    const parentAsked = (f.fields.parent as { key?: string } | undefined)?.key;
    const checks = {
      ...(f.links?.length ? { links: linkErrors.length === 0 && f.links.every((l) => linked.has(l.other)) } : {}),
      ...(sprintAsked !== undefined && sprintAsked !== null ? { sprint: sprints.some((s) => s.id === sprintAsked) } : {}),
      ...(parentAsked ? { parent: (fields.parent as { key?: string } | undefined)?.key === parentAsked } : {}),
    };
    this.d.log.append('jira', 'ticket.created', { createId: f.createId, key, ...(f.draftId ? { draftId: f.draftId } : {}), checks });
    if (f.draftId) this.d.log.append('orchestrator', 'ticket.draft_closed', { draftId: f.draftId, how: 'created', key, by: 'you' });
    await this.d.details.refresh(key);
  }

  /**
   * A draft by Elfoqsy or an agent: a card in the conversation that waits for him. It creates nothing; he presses
   * Create in Jira (or edits it first), or discards it.
   */
  draft(o: { by: 'elfoqsy' | 'agent'; runId?: string; conversationId?: string; draft: TicketDraft }): string {
    const draftId = `draft-${ulid().toLowerCase()}`;
    this.d.log.append('orchestrator', 'ticket.drafted', { draftId, by: o.by, ...(o.runId ? { runId: o.runId } : {}), ...(o.conversationId ? { conversationId: o.conversationId } : {}), draft: o.draft });
    return draftId;
  }

  discard(draftId: string, by: 'you' | 'tester'): void {
    this.d.log.append('orchestrator', 'ticket.draft_closed', { draftId, how: 'discarded', by });
  }
}

export type CreateFrame = PayloadOf<'ticket.created'>;
