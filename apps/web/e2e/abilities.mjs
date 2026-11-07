// The abilities the browser tests show (brief-abilities part B): the six first skills as written (docs/reports/abilities/
// first-skills), learned from the friction analysis with Elfoqsy's one notice in Today's conversation, verified (one step of
// one failing, so it needs a re-check), and used, with made-up uses so the cards have levels and numbers; then, on cue, one an
// agent found on a ticket, with her notice in Vietnamese as in the prototype. Made-up uses and times; no secrets.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { T0 } from './scenario.mjs';

const firstSkills = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs', 'reports', 'abilities', 'first-skills');
const skills = readdirSync(firstSkills)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(firstSkills, f), 'utf8')))
  .sort((a, b) => a.name.localeCompare(b.name));

const steps = (a) => a.steps.map((s) => ({ text: s.text, ...(s.code ? { code: s.code } : {}), kind: s.read ? 'read' : s.effect ? 'effect' : 'note' }));
const learned = (a) => ({ name: a.name, version: a.version, title: a.title, titleVi: a.titleVi, tool: a.tool, steps: steps(a), finder: a.finder, baselineSteps: a.baseline.steps, baselineFailed: a.baseline.failed, baselineQuestions: a.baseline.questions, source: a.source });
const verified = (a, failing) => ({
  name: a.name,
  version: a.version,
  steps: a.steps.map((s, i) => (i === failing ? { status: 'failed', note: "Error from server (NotFound): deployments.apps '…' not found" } : s.read ? { status: 'ok' } : { status: 'unverified', note: s.effect ? 'It changes something, so it is never run to verify it.' : 'Nothing to run.' })),
});

/** How the made-up uses go for each: [uses, of which worked, steps a use takes]. Levels follow: 23 uses, 22 worked is level 4. */
const USES = { 'find-request-logs': [23, 22, 2], 'find-service-pod': [9, 8, 1], 'pool-has-no-pods': [4, 3, 1], 'draft-pr-team-way': [3, 3, 1], 'jira-fields-team-way': [2, 2, 2], 'pr-ci-from-a-run': [1, 1, 1] };

/** The agent-found ability, as it arrives on cue. */
export const AGENT_SKILL = {
  name: 'checkout-e2e-on-dev',
  version: 1,
  title: 'Run the checkout e2e suite on dev',
  titleVi: 'chạy e2e checkout trên dev',
  tool: 'test',
  steps: [
    { text: 'Check the worker pool has pods', code: 'get deploy -l pool=normal', kind: 'read' },
    { text: 'Start the suite from the test pod', code: 'exec deploy/shop-integration-test -- npm run e2e:checkout', kind: 'effect' },
    { text: 'Follow its log until it ends', code: 'logs deploy/shop-integration-test -f', kind: 'read' },
    { text: 'Note each failed case and its payment method', kind: 'note' },
  ],
  finder: { by: 'agent', agentNumber: 5, runId: 'run-e2e-5', ticket: 'SHOP-3567' },
  baselineSteps: 9,
  baselineFailed: 2.4,
  baselineQuestions: 0.6,
  source: 'SHOP-3567, Agent 5',
};

/**
 * The events, numbered after `seq` (the last of the events they follow): Today's conversation, the six learned with her
 * notice, their verifications and uses. `today` is Today's conversation as the page will name it.
 */
export function abilityEvents(seq, today) {
  const out = [];
  const ev = (type, payload, sec) => out.push({ seq: ++seq, id: `A${seq}`, ts: new Date(T0 + sec * 1000).toISOString(), source: 'orchestrator', type, payload });
  ev('conversation.created', today, 60);
  for (const a of skills) ev('ability.learned', learned(a), 61);
  // Where each came from, as its ability.json keeps it.
  for (const a of skills) ev('ability.origin', { name: a.name, version: a.version, foundAt: a.createdAt, cases: a.baseline.cases, from: a.baseline.from }, 61);
  // Her own lines, as she writes them (the daemon makes none): this one is hers, about six things she worked out from the past days.
  ev('elfoqsy.message', { messageId: 'm-abilities-1', role: 'elfoqsy', text: `Six things I worked out from the last few days of work, now written down so that I do them the same way next time: ${skills.map((a) => a.title.charAt(0).toLowerCase() + a.title.slice(1)).join('; ')}.`, conversationId: today.conversationId, blocks: skills.map((a) => ({ type: 'ability', ref: a.name })) }, 62);
  for (const a of skills) ev('ability.verified', verified(a, a.name === 'find-service-pod' ? 2 : -1), 70);
  ev('ability.needs_recheck', { name: 'find-service-pod', version: 1, step: 2, reason: "Error from server (NotFound): deployments.apps '…' not found" }, 71);
  let sec = 120;
  for (const a of skills) {
    const [uses, worked, taken] = USES[a.name];
    for (let i = 0; i < uses; i++) {
      ev('ability.used', { name: a.name, runId: `run-use-${a.name}-${i}`, worked: i < worked, steps: taken, baselineSteps: a.baseline.steps, failedCalls: i < worked ? 0 : 1, baselineFailed: a.baseline.failed, questions: 0, baselineQuestions: a.baseline.questions }, sec);
      sec += 5;
    }
  }
  return out;
}

/** The agent-found ability arriving: learned, its notice (in Vietnamese, as in the prototype), verified. */
export function agentSkillEvents(seq, today, at) {
  const out = [];
  const ev = (type, payload) => out.push({ seq: ++seq, id: `B${seq}`, ts: new Date(at).toISOString(), source: 'orchestrator', type, payload });
  ev('ability.learned', AGENT_SKILL);
  ev('ability.origin', { name: AGENT_SKILL.name, version: 1, foundAt: new Date(at).toISOString(), cases: 2, from: 'runs in the log before the skill' });
  ev('elfoqsy.message', { messageId: 'm-abilities-2', role: 'elfoqsy', text: `Agent 5 vừa chỉ cho tôi cách ${AGENT_SKILL.titleVi}, tôi ghi lại để lần sau làm luôn.`, conversationId: today.conversationId, blocks: [{ type: 'ability', ref: AGENT_SKILL.name }] });
  ev('ability.verified', { name: AGENT_SKILL.name, version: 1, steps: AGENT_SKILL.steps.map((s) => (s.kind === 'read' ? { status: 'ok' } : { status: 'unverified' })) });
  return out;
}

export const FIRST_SKILLS = skills.map((a) => a.name);

/**
 * The nine abilities of the prototype (brief-abilities/prototypes/Abilities.dc.html), as events: the same titles, tools, finders, levels
 * and numbers, so the view can be put beside the prototype's own screenshot. The selected one (Find a request's logs on staging) has
 * 23 uses, 22 that worked and about 180 steps saved; together they saved 1,240 steps this month. Made-up uses and times.
 */
const protoStep = (text, code) => ({ text, ...(code ? { code } : {}), kind: code ? 'read' : 'note' });
// [name, title, tool, finder, uses, worked, baseline steps, steps a use takes, steps]
export const PROTO_ABILITIES = [
  ['proto-branch-deployed', 'Which branch is deployed where', 'kubernetes', { by: 'elfoqsy', session: 'friction analysis' }, 32, 31, 20.955, 1, [protoStep('List the deployments', 'get deploy -o name'), protoStep('Read the image tag of each', 'get deploy -o wide'), protoStep('Match the tag to its branch')]],
  ['proto-request-logs-staging', "Find a request's logs on staging", 'coralogix', { by: 'agent', agentNumber: 2, runId: 'run-proto-2', ticket: 'SHOP-3412' }, 23, 22, 10, 2, [protoStep('Pick the app for staging', 'shop-api'), protoStep('Filter by request id', '$d.requestId'), protoStep('No hit: try the gateway', 'api-gateway'), protoStep('Note the first error and its pod')]],
  ['proto-draft-pr', "Open a draft PR the team's way", 'github', { by: 'agent', agentNumber: 4, runId: 'run-proto-4', ticket: 'SHOP-3501' }, 12, 10, 10, 1, [protoStep('Title: the branch, then the behaviour'), protoStep('Open it as a draft', 'gh pr create --draft')]],
  ['proto-aws-session', 'Refresh an expired AWS session', 'aws', { by: 'elfoqsy', session: 'friction analysis' }, 5, 4, 13, 1, [protoStep('Check the profile', 'sts get-caller-identity'), protoStep('Sign in again', 'sso login')]],
  ['proto-qa-evidence', 'Write test evidence for QA', 'jira', { by: 'agent', agentNumber: 3, runId: 'run-proto-3', ticket: 'SHOP-3377' }, 10, 9, 17, 2, [protoStep('List the cases that ran'), protoStep('Attach the log of each')]],
  ['proto-checkout-e2e', 'Run the checkout e2e suite on dev', 'test', { by: 'agent', agentNumber: 5, runId: 'run-proto-5', ticket: 'SHOP-3567' }, 4, 3, 9, 1, [protoStep('Check the pool has pods', 'get deploy -l pool=normal'), protoStep('Start the suite', 'npm run e2e:checkout')]],
  ['proto-crash-reason', "Get a pod's crash reason", 'kubernetes', { by: 'agent', agentNumber: 2, runId: 'run-proto-2b', ticket: 'SHOP-3420' }, 9, 8, 14, 1, [protoStep('Describe the pod', 'describe pod <name>'), protoStep('Read the last state')]],
  ['proto-trace-scan', 'Trace a scan across routing keys', 'coralogix', { by: 'agent', agentNumber: 4, runId: 'run-proto-4b', ticket: 'SHOP-3490' }, 5, 4, 11, 1, [protoStep('Find the scan id'), protoStep('Follow it by routing key', '$d.routingKey')]],
  ['proto-decision', 'Find where a decision was made', 'teams', { by: 'elfoqsy', session: 'conversation' }, 0, 0, 6, 1, [protoStep('Search the chats for the topic'), protoStep('Open the thread it came from')]],
];

/** The prototype's nine abilities as events, numbered after `seq`: learned, verified (the sixth needs a re-check), used, and her one message with a card for each. */
export function protoEvents(seq, today) {
  const out = [];
  const ev = (type, payload, sec) => out.push({ seq: ++seq, id: `P${seq}`, ts: new Date(T0 + sec * 1000).toISOString(), source: 'orchestrator', type, payload });
  ev('conversation.created', today, 60);
  PROTO_ABILITIES.forEach(([name, title, tool, finder, , , baselineSteps, , steps], i) => ev('ability.learned', { name, version: 1, title, titleVi: title.toLowerCase(), tool, steps, finder, baselineSteps, baselineFailed: 0, baselineQuestions: 0, source: finder.by === 'agent' ? `${finder.ticket}, Agent ${finder.agentNumber}` : 'friction analysis of 30 of his sessions and 10 runs, 2026-10-12' }, 61 + i));
  PROTO_ABILITIES.forEach(([name, , , finder, , , baselineSteps], i) => ev('ability.origin', { name, version: 1, foundAt: new Date(T0 + (61 + i) * 1000).toISOString(), cases: finder.by === 'agent' ? 2 : 24, from: finder.by === 'agent' ? 'runs in the log before the skill' : 'episodes of this task in 30 of his sessions and 10 runs before 2026-10-12' }, 61 + i));
  ev('elfoqsy.message', { messageId: 'm-proto-1', role: 'elfoqsy', text: 'Nine things I know how to do now.', conversationId: today.conversationId, blocks: PROTO_ABILITIES.map(([name]) => ({ type: 'ability', ref: name })) }, 70);
  PROTO_ABILITIES.forEach(([name, , , , , , , , steps]) => ev('ability.verified', { name, version: 1, steps: steps.map((s) => (s.kind === 'read' ? { status: 'ok' } : { status: 'unverified' })) }, 80));
  ev('ability.needs_recheck', { name: 'proto-checkout-e2e', version: 1, step: 1, reason: 'The pool had no pods when it was last checked' }, 81);
  let sec = 120;
  for (const [name, , , , uses, worked, baselineSteps, taken] of PROTO_ABILITIES) {
    for (let i = 0; i < uses; i++) {
      ev('ability.used', { name, runId: `run-use-${name}-${i}`, worked: i < worked, steps: taken, baselineSteps, failedCalls: 0, baselineFailed: i < worked ? 0.2 * (name === 'proto-request-logs-staging') : 0, questions: 0, baselineQuestions: 0 }, sec);
      sec += 3;
    }
  }
  return out;
}

// The abilities she has now, as their files keep them: the six first, the one an agent found, and the six she wrote herself
// (docs/reports/abilities/her-skills). Long steps, long commands and long origins included: the view has to hold them all.
const hersDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs', 'reports', 'abilities', 'her-skills');
const hers = readdirSync(hersDir)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(hersDir, f), 'utf8')));

/** The agent's ability and hers, learned with their origin (no message of hers: pages other tests left open would hear it twice), numbered after `seq`. */
export function liveAbilityEvents(seq, clock) {
  const out = [];
  const ev = (type, payload, n) => out.push({ seq: ++seq, id: `OR${seq}`, ts: new Date(clock + n * 1000).toISOString(), source: 'orchestrator', type, payload });
  ev('ability.learned', AGENT_SKILL, 9);
  ev('ability.origin', { name: AGENT_SKILL.name, version: 1, foundAt: new Date(clock).toISOString(), cases: 2, from: 'runs in the log before the skill' }, 9);
  ev('ability.verified', { name: AGENT_SKILL.name, version: 1, steps: AGENT_SKILL.steps.map((st) => (st.kind === 'read' ? { status: 'ok' } : { status: 'unverified' })) }, 9);
  hers.forEach((a, i) => {
    ev('ability.learned', learned(a), 10 + i);
    ev('ability.origin', { name: a.name, version: a.version, foundAt: a.createdAt, cases: a.baseline.cases, from: a.baseline.from }, 10 + i);
  });
  return out;
}
