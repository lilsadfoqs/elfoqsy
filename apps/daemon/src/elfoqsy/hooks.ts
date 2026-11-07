import type { Options } from '@anthropic-ai/claude-agent-sdk';

/** Several hook sets as one: each event's matchers in the order given. Undefined when there are none. */
export function mergeHooks(...sets: Array<Options['hooks'] | undefined>): Options['hooks'] | undefined {
  const merged: NonNullable<Options['hooks']> = {};
  for (const set of sets) {
    for (const [event, matchers] of Object.entries(set ?? {})) {
      const key = event as keyof typeof merged;
      merged[key] = [...(merged[key] ?? []), ...(matchers ?? [])];
    }
  }
  return Object.keys(merged).length ? merged : undefined;
}
