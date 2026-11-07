import { readFileSync } from 'node:fs';
import type { AnyEnvelope, EventType, PayloadOf, Ticket } from '@elfoqsy/contracts';

const T0 = Date.parse('2026-10-08T14:06:00Z');

/** Builds envelopes with increasing seq; `at` is seconds after T0. */
export function eventFactory() {
  let seq = 0;
  return <T extends EventType>(type: T, payload: PayloadOf<T>, at = seq): AnyEnvelope =>
    ({
      seq: ++seq,
      id: `E${seq}`,
      ts: new Date(T0 + at * 1000).toISOString(),
      source: 'simulator',
      type,
      payload,
    }) as AnyEnvelope;
}

export const time = (at: number): number => T0 + at * 1000;

interface MockTicket extends Omit<Ticket, 'description'> {
  descriptionSummary: string;
}
interface MockClosed {
  key: string;
  summary: string;
  type: Ticket['type'];
  status: Ticket['status'];
  priority: Ticket['priority'];
  storyPoints: number | null;
}

/** The real sprint snapshot from mock/sprint-52.json, as Ticket values. */
export function mockSprint(): { open: Ticket[]; closed: Ticket[]; prs: Array<{ repo: string; number: number; ticket: string }> } {
  const raw = JSON.parse(readFileSync(new URL('../../../mock/sprint-52.json', import.meta.url), 'utf8')) as {
    openTickets: MockTicket[];
    closedTickets: MockClosed[];
    pullRequests: Array<{ repo: string; number: number; ticket: string }>;
  };
  return {
    open: raw.openTickets.map(({ descriptionSummary, ...t }) => {
      const { elfoqsyNote: _note, ...rest } = t as MockTicket & { elfoqsyNote?: string };
      return { ...rest, description: descriptionSummary };
    }),
    closed: raw.closedTickets.map((t) => ({
      ...t,
      board: 'SHOP',
      sprint: 'SHOP Sprint 52',
      sprintsCarried: 1,
      epic: null,
      reporter: '',
      created: '',
      updated: '',
      labels: [],
      linked: [],
      description: '',
    })),
    prs: raw.pullRequests,
  };
}
