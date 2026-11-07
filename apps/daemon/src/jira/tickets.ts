// The ticket view's data at start-up: the field map checked against Jira's field list (moves logged), the issue
// store everyone reads, and the service that keeps the open ticket and the changed sprint tickets fresh on the screens.
import type { PayloadOf } from '@elfoqsy/contracts';
import { fieldIdsOf, type JiraFieldIds } from '@elfoqsy/state';
import type { EventLog } from '../eventLog';
import { canonical } from '../sync/tracker';
import { TicketDetails } from '../sync/details';
import { TicketCreates } from '../sync/creates';
import { TicketEdits } from '../sync/edits';
import { JiraNews } from '../sync/news';
import { checkFieldMap, loadFieldMap, type FieldMap } from './fieldMap';
import { IssueStore, type JiraReader } from './issues';
import type { JiraWriter } from './writer';

export interface Tickets {
  store: IssueStore;
  details: TicketDetails;
  /** His edits and creates, when a writer is set up; drafts by Elfoqsy and the agents. */
  edits?: TicketEdits;
  creates?: TicketCreates;
  /** Jira news for the digest when he comes back. */
  news: JiraNews;
  /** The left screen opened a ticket: read it, and its project's picker options. */
  watch(key: string): void;
  ids: () => JiraFieldIds;
  /** An attachment of a ticket read so far, for the ticket view; null for any other id. */
  attachment(id: string): Promise<{ bytes: Buffer; mediaType: string; filename: string } | null>;
  stop(): void;
}

export async function startTickets(o: { log: EventLog; reader: JiraReader; writer?: JiraWriter; site: string; fieldsFile: string; pollMs?: number }): Promise<Tickets> {
  const store = new IssueStore(o.reader);
  let map: FieldMap = loadFieldMap(o.fieldsFile);
  let check: PayloadOf<'jira.fields'> = { fields: map, moved: [], missing: [] };
  try {
    const checked = checkFieldMap(map, await o.reader.fields());
    map = checked.map;
    check = { fields: checked.fields, moved: checked.moved, missing: checked.missing };
    for (const m of checked.moved) console.log(`Jira field ${m.name} moved from ${m.from} to ${m.to}.`);
    for (const m of checked.missing) console.warn(`Jira field ${m.name} (${m.id}) was not found, or more than one field has that name.`);
  } catch (error) {
    console.warn(`Jira's field list could not be read; using config/jira-fields.json as it is: ${error instanceof Error ? error.message : String(error)}`);
  }
  // Logged when it differs from what the log last said.
  const last = o.log.readFrom(0, 10_000_000, ['jira.fields']).at(-1);
  if (!last || canonical(last.payload) !== canonical(check)) o.log.append('orchestrator', 'jira.fields', check);
  const details = new TicketDetails({ log: o.log, store, site: o.site, ...(o.pollMs ? { pollMs: o.pollMs } : {}) });
  details.start();
  const ids = () => fieldIdsOf(map);
  const edits = o.writer ? new TicketEdits({ log: o.log, store, writer: o.writer, details, ids }) : undefined;
  const creates = o.writer ? new TicketCreates({ log: o.log, store, writer: o.writer, details, sprintField: () => ids().sprint }) : undefined;
  const news = new JiraNews({ log: o.log, reader: o.reader });
  return {
    store,
    details,
    ...(edits ? { edits } : {}),
    ...(creates ? { creates } : {}),
    news,
    watch(key) {
      details.watch(key);
      void edits?.optionsFor(key).catch((error: unknown) => console.warn(`Jira options for ${key}: ${error instanceof Error ? error.message : String(error)}`));
    },
    ids,
    async attachment(id) {
      // An attachment of a ticket read since start, or of one the log has (the screens show those after a restart).
      const file = /^\d+$/.test(id) ? (store.attachmentMeta(id) ?? details.attachmentMeta(id)) : undefined;
      if (!file) return null;
      const read = await o.reader.attachment(id);
      return { bytes: read.bytes, mediaType: file.mimeType ?? read.mediaType, filename: file.filename ?? `attachment-${id}` };
    },
    stop: () => {
      details.close();
      edits?.close();
    },
  };
}
