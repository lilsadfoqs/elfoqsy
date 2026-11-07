// Dev tool: prints the daemon's event stream. `pnpm --filter @elfoqsy/daemon tail [--from <seq>]`
import WebSocket from 'ws';
import type { AnyEnvelope, ServerFrame } from '@elfoqsy/contracts';

const fromArg = process.argv.indexOf('--from');
const fromSeq = fromArg >= 0 ? Number(process.argv[fromArg + 1] ?? 0) : 0;
const port = Number(process.env.DAEMON_PORT ?? 4317);

function describe(e: AnyEnvelope): string {
  switch (e.type) {
    case 'ticket.synced':
      return `${e.payload.ticket.key} ${e.payload.ticket.status}`;
    case 'pr.synced':
      return `${e.payload.pr.repo} #${e.payload.pr.number} ${e.payload.pr.state} (${e.payload.pr.ticket})`;
    case 'run.created':
      return `agent ${e.payload.agentNumber} on ${e.payload.ticket} (${e.payload.runId})`;
    case 'run.goal_declared':
      return `${e.payload.runId} goal (rev ${e.payload.revision}): ${e.payload.goal}`;
    case 'run.step_begun':
      return `${e.payload.runId} step ${e.payload.stepIndex + 1}: ${e.payload.name} (${e.payload.why})`;
    case 'run.step_ended':
      return `${e.payload.runId} step ${e.payload.stepIndex + 1} ${e.payload.outcome}${e.payload.note ? `: ${e.payload.note}` : ''}`;
    case 'run.heartbeat':
      return `${e.payload.runId} heartbeat at ${e.payload.step}, ${e.payload.progress}: ${e.payload.sinceLast}`;
    case 'tool.called':
      return `${e.payload.runId ?? 'elfoqsy'} ${e.payload.tool} ${e.payload.title ?? e.payload.inputSummary}${e.payload.allowed ? '' : ' (denied)'}`;
    case 'tool.finished':
      return `${e.payload.runId} ${e.payload.toolUseId} ${e.payload.ok ? 'ok' : 'failed'}${e.payload.stats ? ` ${e.payload.stats}` : ''}`;
    case 'run.state_changed':
      return `${e.payload.runId} ${e.payload.state}${e.payload.reason ? `: ${e.payload.reason}` : ''}`;
    case 'run.note':
      return `${e.payload.runId}: ${e.payload.text}`;
    case 'subagent.started':
      return `${e.payload.subagentId} (${e.payload.model}, ${e.payload.effort}): ${e.payload.task}`;
    case 'subagent.finished':
      return `${e.payload.subagentId} ${e.payload.outcome}, ${e.payload.toolCalls} tools, ${e.payload.tokens} tokens: ${e.payload.result}`;
    case 'approval.requested':
      return `${e.payload.approvalId} (${e.payload.kind}): ${e.payload.question}`;
    case 'approval.resolved':
      return `${e.payload.approvalId} ${e.payload.decision}${e.payload.answer ? `: ${e.payload.answer}` : ''}`;
    case 'sync.status':
      return `${e.payload.source} ${e.payload.state} since ${e.payload.since}${e.payload.reason ? ` (${e.payload.reason})` : ''}`;
    case 'ci.status':
      return `${e.payload.repo} #${e.payload.pr} ${e.payload.status} at ${e.payload.sha.slice(0, 7)}`;
    case 'elfoqsy.message':
      return `${e.payload.role}: ${e.payload.text}`;
    default:
      return JSON.stringify(e.payload);
  }
}

const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);

ws.on('message', (data) => {
  const frame = JSON.parse(data.toString()) as ServerFrame;
  switch (frame.t) {
    case 'welcome':
      console.log(`Connected: ${frame.mode} mode, log ${frame.logId}, head seq ${frame.headSeq}. Replaying events after seq ${fromSeq}.`);
      ws.send(JSON.stringify({ t: 'hello', fromSeq }));
      break;
    case 'events':
      for (const e of frame.events) {
        const time = new Date(e.ts).toLocaleTimeString('en-GB');
        console.log(`${String(e.seq).padStart(6)}  ${time}  ${e.type.padEnd(18)} ${describe(e)}`);
      }
      break;
    case 'live':
      console.log('--- replay done, live from here ---');
      break;
    case 'error':
      console.error(`daemon: ${frame.message}`);
      break;
  }
});

ws.on('error', (error) => {
  console.error(`Cannot reach the daemon on port ${port}: ${error.message}`);
  process.exit(1);
});
ws.on('close', () => process.exit(0));
