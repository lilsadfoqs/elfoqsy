// Which delegation category a tier-2 request falls in, worked out by the orchestrator from how the proxy
// classified it, with no model involved. alex's setting for the category then says whether Elfoqsy decides it,
// decides and tells him, or asks him.
import type { DelegationCategory, DelegationSetting, ProxyName } from '@elfoqsy/contracts';
import { DEFAULT_DELEGATION, type WorkspaceState } from '@elfoqsy/state';
import { tr } from '../elfoqsy/voice';
import type { Classified } from '../permissions/types';

/** Writes nobody can take back: removing an image, reaching into a cluster, running a workflow, filling over text. */
const IRREVERSIBLE = new Set(['docker.rmi', 'docker.image_rm', 'kube.traffic', 'aws.s3_write', 'jira.fill_over', 'gh.cache.delete']);
const IRREVERSIBLE_PREFIX = ['gh.workflow.'];
/** Any kind that deletes or removes something (an ECR image or repository, a cache): gone once done. */
const DELETES = /(^|[._-])(delete|remove|rm|rmi|purge|terminate|destroy)([._-]|$)/;

/** What other people are told of: ready for review, comments and edits on PRs and issues, Jira writes, pages. */
const NOTIFIES = /^(gh\.(pr|issue)\.|gh\.api|jira\.|confluence\.)/;

/** The category of a tier-2 action. A file ask's category is the run's to say (it knows where the paths resolve). */
export function actionCategory(proxy: ProxyName, c: Pick<Classified, 'kind' | 'environment' | 'harness'>): DelegationCategory {
  const kind = c.kind;
  if (kind === 'logs.prod' || (proxy === 'logs' && c.environment === 'prod')) return 'prod_logs';
  if (kind === 'kube.read_secret' || kind === 'aws.read_secret') return 'read_secret';
  // What cannot be undone stays that, wherever it lands: staging included.
  if (IRREVERSIBLE.has(kind) || IRREVERSIBLE_PREFIX.some((p) => kind.startsWith(p)) || DELETES.test(kind)) return 'irreversible';
  if (c.environment === 'staging') return 'staging_write';
  if (c.harness && (c.environment === 'dev' || c.environment === 'integration' || c.environment === 'local')) {
    return proxy === 'kube' ? 'harness_kube' : 'harness_image';
  }
  if (kind === 'gh.run.rerun_other' || kind === 'gh.run.rerun') return 'ci_rerun';
  // An empty field of a ticket assigned to him; the proxy says which kind it is.
  if (kind === 'jira.fill' || kind === 'jira.set_field') return 'jira_fill';
  if (NOTIFIES.test(kind)) return 'notify_people';
  return 'other';
}

/** In plain words, for her lines, the card and the settings sheet. */
export const CATEGORY_WORDS: Record<DelegationCategory, string> = {
  run_folder: 'a path inside the run folder',
  sourced_answer: 'a question answered from its sources',
  ci_rerun: 'rerunning CI',
  harness_kube: 'a test-harness change',
  harness_image: "the test harness's image",
  unsourced: 'a decision with no source',
  notify_people: 'something people are notified of',
  staging_write: 'a staging write',
  read_secret: 'reading a secret',
  prod_logs: 'prod logs',
  irreversible: 'something that cannot be undone',
  jira_fill: 'filling an empty field of your ticket',
  other: 'a request',
};

/** The same, in Vietnamese, for her lines in the language of his latest message. */
export const CATEGORY_WORDS_VI: Record<DelegationCategory, string> = {
  run_folder: 'việc dùng đường dẫn trong thư mục của lượt chạy',
  sourced_answer: 'việc trả lời câu hỏi từ nguồn',
  ci_rerun: 'việc chạy lại CI',
  harness_kube: 'việc thay đổi test harness',
  harness_image: 'image của test harness',
  unsourced: 'quyết định không có nguồn',
  notify_people: 'việc có báo cho người khác',
  staging_write: 'việc ghi vào staging',
  read_secret: 'việc đọc secret',
  prod_logs: 'log prod',
  irreversible: 'việc không hoàn tác được',
  jira_fill: 'việc điền trường còn trống của ticket của cậu',
  other: 'một yêu cầu',
};

/** A category in plain words, in the language of his latest message. */
export const categoryWords = (category: DelegationCategory): string => tr(CATEGORY_WORDS[category], CATEGORY_WORDS_VI[category]);

/** Where "Let Elfoqsy decide this kind next time" is not offered: what cannot be undone, and secrets (plan, question 3). */
export const NO_PRECEDENT: ReadonlySet<DelegationCategory> = new Set(['irreversible', 'read_secret']);

/** The ticket type a precedent is stored for: the run's ticket's type, or Task agent for a task. */
export function ticketTypeOf(s: WorkspaceState, runId: string): string {
  const run = s.runs[runId];
  if (!run) return 'unknown';
  if (run.task) return 'Task agent';
  return s.tickets[run.ticket]?.type ?? 'unknown';
}

/**
 * His setting for a category on a run, with his precedents: the kind of action he let her decide, in this category and
 * on this ticket type, is decided (and told, since he once had to be asked). A precedent counts for its own kind only, so
 * one tick on a harmless request never lets her decide everything else in its category. kind: the action's kind.
 */
export function effectiveSetting(s: WorkspaceState, category: DelegationCategory, runId: string, kind?: string): { setting: DelegationSetting; precedentId?: string } {
  const setting = s.delegation[category] ?? DEFAULT_DELEGATION[category];
  if (setting !== 'ask' || NO_PRECEDENT.has(category)) return { setting };
  const type = ticketTypeOf(s, runId);
  const precedent = Object.values(s.precedents).find((p) => p.requestKind === 'action' && p.category === category && p.ticketType === type && p.by === 'you' && p.kind === kind);
  return precedent ? { setting: 'decide_and_tell', precedentId: precedent.precedentId } : { setting };
}
