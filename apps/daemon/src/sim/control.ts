// The simulator's agents, stepped in on from a pane: the events a live run would log, which the
// simulator reacts to (it stops a paused agent, and re-plans after guidance).
import type { Actor } from '@elfoqsy/contracts';
import { isRunActive, type WorkspaceState } from '@elfoqsy/state';
import type { ControlResult, RunControl } from '../agents/control';
import type { EventLog } from '../eventLog';

export class SimControl implements RunControl {
  constructor(
    private readonly log: EventLog,
    private readonly state: () => WorkspaceState,
  ) {}

  pause(runId: string, by: Actor, reason?: string): ControlResult {
    const run = this.state().runs[runId];
    if (!run || !isRunActive(run) || run.state === 'failed') return { error: 'ended', message: 'That agent is not running.' };
    if (run.paused) return { error: 'already_paused', message: `Agent ${run.agentNumber} is already paused.` };
    if (run.state === 'waiting_for_you') return { error: 'waiting', message: `Agent ${run.agentNumber} is waiting for an answer to its question; answer it first.` };
    this.log.append('orchestrator', 'run.paused', { runId, by, ...(reason ? { reason } : {}) });
    return { ok: true };
  }

  resume(runId: string, by: Actor, reason?: string): ControlResult {
    const run = this.state().runs[runId];
    if (!run?.paused) return { error: 'not_paused', message: 'That agent is not paused.' };
    this.log.append('orchestrator', 'run.resumed', { runId, by, ...(reason ? { reason } : {}) });
    return { ok: true };
  }

  guide(runId: string, text: string, by: Actor): ControlResult {
    const run = this.state().runs[runId];
    if (!run || !isRunActive(run) || run.state === 'failed') return { error: 'ended', message: 'That agent is not running.' };
    if (!run.paused) {
      const paused = this.pause(runId, by, 'To give guidance');
      if ('error' in paused) return paused;
    }
    this.log.append('orchestrator', 'run.guidance', { runId, text, by });
    return this.resume(runId, by);
  }
}
