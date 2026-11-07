// Tool calls and their results in plain words, for an agent's transcript: the command, the file, a few lines
// of output. Everything here ends up in the event log, which redacts it again.
import { posix } from 'node:path';
import { redact } from '../redact';

const MAX_TITLE = 200;
const OUTPUT_LINES = 4;
const MAX_LINE = 240;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const cut = (text: string, max = MAX_TITLE): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** A path as the agent sees it: relative to its run folder when inside it. */
function shortPath(path: string, runRoot: string): string {
  if (!path) return '';
  const rel = posix.relative(runRoot, path);
  return rel && !rel.startsWith('..') && !posix.isAbsolute(rel) ? rel : path;
}

/** The repository folder a call ran in: the first folder under the run folder, if any. */
export function whereIn(runRoot: string, cwd: string): string | undefined {
  const rel = posix.relative(runRoot, cwd);
  if (!rel || rel.startsWith('..') || posix.isAbsolute(rel)) return undefined;
  return rel.split('/')[0] || undefined;
}

/** The call in plain words: the command, the file, the pattern, the sub-agent's task. */
export function toolTitle(tool: string, input: Record<string, unknown>, runRoot: string): string {
  switch (tool) {
    case 'Bash':
      return cut(str(input.command).split('\n')[0]!.trim());
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return cut(shortPath(str(input.file_path), runRoot));
    case 'NotebookEdit':
      return cut(shortPath(str(input.notebook_path), runRoot));
    case 'Grep':
      return cut(`"${str(input.pattern)}"${input.path ? ` in ${shortPath(str(input.path), runRoot)}` : ''}`);
    case 'Glob':
      return cut(`${str(input.pattern)}${input.path ? ` in ${shortPath(str(input.path), runRoot)}` : ''}`);
    case 'Agent':
    case 'Task':
      return cut(str(input.description) || str(input.subagent_type));
    case 'WebFetch':
      return cut(str(input.url));
    case 'WebSearch':
      return cut(str(input.query));
    case 'mcp__run__kube':
    case 'mcp__run__aws':
    case 'mcp__run__gh':
    case 'mcp__run__docker':
      // A proxy call: its arguments as they would be typed after the program's name.
      return cut(Array.isArray(input.args) ? (input.args as unknown[]).map(String).join(' ') : '');
    case 'mcp__run__jira':
    case 'mcp__run__confluence': {
      const target = ['key', 'pageId', 'jql', 'cql', 'project', 'space'].map((k) => str(input[k])).find(Boolean);
      return cut(`${str(input.action)}${target ? ` ${target}` : ''}`);
    }
    case 'mcp__run__logs':
      return cut(`${str(input.environment) || str(input.application) || 'non-prod'}: ${str(input.query)}`);
    case 'mcp__run__shop':
      return cut(`${str(input.command)} ${str(input.environment)}`);
    case 'mcp__run__report_verdict':
      return cut(`${str(input.verdict)}${input.verdict === 'VALID' ? (input.reproduced ? ', reproduced' : ', not reproduced yet') : ''}`);
    case 'mcp__run__declare_inputs':
      return cut(Array.isArray(input.classes) ? `${input.classes.length} input class${input.classes.length === 1 ? '' : 'es'}: ${(input.classes as unknown[]).map(String).join('; ')}` : '');
    case 'mcp__run__report_hypothesis':
      return cut(`${str(input.status)}: ${str(input.text)}`);
    case 'mcp__run__report_finding':
      return cut(str(input.summary));
    case 'mcp__run__ask_decision': // older logs
      return cut(str(input.question));
    case 'mcp__run__record_assumption':
      return cut(`${input.flag ? `${str(input.flag)}: ` : ''}${str(input.text)}`);
    case 'mcp__run__deliver':
      return cut(`${str(input.kind)}: ${str(input.title)}`);
    default: {
      // The run's own tools (mcp__run__begin_step and so on): their most telling argument.
      const first = ['name', 'command', 'goal', 'question', 'title', 'step', 'check'].map((k) => str(input[k])).find(Boolean);
      return cut(first ?? '');
    }
  }
}

const lastLines = (text: string, n = OUTPUT_LINES): string =>
  text
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim())
    .slice(-n)
    .map((l) => cut(l, MAX_LINE))
    .join('\n');

const firstLines = (text: string, n = OUTPUT_LINES): string =>
  text
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim())
    .slice(0, n)
    .map((l) => cut(l, MAX_LINE))
    .join('\n');

/**
 * What a call produced: a few lines of output, and for edits a "+a −b" note for the call's own line.
 * Best effort: tool results are not typed, so anything unexpected becomes an empty summary.
 */
/** An Edit's hunks for its card: line numbers and lines, redacted, at most DIFF_LINES lines in all. */
export type Diff = { hunks: Array<{ oldStart: number; newStart: number; lines: string[] }> };
const DIFF_LINES = 80;

function diffOf(patch: unknown): Diff | undefined {
  if (!Array.isArray(patch)) return undefined;
  const hunks: Diff['hunks'] = [];
  let left = DIFF_LINES;
  for (const h of patch.slice(0, 20) as Array<{ oldStart?: unknown; newStart?: unknown; lines?: unknown }>) {
    if (left <= 0 || typeof h.oldStart !== 'number' || typeof h.newStart !== 'number' || !Array.isArray(h.lines)) continue;
    const lines = (h.lines as unknown[]).map((l) => cut(redact(String(l)), 400)).slice(0, left);
    left -= lines.length;
    hunks.push({ oldStart: h.oldStart, newStart: h.newStart, lines });
  }
  return hunks.length ? { hunks } : undefined;
}

export function summarizeToolResult(tool: string, result: { response?: unknown; error?: string }): { outputSummary: string; stats?: string; diff?: Diff } {
  if (result.error !== undefined) return { outputSummary: firstLines(result.error) };
  const r = (result.response ?? {}) as Record<string, unknown>;
  try {
    switch (tool) {
      case 'Bash': {
        if (r.backgroundTaskId) return { outputSummary: 'running in the background' };
        const out = lastLines([str(r.stdout), str(r.stderr)].filter(Boolean).join('\n'));
        return { outputSummary: out || (r.interrupted ? 'interrupted' : 'done') };
      }
      case 'Edit':
      case 'MultiEdit': {
        const hunks = Array.isArray(r.structuredPatch) ? (r.structuredPatch as Array<{ lines?: unknown }>) : [];
        const lines = hunks.flatMap((h) => (Array.isArray(h.lines) ? (h.lines as unknown[]).map(String) : []));
        const added = lines.filter((l) => l.startsWith('+')).length;
        const removed = lines.filter((l) => l.startsWith('-')).length;
        const changed = lines.filter((l) => l.startsWith('+') || l.startsWith('-')).slice(0, OUTPUT_LINES).map((l) => cut(l, MAX_LINE));
        const diff = diffOf(r.structuredPatch);
        return { outputSummary: changed.join('\n'), ...(lines.length ? { stats: `+${added} −${removed}` } : {}), ...(diff ? { diff } : {}) };
      }
      case 'Write': {
        const content = str(r.content);
        return { outputSummary: '', ...(content ? { stats: `${content.split('\n').length} lines` } : {}) };
      }
      case 'Read': {
        const file = (r.file ?? {}) as Record<string, unknown>;
        const n = typeof file.numLines === 'number' ? file.numLines : undefined;
        return { outputSummary: n !== undefined ? `${n} lines` : '' };
      }
      case 'Grep': {
        if (typeof r.numMatches === 'number') return { outputSummary: `${r.numMatches} match${r.numMatches === 1 ? '' : 'es'}` };
        const files = Array.isArray(r.filenames) ? (r.filenames as unknown[]).map(String) : [];
        return { outputSummary: files.length ? firstLines(files.join('\n'), 3) : str(r.content) ? lastLines(str(r.content), 3) : 'no matches' };
      }
      case 'Glob': {
        const files = Array.isArray(r.filenames) ? r.filenames.length : typeof r.numFiles === 'number' ? r.numFiles : 0;
        return { outputSummary: `${files} file${files === 1 ? '' : 's'}` };
      }
      case 'Agent':
      case 'Task': {
        const content = Array.isArray(r.content) ? (r.content as Array<{ text?: unknown }>).map((c) => str(c.text)).join('\n') : str(r.result);
        return { outputSummary: firstLines(content.replace(/RESULT:.*$/is, ''), 1) };
      }
      default: {
        if (typeof result.response === 'string') return { outputSummary: firstLines(result.response, 2) };
        const content = Array.isArray(r.content) ? (r.content as Array<{ text?: unknown }>).map((c) => str(c.text)).join('\n') : '';
        return { outputSummary: firstLines(content, 2) };
      }
    }
  } catch {
    return { outputSummary: '' };
  }
}
