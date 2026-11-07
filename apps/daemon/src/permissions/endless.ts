// Reads that never end. A call that follows or watches (kubectl logs -f, get -w, rollout status, a wait with no short
// end, aws logs tail --follow, an aws waiter, gh run watch) is a "read" by tier, but Elfoqsy's turn is waited on, so she
// reads once instead: Proxies.read refuses these, and logs the refusal like any other. An agent's call would only run
// into the two-minute timeout, so the agents' proxies are as they were.
import type { ProxyName } from '@elfoqsy/contracts';
import { parseKube } from './kube';

/** Why a call is refused because it would not end, with what to do instead; undefined when it will. */
export function neverEnds(proxy: ProxyName, args: string[]): string | undefined {
  const words = args.filter((a) => !a.startsWith('-'));
  if (proxy === 'kube') {
    const p = parseKube(args);
    // A flag set on, as a word of its own, as --flag=true, or inside a cluster of short flags (-fc, -wA). In a cluster, a
    // flag that takes a value takes the rest of the word (-owide is -o with "wide", which is no -w).
    const on = (long: string[], short: string) =>
      args.some((a) => {
        if (long.some((l) => a === l || a === `${l}=true`)) return true;
        if (!/^-[a-zA-Z]/.test(a)) return false;
        for (const ch of a.slice(1)) {
          if (ch === short) return true;
          if ('onlLcfsk'.includes(ch)) return false;
        }
        return false;
      });
    if (p.verb === 'logs' && on(['--follow'], 'f')) return 'Following logs never ends: read once, with --tail=200 (and --since for a time).';
    if ((p.verb === 'get' || p.verb === 'events') && on(['--watch', '--watch-only'], 'w')) return 'Watching never ends: read once.';
    if (p.raw !== undefined && /[?&]watch=(true|1)/i.test(p.raw)) return 'Watching never ends: read once.';
    if (p.verb === 'rollout status' && p.flags.get('--watch') !== 'false') return 'rollout status waits for a rollout to finish, which may be never: add --watch=false to read where it is now.';
    if (p.verb === 'wait') {
      const t = p.flags.get('--timeout');
      const seconds = typeof t === 'string' ? durationSeconds(t) : 30; // kubectl's own default
      if (seconds === undefined || seconds < 0 || seconds > 60) return 'wait with no end or a long one holds this turn: use --timeout=30s at most, or read the status with get.';
    }
  }
  if (proxy === 'aws' && (args.some((a) => a === '--follow' || a === '--follow=true') || words.includes('wait'))) return 'Following logs and waiting for a state never end here: read once.';
  if (proxy === 'gh' && (args.some((a) => a === '--watch' || a === '--watch=true') || (words[0] === 'run' && words.includes('watch')))) return 'Watching never ends: read once, and read again later.';
  return undefined;
}

/** "30s", "2m", "1h", "500ms" or a bare number of seconds, in seconds; undefined when it is none of those. */
function durationSeconds(text: string): number | undefined {
  const m = /^(-?\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(text.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  return { ms: n / 1000, s: n, m: n * 60, h: n * 3600 }[m[2] ?? 's'];
}
