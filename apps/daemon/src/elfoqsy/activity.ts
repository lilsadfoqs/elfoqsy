// What Elfoqsy is doing, in plain lines for her thinking indicator: one per tool call she makes in a conversation, and
// what it reached, for its tile. Housekeeping (her reply's blocks, the conversation's title) is not shown.
import type { ActivityTool } from '@elfoqsy/contracts';
import type { WorkspaceState } from '@elfoqsy/state';
import type { ToolName } from './tools';

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const cut = (t: string, max = 80): string => (t.length > max ? `${t.slice(0, max - 1)}…` : t);
const quoted = (t: string): string => (t ? ` "${cut(t, 60)}"` : '');

const MODELS: Record<string, string> = { haiku: 'Haiku 5.5', sonnet: 'Sonnet 5.5', opus: 'Opus 5.5' };

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
/** The value after a flag, as "--flag value" or "--flag=value". */
const flagValue = (words: string[], flag: string): string | undefined => {
  const i = words.indexOf(flag);
  if (i >= 0 && words[i + 1] !== undefined) return words[i + 1];
  return words.find((w) => w.startsWith(`${flag}=`))?.slice(flag.length + 1);
};

/** The line and tile for one of her tool calls; null for housekeeping she does not show. */
export function activityLine(name: ToolName, args: Record<string, unknown>, state: WorkspaceState): { tool: ActivityTool; text: string } | null {
  const agent = (runId: unknown): string => {
    const run = state.runs[str(runId)];
    return run ? `Agent ${run.agentNumber}` : 'an agent';
  };
  switch (name) {
    case 'show':
    case 'name_conversation':
      return null;
    case 'write_ability':
      return { tool: 'workspace', text: `${args.update ? 'Update' : 'Write'} the ability "${cut(str(args.title), 60)}"` };
    case 'list_sprint':
      return { tool: 'jira', text: 'Read the sprint' };
    case 'get_ticket':
      return { tool: 'jira', text: `Read ${str(args.key).toUpperCase() || 'the ticket'}` };
    case 'spawn_agent':
      return { tool: 'agent', text: `Start an agent on ${str(args.ticketKey).toUpperCase()}` };
    case 'list_runs':
      return { tool: 'workspace', text: 'Look at the agents' };
    case 'get_run':
      return { tool: 'workspace', text: `Read what ${agent(args.runId)} did` };
    case 'cancel_run':
      return { tool: 'agent', text: `Stop ${agent(args.runId)}` };
    case 'dismiss_run':
      return { tool: 'agent', text: `Dismiss ${agent(args.runId)}` };
    case 'tell_agent':
      return { tool: 'agent', text: `Pass your message to ${agent(args.runId)}` };
    case 'pause_run':
      return { tool: 'agent', text: `Pause ${agent(args.runId)}` };
    case 'resume_run':
      return { tool: 'agent', text: `Resume ${agent(args.runId)}` };
    case 'read_events':
      return { tool: 'workspace', text: 'Read what happened since' };
    case 'remember':
      return { tool: 'memory', text: 'Save it to memory' };
    case 'save_rule':
      return { tool: 'memory', text: 'Save the rule' };
    case 'recall':
      return { tool: 'memory', text: `Look in my memory${quoted(str(args.text) || str(args.ticket))}` };
    case 'forget':
      return { tool: 'memory', text: 'Forget it' };
    case 'lookup_jira':
      return { tool: 'jira', text: str(args.key) ? `Read ${str(args.key).toUpperCase()} and its comments` : `Search Jira${quoted(str(args.jql))}` };
    case 'lookup_github': {
      const repo = str(args.repo).split('/').at(-1) || 'GitHub';
      const what = str(args.what);
      const text =
        what === 'pr' ? `Read ${repo} #${String(args.number ?? '')}` : what === 'prs' ? `Read ${repo}'s pull requests` : what === 'commits' ? `Read ${repo}'s commits` : what === 'checks' ? `Read CI on ${repo}` : `Search ${repo}${quoted(str(args.query))}`;
      return { tool: 'github', text };
    }
    case 'lookup_confluence':
      return { tool: 'confluence', text: str(args.pageId) ? 'Read a Confluence page' : `Search Confluence${quoted(str(args.cql))}` };
    case 'lookup_code':
      return { tool: 'code', text: str(args.path) ? `Read ${cut(str(args.path), 60)}` : `Search ${str(args.repo).split('/').at(-1) || 'the code'}${quoted(str(args.text))}` };
    case 'logs':
      return { tool: 'logs', text: `Read the ${str(args.environment) || str(args.application) || 'non-prod'} logs${quoted(str(args.query))}` };
    case 'kube': {
      const words = strings(args.args);
      const context = flagValue(words, '--context');
      const [verb = 'get', ...rest] = words.filter((w, i) => !w.startsWith('-') && words[i - 1] !== '--context' && words[i - 1] !== '-n' && words[i - 1] !== '--namespace');
      const what = cut(rest.join(' '), 50);
      const on = context ? ` on ${cut(context.replace(/^arn:aws:eks:[^/]*\/(.*)$/, '$1'), 30)}` : '';
      const text = verb === 'logs' ? `Read the logs of ${what || 'a pod'}${on}` : verb === 'get' ? `List ${what || 'resources'}${on}` : verb === 'describe' ? `Describe ${what || 'a resource'}${on}` : `Ask kubectl: ${cut(`${verb} ${what}`.trim(), 50)}${on}`;
      return { tool: 'kube', text };
    }
    case 'aws': {
      const words = strings(args.args);
      const profile = flagValue(words, '--profile');
      const call = words.filter((w, i) => !w.startsWith('-') && words[i - 1] !== '--profile' && words[i - 1] !== '--region').slice(0, 2).join(' ');
      return { tool: 'aws', text: `Ask AWS: ${cut(call, 50)}${profile ? ` (${cut(profile, 30)})` : ''}` };
    }
    case 'gh': {
      const words = strings(args.args);
      const repo = flagValue(words, '--repo') ?? flagValue(words, '-R');
      const call = words.filter((w, i) => !w.startsWith('-') && words[i - 1] !== '--repo' && words[i - 1] !== '-R').slice(0, 3).join(' ');
      return { tool: 'github', text: `Ask GitHub: ${cut(call, 50)}${repo ? ` (${cut(repo.split('/').at(-1) ?? repo, 30)})` : ''}` };
    }
    case 'investigate':
      return { tool: 'agent', text: `Send an investigator, ${MODELS[str(args.model)] ?? str(args.model)} ${str(args.effort)}` };
    case 'close_out':
      return { tool: 'workspace', text: `Close out ${str(args.ticket).toUpperCase()}` };
    case 'write_handoff':
      return { tool: 'workspace', text: `Write the handoff for ${str(args.ticket).toUpperCase()}` };
    case 'dismiss_ci':
      return { tool: 'github', text: `Dismiss CI on ${str(args.repo).split('/').at(-1)} #${String(args.number ?? '')}` };
    case 'record_review':
      return { tool: 'workspace', text: 'Record the weekly review' };
    case 'start_task':
      return { tool: 'agent', text: `Start a task agent, ${MODELS[str(args.model)] ?? str(args.model)} ${str(args.effort)}: ${cut(str(args.name), 40)}` };
    case 'delegation':
      return { tool: 'workspace', text: 'Read your delegation settings' };
    case 'set_delegation':
      return { tool: 'workspace', text: 'Change a delegation setting' };
    case 'remove_precedent':
      return { tool: 'workspace', text: 'Remove a precedent' };
    case 'set_max_agents':
      return { tool: 'workspace', text: `Let ${String(args.value ?? '')} agents work at once` };
    case 'decisions':
      return { tool: 'workspace', text: 'Read what I decided' };
    case 'draft_ticket':
      return { tool: 'jira', text: `Draft a ticket: ${cut(str(args.summary), 60)}` };
    case 'jira_write': {
      const key = str(args.key).toUpperCase();
      const what = str(args.action) === 'comment' ? `Comment on ${key}` : str(args.action) === 'transition' ? `Move ${key} to ${str(args.to)}` : `Set ${str(args.field)} on ${key}`;
      return { tool: 'jira', text: what };
    }
  }
}
