// The one connection to the daemon. Replays the log on load, resumes from the last seq after a
// reconnect, and starts over from seq 0 when the daemon's log was recreated (logId changed).
// UI components never talk to the daemon directly: they read this store and call say, guide and answer.
// Opened with ?tester, every frame is marked test, so nothing typed while testing is logged as alex's.
import type { Intent, JiraChange, ClientFrame, DaemonMode, DelegationCategory, DelegationSetting, Layout, ServerFrame } from '@elfoqsy/contracts';
import { fold, initialState, savedLayout, type WorkspaceState } from '@elfoqsy/state';

export interface Connection {
  status: 'connecting' | 'replaying' | 'live' | 'down';
  /** When the socket went down, once it has stayed down past a short grace; null while connected. */
  offlineSince: number | null;
  mode: DaemonMode | null;
  jiraSite: string;
  /** Add to Date.now to get the daemon's clock, which event timestamps use. */
  clockOffset: number;
  /** The daemon's last refusal of something sent from this screen, and when (Date.now). */
  notice: { message: string; at: number } | null;
}

export interface Snapshot {
  state: WorkspaceState;
  connection: Connection;
}

/** The part of a WebSocket the stream uses, so tests can hand it a fake. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  onmessage: ((message: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
}

const OPEN = 1; // WebSocket.OPEN
const RETRY_MS = [500, 1000, 2000, 5000];
/** A daemon restart takes about a second; only call it offline when the socket stays down longer. */
export const OFFLINE_GRACE_MS = 2000;

export class EventStream {
  private snapshot: Snapshot = {
    state: initialState,
    connection: { status: 'connecting', offlineSince: null, mode: null, jiraSite: '', clockOffset: 0, notice: null },
  };
  private readonly listeners = new Set<() => void>();
  private socket: SocketLike | undefined;
  private logId: string | undefined;
  private attempts = 0;
  private downAt: number | null = null;
  private offlineTimer: ReturnType<typeof setTimeout> | undefined;
  private relayListener: ((intent: Intent) => void) | undefined;

  constructor(
    private readonly url: string,
    private readonly createSocket: (url: string) => SocketLike = (u) => new WebSocket(u) as unknown as SocketLike,
    private readonly options: { tester?: boolean } = {},
  ) {}

  start(): void {
    const ws = this.createSocket(this.url);
    this.socket = ws;
    ws.onmessage = (message) => this.receive(JSON.parse(String(message.data)) as ServerFrame);
    ws.onclose = () => {
      if (this.socket !== ws) return;
      this.goneDown();
      const delay = RETRY_MS[Math.min(this.attempts++, RETRY_MS.length - 1)];
      setTimeout(() => this.start(), delay);
    };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): Snapshot => this.snapshot;

  /** The daemon's current time in ms, aligned with event timestamps. */
  now = (): number => Date.now() + this.snapshot.connection.clockOffset;

  /** A message to Elfoqsy; without a conversation it starts a new one. Attachments are uploaded first. */
  say(text: string, conversationId?: string, attachmentIds: string[] = []): boolean {
    return this.send({
      t: 'say',
      text,
      ...(conversationId ? { conversationId } : {}),
      ...(attachmentIds.length ? { attachmentIds } : {}),
      ...this.mark(),
    });
  }

  /** Guidance typed into an agent's pane. */
  guide(runId: string, text: string): boolean {
    return this.send({ t: 'guide', runId, text, ...this.mark() });
  }

  /** Pause and resume from a pane; guidance (guide) pauses, gives it and resumes as one action. */
  pause(runId: string): boolean {
    return this.send({ t: 'pause', runId, ...this.mark() });
  }

  resume(runId: string): boolean {
    return this.send({ t: 'resume', runId, ...this.mark() });
  }

  /** A CI failure on an open PR acknowledged from the ticket view, until its next CI result. */
  dismissCi(repo: string, pr: number): boolean {
    return this.send({ t: 'dismiss_ci', repo, pr, ...this.mark() });
  }

  /** A failed run acknowledged from its pane: no longer broken, still in history. */
  dismiss(runId: string): boolean {
    return this.send({ t: 'dismiss', runId, ...this.mark() });
  }

  /** scope ticket: "Allow for this ticket", on an approval that offers it. */
  /** precedent: "Let Elfoqsy decide this kind next time" was ticked. */
  answer(approvalId: string, decision: 'approved' | 'denied' | 'answered', answer?: string, scope?: 'once' | 'ticket', precedent?: boolean): boolean {
    return this.send({ t: 'answer', approvalId, decision, ...(answer ? { answer } : {}), ...(scope ? { scope } : {}), ...(precedent ? { precedent: true as const } : {}), ...this.mark() });
  }

  /** Another option for one of Elfoqsy's answers to an agent: the agent is told. */
  changeDecision(decisionId: string, to: string): boolean {
    return this.send({ t: 'change_decision', decisionId, to, ...this.mark() });
  }

  /** His delegation setting for a category, a precedent removed, how many agents work at once. */
  setDelegation(category: DelegationCategory, setting: DelegationSetting): boolean {
    return this.send({ t: 'delegation', category, setting, ...this.mark() });
  }

  removePrecedent(precedentId: string): boolean {
    return this.send({ t: 'remove_precedent', precedentId, ...this.mark() });
  }

  setMaxAgents(value: number): boolean {
    return this.send({ t: 'setting', key: 'maxAgents', value, ...this.mark() });
  }

  /** The ticket open on the left screen: the daemon reads it from Jira at once and while this is renewed. */
  watchTicket(key: string): boolean {
    return this.send({ t: 'watch_ticket', key });
  }

  /** His edit of a ticket: straight to Jira. Its outcome comes back under editId (state.jiraEdits). */
  jiraEdit(editId: string, key: string, change: JiraChange): boolean {
    return this.send({ t: 'jira_edit', editId, key, change, ...this.mark() });
  }

  /** The transitions Jira offers on a ticket now, for its status menu (state.transitions). */
  jiraTransitions(key: string): boolean {
    return this.send({ t: 'jira_transitions', key });
  }

  /** Tickets by key or summary words, in the sprint or not (state.ticketSearch). */
  searchTickets(query: string): boolean {
    return this.send({ t: 'search_tickets', query });
  }

  /** Jira's create screen for a project, and for one of its types (state.createMeta); his pickers' options come too. */
  jiraCreatemeta(project: string, typeId?: string): boolean {
    return this.send({ t: 'jira_createmeta', project, ...(typeId ? { typeId } : {}) });
  }

  /**
   * His Create: the only way a ticket is created, from his form or a draft card's "Create in Jira". The outcome
   * comes back under createId (state.created). The tester's is refused by the daemon.
   */
  jiraCreate(c: { createId: string; project: string; typeId: string; fields: Record<string, unknown>; links?: Array<{ linkType: string; direction: 'inward' | 'outward'; other: string }>; draftId?: string }): boolean {
    return this.send({ t: 'jira_create', ...c, ...this.mark() });
  }

  /** He ticked "I've read the narrative" for a run (N1): recorded as his, or as the tester's in a tester window. */
  narrativeRead(runId: string): boolean {
    return this.send({ t: 'narrative_read', runId, ...this.mark() });
  }

  /** "Mark ready for review" on the narrative's hand-back card (N1): the daemon refuses it until he has ticked. */
  markReady(runId: string): boolean {
    return this.send({ t: 'mark_ready', runId, ...this.mark() });
  }

  /**
   * How the two screens are arranged (P2), saved in the daemon so both windows and a reload agree; null: no layout saved.
   * Today's arrangement is no layout, so that is what is sent for it.
   */
  setLayout(layout: Layout | null): boolean {
    return this.send({ t: 'layout_set', layout: savedLayout(layout), ...this.mark() });
  }

  /** An intent for the panes of the other window (P2), passed on by the daemon and kept nowhere. */
  relay(intent: Intent): boolean {
    return this.send({ t: 'relay', intent });
  }

  /** What the other window's panes ask of this one's (P2). */
  onRelay(listener: ((intent: Intent) => void) | undefined): void {
    this.relayListener = listener;
  }

  /** A draft by Elfoqsy or an agent, discarded. */
  discardDraft(draftId: string): boolean {
    return this.send({ t: 'discard_draft', draftId, ...this.mark() });
  }

  /** Open the digest of what Elfoqsy decided since his last one: in this conversation, or Today's without one. */
  digest(conversationId?: string): boolean {
    return this.send({ t: 'digest', ...(conversationId ? { conversationId } : {}), ...this.mark() });
  }

  /** Undo a recorded change from a pane: the orchestrator puts it back through the same proxy and tier rules. */
  undo(recordId: string): boolean {
    return this.send({ t: 'undo', recordId, ...this.mark() });
  }

  /** Opened with ?tester: what only alex may do (creating a ticket, editing Jira) is not offered. */
  get tester(): boolean {
    return !!this.options.tester;
  }

  private mark(): { test?: true } {
    return this.options.tester ? { test: true } : {};
  }

  private send(frame: ClientFrame): boolean {
    if (this.socket?.readyState !== OPEN) return false;
    this.socket.send(JSON.stringify(frame));
    return true;
  }

  private goneDown(): void {
    this.update({ connection: { ...this.snapshot.connection, status: 'down' } });
    if (this.downAt !== null) return; // still down from an earlier attempt
    const since = Date.now();
    this.downAt = since;
    this.offlineTimer = setTimeout(() => {
      if (this.downAt === since) this.update({ connection: { ...this.snapshot.connection, offlineSince: since } });
    }, OFFLINE_GRACE_MS);
  }

  private receive(frame: ServerFrame): void {
    switch (frame.t) {
      case 'welcome': {
        this.attempts = 0;
        this.downAt = null;
        clearTimeout(this.offlineTimer);
        const sameLog = frame.logId === this.logId;
        this.logId = frame.logId;
        const state = sameLog ? this.snapshot.state : initialState;
        this.update({
          state,
          connection: {
            status: 'replaying',
            offlineSince: null,
            mode: frame.mode,
            jiraSite: frame.jiraSite,
            clockOffset: Date.parse(frame.serverTime) - Date.now(),
            notice: null,
          },
        });
        this.send({ t: 'hello', fromSeq: state.seq });
        break;
      }
      case 'events':
        this.update({ state: frame.events.reduce(fold, this.snapshot.state) });
        break;
      case 'live':
        this.update({ connection: { ...this.snapshot.connection, status: 'live' } });
        break;
      case 'relay':
        this.relayListener?.(frame.intent);
        break;
      case 'error':
        console.warn(`daemon: ${frame.message}`);
        this.update({ connection: { ...this.snapshot.connection, notice: { message: frame.message, at: Date.now() } } });
        break;
    }
  }

  private update(patch: Partial<Snapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
}
