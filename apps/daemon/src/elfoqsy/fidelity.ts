// Elfoqsy reports what her tools returned, not what she guesses. When a tool drops, rejects or changes part of what she
// asked, she says what it returned, in its words, and when it gave no reason, that she does not know why (alex's
// rule after probe P1, where she explained a dropped handoff with a reason the tool never gave). The orchestrator
// checks her reply before it is posted: a sentence about something a tool dropped, rejected or changed that gives a
// cause no tool returned sends the reply back to her once, with what the tools did return.

/** Something a tool did not do as asked, and the reason it gave, if any. */
export interface ToolOutcome {
  tool: string;
  /** What it dropped, rejected or changed. */
  what: string;
  how: 'dropped' | 'rejected' | 'changed';
  reason?: string;
}

const LISTS: Array<[key: string, how: ToolOutcome['how']]> = [
  ['dropped', 'dropped'],
  ['rejected', 'rejected'],
  ['skipped', 'dropped'],
  ['changed', 'changed'],
];

const itemText = (item: unknown): string | undefined => {
  if (typeof item === 'string') return item;
  if (item && typeof item === 'object') {
    const o = item as Record<string, unknown>;
    for (const k of ['text', 'item', 'what', 'key', 'ref']) if (typeof o[k] === 'string') return o[k] as string;
  }
  return undefined;
};

/** What a tool's result says it dropped, rejected or changed: its lists, and a refusal of the whole request. */
export function outcomesOf(tool: string, result: unknown): ToolOutcome[] {
  if (!result || typeof result !== 'object') return [];
  const r = result as Record<string, unknown>;
  const out: ToolOutcome[] = [];
  if (typeof r.error === 'string') out.push({ tool, what: 'the request', how: 'rejected', ...(typeof r.message === 'string' && r.message.trim() ? { reason: r.message.trim() } : {}) });
  for (const [key, how] of LISTS) {
    const list = r[key];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const what = itemText(item);
      if (!what) continue;
      const reason = item && typeof item === 'object' ? (item as Record<string, unknown>).reason : undefined;
      out.push({ tool, what, how, ...(typeof reason === 'string' && reason.trim() ? { reason: reason.trim() } : {}) });
    }
  }
  return out;
}

/** A sentence that says something was left out or refused. */
const ACTED = /\b(drop(s|ped)?|reject(s|ed)?|left (it |them )?out|leaves? out|remov(e|ed|es)|refus(e|ed|es)|skipp(ed|s)|declin(e|ed|es)|didn'?t (include|keep|take|accept)|did not (include|keep|take|accept)|not (included|kept|accepted)|filtered( out)?|changed)\b/i;
/** A sentence that gives a cause. */
const CAUSE = /\b(because|since|due to|owing to|as (it|they|that|the|this)|so (it|they)|the reason|which means|(did ?n['o]t|does ?n['o]t|was ?n['o]t|is ?n['o]t|were ?n['o]t) (come )?from|not from)\b/i;

// The same, for a reply in Vietnamese. \b does not know a letter with a diacritic,
// so the words are bounded by what is not a letter.
const ACTED_VI = /(?<![\p{L}])(?:(?:đã |bị |sẽ )?(?:bỏ(?: qua| đi| sót)?|loại(?: bỏ| ra)?|lược bỏ|từ chối|xóa|xoá|lọc(?: bỏ)?|thay đổi|đã đổi|đổi lại|sửa lại)|không (?:nhận|chấp nhận|giữ|đưa vào|bao gồm|lấy))(?![\p{L}])/iu;
const CAUSE_VI = /(?<![\p{L}])(?:vì|bởi vì|bởi|tại vì|do|nhờ|nguyên nhân|cho nên|vì thế|(?:có )?nghĩa là)(?![\p{L}])|(?<!không (?:đưa |nêu |cho |có |nói |biết )?)(?<![\p{L}])lý do(?![\p{L}])/iu;
/** "I do not know why" and "it gave no reason" are the right answer, not a cause. */
const NO_CAUSE_VI = /không (?:rõ|biết|nêu|đưa|cho|có|thấy)(?: [^.!?]*?)? (?:vì sao|tại sao|lý do)|chưa (?:rõ|biết) (?:vì sao|tại sao|lý do)/iu;

const words = (text: string): string[] => (text.toLowerCase().match(/[a-z0-9_]{4,}/g) ?? []).filter((w) => !STOP.has(w));
const STOP = new Set(['that', 'this', 'with', 'from', 'have', 'were', 'what', 'when', 'your', 'there', 'their', 'them', 'they', 'into', 'only', 'than', 'then', 'which', 'would']);

/** Whether a sentence's cause is one a tool gave: at least half of some reason's words are in it. */
function grounded(sentence: string, reasons: string[]): boolean {
  const said = new Set(words(sentence));
  return reasons.some((r) => {
    const w = words(r);
    return w.length > 0 && w.filter((x) => said.has(x)).length * 2 >= w.length;
  });
}

const sentences = (text: string): string[] =>
  text
    .replace(/\n+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

/** The sentences of a reply that give a cause no tool returned, for what the tools dropped, rejected or changed. */
export function inventedCauses(reply: string, all: ToolOutcome[]): string[] {
  const outcomes = all;
  if (!outcomes.length || !reply.trim()) return [];
  const reasons = outcomes.flatMap((o) => (o.reason ? [o.reason] : []));
  return sentences(reply).filter((s) => ((ACTED.test(s) && CAUSE.test(s)) || (ACTED_VI.test(s) && CAUSE_VI.test(s) && !NO_CAUSE_VI.test(s))) && !grounded(s, reasons));
}

/** What goes back to her: the sentences, and what the tools did return, with "no reason given" where they gave none. */
export function correction(invented: string[], all: ToolOutcome[]): string {
  const outcomes = all;
  const returned = outcomes.map((o) => `- ${o.tool} ${o.how} ${o.what}: ${o.reason ?? 'no reason given'}`);
  return [
    '[From the workspace, not alex] Your reply gives a cause that no tool returned:',
    ...invented.map((s) => `> ${s}`),
    '',
    'What the tools returned:',
    ...returned,
    '',
    'Write your reply again. Say what the tools returned, in their words; where a tool gave no reason, say you do not know why. Nothing has been posted yet.',
  ].join('\n');
}

// ------------------------------------------------------------------ "I cannot look it up" (19 October)

/** A sentence that says she cannot, or has no way to, look something up or reach the web. */
const CANNOT_LOOK_UP =
  /\b(?:can(?:['’]t|not)|can not|couldn['’]t|unable to|not able to|have no (?:way|tool|means|access)|don['’]t have (?:a |any )?(?:way|tool|means|access))\b[^.!?\n]{0,40}\b(?:look(?:ing)? (?:it |that |this |them |anything )?up|search(?:ing)?|brows(?:e|ing)|check(?:ing)? (?:it|that|this|online|the web)|read(?:ing)? the web|(?:access|reach)(?:ing)? the (?:web|internet))\b/i;
/** The same in Vietnamese: no tool, no way, cannot look it up, cannot read the web. */
const CANNOT_LOOK_UP_VI =
  /(?<![\p{L}])không (?:có )?(?:công cụ|cách|quyền|khả năng)(?: nào)?[^.!?\n]{0,50}?(?<![\p{L}])(?:tra|tìm|web|mạng|internet|truy cập|xem)(?![\p{L}])|(?<![\p{L}])không (?:thể )?(?:tra cứu|tra|tìm kiếm|tìm|truy cập|đọc|xem|kiểm tra)(?: được)?[^.!?\n]{0,30}?(?<![\p{L}])(?:web|mạng|internet|online)(?![\p{L}])|(?<![\p{L}])(?:không tra (?:cứu )?được|tra (?:cứu )?không được)(?![\p{L}])/iu;

/**
 * The sentences of a reply that say she cannot look something up, when no tool said no in this turn (a lookup that failed or was refused
 * is the honest reason to say so). She has the web for the world, and her lookups, her reads and investigators for the work: a reply that
 * says she has no way to look it up while she has goes back to her once, as a cause no tool returned does.
 */
export function cannotLookUp(reply: string, outcomes: ToolOutcome[]): string[] {
  if (outcomes.length || !reply.trim()) return [];
  return sentences(reply).filter((s) => CANNOT_LOOK_UP.test(s) || CANNOT_LOOK_UP_VI.test(s));
}

/** What goes back to her when she said she cannot look something up. */
export function lookupCorrection(said: string[], web: boolean): string {
  return [
    '[From the workspace, not alex] Your reply says you cannot look something up:',
    ...said.map((s) => `> ${s}`),
    '',
    `You can. ${web ? 'WebSearch and WebFetch read the public web, for a fact about the world (a score, a line-up, a release, the news). ' : ''}For the work you have your lookups, your own reads of the environments and the investigators, and an agent can check what you cannot. Do it now and answer from what you find. If a lookup you just ran failed or was refused, say what it returned, in its words. Never say you have no way to look something up while a tool or an agent could. Nothing has been posted yet.`,
  ].join('\n');
}
