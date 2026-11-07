// Stepping in on a run from its pane or through Elfoqsy: pause, resume, and guidance (which pauses, gives
// it and resumes as one action). The orchestrator does it for live runs, the simulator for its own.
import type { Actor } from '@elfoqsy/contracts';
import type { ControlResult } from './run';

export interface RunControl {
  pause(runId: string, by: Actor, reason?: string): ControlResult;
  resume(runId: string, by: Actor, reason?: string): ControlResult;
  guide(runId: string, text: string, by: Actor): ControlResult;
}

export type { ControlResult };
