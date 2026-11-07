// Elfoqsy's own web (alex, 19 October): WebSearch and WebFetch in her conversation session, so a fact about the world (a score, a
// line-up, a release date) is something she looks up, not something she says she cannot. Read-only by what they are, and held to what the
// agents' web is held to: the request is checked before it leaves (a secret, one of his hosts, a repository or local path, code, encoded
// data: `checkOutbound`, and for a fetch the host's addresses too), the redactor sees what is logged, and every call is an action in the log.
// The built-in tools run in her own Claude Code process, so this hook is the only thing between a call and the web.
import type { HookCallback, HookInput, Options } from '@anthropic-ai/claude-agent-sdk';
import type { EventLog } from '../eventLog';
import { checkOutbound, checkOutboundResolved, redact, type OutboundContext, type OutboundVerdict } from '../redact';
import { ulid } from '../ulid';

/** The stand-in run her own actions are logged under (the same as her reads of the environments). */
const ELFOQSY_RUN = 'elfoqsy';

/** The built-in tools her session is offered for it. */
export const WEB_TOOLS = ['WebSearch', 'WebFetch'] as const;

const text = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value ?? ''));

/** What a refused request is told, without the text that matched. */
const refused = (reason: string): string =>
  `Not sent: ${reason} Nothing of alex's (secrets, internal hosts, repository paths, code, encoded data) may leave through the web. Ask without it.`;

export interface HerWebDeps {
  log: EventLog;
  outbound: OutboundContext;
}

/**
 * The hooks of her session for WebSearch and WebFetch: the check before the call, `action.classified` for it (decision run, or refuse
 * with the rule's reason), and `action.finished` when it ends. Nothing else is hooked: her other tools are the orchestrator's own.
 */
export function herWebHooks(d: HerWebDeps): NonNullable<Options['hooks']> {
  /** The action each allowed call is, by tool use id, for its end. */
  const open = new Map<string, { actionId: string; at: number }>();

  const before: HookCallback = async (input: HookInput) => {
    if (input.hook_event_name !== 'PreToolUse' || !(WEB_TOOLS as readonly string[]).includes(input.tool_name)) return {};
    const args = (input.tool_input ?? {}) as Record<string, unknown>;
    const fetching = input.tool_name === 'WebFetch';
    const target = fetching ? { url: String(args.url ?? '') } : { query: String(args.query ?? '') };
    const verdict: OutboundVerdict = fetching ? await checkOutboundResolved(target, d.outbound) : checkOutbound(target, d.outbound);
    const actionId = ulid();
    const summary = redact(fetching ? `fetch ${target.url}` : `search the web for "${target.query}"`).slice(0, 300);
    d.log.append('orchestrator', 'action.classified', {
      actionId,
      runId: ELFOQSY_RUN,
      toolUseId: input.tool_use_id,
      proxy: 'web',
      kind: fetching ? 'web.fetch' : 'web.search',
      tier: 0,
      summary,
      decision: verdict.ok ? 'run' : 'refuse',
      reason: verdict.ok ? 'A read of the public web, with nothing of his in the request.' : verdict.reason,
    });
    if (verdict.ok) open.set(input.tool_use_id, { actionId, at: Date.now() });
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse' as const,
        permissionDecision: verdict.ok ? ('allow' as const) : ('deny' as const),
        ...(verdict.ok ? {} : { permissionDecisionReason: refused(verdict.reason) }),
      },
    };
  };

  const finish = (ok: boolean): HookCallback => async (input: HookInput) => {
    if (input.hook_event_name !== 'PostToolUse' && input.hook_event_name !== 'PostToolUseFailure') return {};
    const call = open.get(input.tool_use_id);
    if (!call) return {};
    open.delete(input.tool_use_id);
    const said = input.hook_event_name === 'PostToolUse' ? text(input.tool_response) : input.error;
    d.log.append('orchestrator', 'action.finished', {
      actionId: call.actionId,
      runId: ELFOQSY_RUN,
      ok,
      outputSummary: redact(said).slice(0, 300),
      durationMs: Date.now() - call.at,
    });
    return {};
  };

  return {
    PreToolUse: [{ matcher: WEB_TOOLS.join('|'), hooks: [before] }],
    PostToolUse: [{ matcher: WEB_TOOLS.join('|'), hooks: [finish(true)] }],
    PostToolUseFailure: [{ matcher: WEB_TOOLS.join('|'), hooks: [finish(false)] }],
  };
}
