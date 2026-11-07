// The one redaction function. Every string that goes to a model, into an event or onto a screen
// passes through redact first; the event log calls redactDeep on every payload before writing.

const tag = (kind: string): string => `[redacted ${kind}]`;

interface Rule {
  pattern: RegExp;
  replace: (match: string, ...groups: string[]) => string;
}

const whole = (kind: string): Rule['replace'] => () => tag(kind);

// A hex or base64 (standard or URL-safe) run of 32 or more characters.
const RUN = '[A-Za-z0-9+/_-]{32,}={0,2}';
// A word containing key, token or secret: apikey, api_key, x-api-key, access_token, client_secret, secretKey.
const KEYWORD = '[A-Za-z0-9_-]*(?:key|token|secret)[A-Za-z_-]*';
// What may sit between the word and the run: spaces, quotes, `:`, `=`, `(`, but no letters or digits.
const GAP = '[^A-Za-z0-9\\n]{1,6}';

const RULES: Rule[] = [
  // PEM private keys of any type, including a block cut off before its END line.
  {
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
    replace: whole('private key'),
  },
  // Authorization headers in HTTP, curl -H, JSON, YAML or a template literal. Keeps the header name and the scheme. A
  // template variable (`Basic ${token}`) is code, not a credential; an earlier redaction is left as it is.
  {
    pattern: /\b(authorization["'`]?\s*[:=]\s*["'`]?)(?:(bearer|basic|token|digest|negotiate)\s+)?(?!\$\{|\[redacted [a-z ]+\]|(?:bearer|basic|token|digest|negotiate)\s)[^\s"'`,;}]+/gi,
    replace: (_m, head = '', scheme) => `${head}${scheme ? `${scheme} ` : ''}${tag('credentials')}`,
  },
  // Passwords inside URLs: https://user:password@host
  {
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi,
    replace: (_m, head = '') => `${head}${tag('password')}@`,
  },
  // Pre-signed URLs: their signatures and session tokens, expired or not. AWS SigV4
  // (X-Amz-Signature, X-Amz-Security-Token), Google (X-Goog-Signature), SigV2 and CloudFront (Signature), Azure SAS
  // (sig, long values only). The parameter's name stays, so the link still reads as what it was; the access key id in
  // X-Amz-Credential is taken by the AWS key rule below.
  {
    pattern: /((?:[?&]|&amp;|\\u0026)x-amz-security-token=)(?!\[redacted )[^&\s"'<>#\\]+/gi,
    replace: (_m, head = '') => `${head}${tag('session token')}`,
  },
  {
    pattern: /((?:[?&]|&amp;|\\u0026)(?:x-amz-signature|x-goog-signature|signature)=)(?!\[redacted )[^&\s"'<>#\\]+/gi,
    replace: (_m, head = '') => `${head}${tag('signature')}`,
  },
  {
    pattern: /((?:[?&]|&amp;|\\u0026)sig=)(?!\[redacted )[A-Za-z0-9%+/=_-]{20,}/g,
    replace: (_m, head = '') => `${head}${tag('signature')}`,
  },
  // Known token formats.
  { pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/g, replace: whole('anthropic key') },
  { pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, replace: whole('api key') },
  { pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g, replace: whole('github token') },
  { pattern: /\bATATT[A-Za-z0-9_=-]{20,}/g, replace: whole('atlassian token') },
  { pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, replace: whole('aws key') },
  { pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, replace: whole('slack token') },
  { pattern: /\bAIza[A-Za-z0-9_-]{35}/g, replace: whole('google key') },
  { pattern: /\bnpm_[A-Za-z0-9]{36}/g, replace: whole('npm token') },
  { pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, replace: whole('jwt') },
  // A long run right after key/token/secret: `apikey: 4f3a…`, `apikey=4f3a…`, `"access_token": "…"`.
  {
    pattern: new RegExp(`(\\b${KEYWORD}${GAP})${RUN}`, 'gi'),
    replace: (_m, head = '') => `${head}${tag('secret')}`,
  },
  // A long run right before it: `4f3a… (API key)`, `4f3a… is the token`.
  {
    pattern: new RegExp(`${RUN}(${GAP}(?:[A-Za-z]+\\s+){0,3}${KEYWORD}\\b)`, 'gi'),
    replace: (_m, tail = '') => `${tag('secret')}${tail}`,
  },
];

export function redact(text: string): string {
  let out = text;
  for (const rule of RULES) out = out.replace(rule.pattern, rule.replace as (substring: string, ...args: unknown[]) => string);
  return out;
}

/** Returns a copy with every string inside (object values, array items) redacted. */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item)) as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = redactDeep(item);
    return out as T;
  }
  return value;
}

// ------------------------------------------------------------------ what may leave

/** What the outbound check knows about alex's world: hosts, repositories and paths that must never leave. */
export interface OutboundContext {
  /** Hostnames that are his or his company's internals: exact, or any subdomain of them. */
  internalHosts: string[];
  /** His repositories, owner/name. */
  repos: string[];
  /** Local folders whose paths must not leave: his home, the clones, the run folders. */
  localRoots: string[];
  /** Whether a relative path exists in one of his clones. */
  inClones?: (path: string) => boolean;
  /** A hostname's addresses, to refuse a name that points at a private one (127.0.0.1.nip.io). Absent: not looked up. */
  resolve?: (host: string) => Promise<string[]>;
}

export type OutboundVerdict = { ok: true } | { ok: false; rule: 'secret' | 'internal_host' | 'repo_path' | 'code' | 'encoded_data' | 'not_web'; reason: string };

const INTERNAL_SUFFIXES = ['.local', '.localhost', '.internal', '.lan', '.corp', '.home', '.intranet', '.svc', '.cluster.local', '.eks.amazonaws.com'];
/** Public names that point anywhere their label says, a private address included. */
const WILDCARD_DNS = ['nip.io', 'sslip.io', 'xip.io', 'localtest.me', 'lvh.me', 'vcap.me', 'lacolhost.com', 'traefik.me', 'localhost.run'];
const CODE_MARKS: RegExp[] = [
  /[{}]/,
  /;/,
  /=>|->/,
  /\b\w+\s*\([^)]*\)/,
  /\b(if|for|while|function|const|let|var|return|import|require|class|def|public|private|static|throw|await|async)\b\s*[\w({!]/,
  /#include\b/,
  /===?|!==?|<=|>=/,
  /&&|\|\|/,
  /<\/?[a-z][\w-]*[^>]*>/i,
  /\w+\.\w+\(/,
  /!\w/,
];
const ENCODED = /^[A-Za-z0-9+/=_-]{48,}$/;
/** A key or token of 32 characters or more: letters of both cases and digits, or base64's own marks. */
const KEYLIKE = /^(?=[A-Za-z0-9+/=_-]{32,}$)(?=.*[A-Z])(?=.*[a-z])(?=.*\d)/;

const decode = (s: string): string => {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
};

function privateIp(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80:') || h === '::') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

/** An address written as the host (127.0.0.1, [::ffff:7f00:1], 2130706433): never a name a page lives under. */
export const ipLiteral = (host: string): boolean => {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  return h.includes(':') || /^\d+$/.test(h) || /^0x[0-9a-f]+$/.test(h) || /^[\d.]+$/.test(h);
};

/** Whether a hostname is an internal one: an address, a single label, an internal suffix, a wildcard name, or one of his. */
export function internalHost(host: string, ctx: Pick<OutboundContext, 'internalHosts'>): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (!h) return false;
  if (privateIp(h) || h === 'localhost') return true;
  if (WILDCARD_DNS.some((w) => h === w || h.endsWith(`.${w}`))) return true;
  if (!h.includes('.') && !h.includes(':')) return true;
  if (INTERNAL_SUFFIXES.some((s) => h.endsWith(s))) return true;
  return ctx.internalHosts.some((x) => {
    const i = x.toLowerCase();
    return h === i || h.endsWith(`.${i}`);
  });
}

/** Whether a piece is a key or token: long, dense, of mixed classes, or long and dense enough as data. */
const looksSecret = (piece: string): boolean => KEYLIKE.test(piece) && entropy(piece) >= 4.2;

/** Bits per character: base64 or hex data is high, words and ids are low. */
function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) bits -= (n / s.length) * Math.log2(n / s.length);
  return bits;
}

/** A piece of a URL or query that looks like encoded data: long, from a base64 or hex alphabet, and dense. */
export function looksEncoded(piece: string): boolean {
  const p = piece.trim();
  if (!ENCODED.test(p)) return false;
  // Hex carries at most 4 bits a character, base64 6: both are dense, unlike a word repeated or an id with a pattern.
  return /^[0-9a-f]+$/i.test(p) ? entropy(p) >= 3 : entropy(p) >= 4.2;
}

/** How many kinds of code mark a piece of text carries; two or more and it is code, not words. */
export const codeMarks = (text: string): number => CODE_MARKS.filter((m) => m.test(text)).length;

/** The text pieces a request carries: the query, or a URL's path segments, parameter names and values, and fragment. */
function pieces(target: { url?: string; query?: string }): { host?: string; scheme?: string; texts: string[]; whole: string } {
  if (target.query !== undefined) return { texts: [target.query], whole: target.query };
  const raw = target.url ?? '';
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { texts: [raw], whole: raw };
  }
  const texts = [...u.pathname.split('/').map(decode), ...[...u.searchParams.entries()].flatMap(([k, v]) => [k, v]), decode(u.hash.replace(/^#/, ''))].filter((t) => t.length > 0);
  return { host: u.hostname, scheme: u.protocol, texts, whole: decode(`${u.pathname}${u.search}${u.hash}`) };
}

/**
 * Before a WebFetch or WebSearch leaves: refused when its URL or query carries a secret, an internal
 * hostname, one of his repository paths (or a local path), code, or a long piece that looks like encoded data. The
 * reason names the rule, never the text that matched, so nothing leaks through the refusal either.
 */
export function checkOutbound(target: { url?: string; query?: string }, ctx: OutboundContext): OutboundVerdict {
  const full = target.url ?? target.query ?? '';
  const { host, scheme, texts, whole } = pieces(target);
  if (target.url !== undefined && scheme !== 'http:' && scheme !== 'https:') return { ok: false, rule: 'not_web', reason: 'Only http and https addresses can be fetched.' };
  if (redact(full) !== full || redact(decode(full)) !== decode(full) || (target.url && /^[a-z]+:\/\/[^/@\s]+@/i.test(target.url))) {
    return { ok: false, rule: 'secret', reason: 'It carries what looks like a secret or credentials.' };
  }
  if (host && (internalHost(host, ctx) || ipLiteral(host))) return { ok: false, rule: 'internal_host', reason: "Its host is internal: an address, an internal name, or one of alex's systems." };
  // The host's own labels carry data as well as the path does (shop-api.evil.example, a base32 label): a lookup of
  // the name alone sends it. Names are lower case, so a dense label of letters and digits is enough to refuse.
  if (host) {
    if (host.split('.').some((l) => /^[a-z0-9]{32,}$/.test(l) && entropy(l) >= 4)) return { ok: false, rule: 'encoded_data', reason: 'Its host name carries what looks like encoded data.' };
    texts.push(host, ...host.split('.'));
  }
  const words = `${whole} ${texts.join(' ')}`;
  // Hostnames and addresses named anywhere in it (a search for an internal host leaks it as much as a fetch would).
  for (const m of words.matchAll(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b|\b\d{1,3}(?:\.\d{1,3}){3}\b|\blocalhost\b/gi)) {
    if (m[0].includes('.') || m[0].toLowerCase() === 'localhost' ? internalHost(m[0], ctx) : false) {
      return { ok: false, rule: 'internal_host', reason: "It names an internal host: a private address, an internal name, or one of alex's systems." };
    }
  }
  const lower = words.toLowerCase();
  const repoNames = ctx.repos.flatMap((r) => [r.toLowerCase(), (r.split('/')[1] ?? r).toLowerCase()]);
  if (repoNames.some((n) => n.length >= 6 && lower.includes(n))) return { ok: false, rule: 'repo_path', reason: "It names one of alex's repositories." };
  if (/file:\/\//i.test(full) || ctx.localRoots.some((root) => root.length > 1 && lower.includes(root.toLowerCase()))) return { ok: false, rule: 'repo_path', reason: 'It carries a local path.' };
  for (const t of texts) {
    for (const m of t.matchAll(/[\w.-]+(?:\/[\w.-]+)+/g)) {
      const p = m[0].replace(/^\.?\//, '');
      if (p.split('/').length >= 2 && /\.[a-z0-9]{1,5}$/i.test(p) && ctx.inClones?.(p)) return { ok: false, rule: 'repo_path', reason: "It carries a path from one of alex's repositories." };
    }
  }
  if (texts.some((t) => codeMarks(t) >= 2)) return { ok: false, rule: 'code', reason: 'It carries code.' };
  if (texts.some((t) => t.split(/[\s,;:|]+/).some(looksEncoded))) return { ok: false, rule: 'encoded_data', reason: 'It carries a long piece that looks like encoded data.' };
  // Shorter than encoded data, but a key or a token all the same (an access key's secret is 40 characters).
  if (texts.some((t) => t.split(/[\s,;:|.]+/).some(looksSecret))) return { ok: false, rule: 'secret', reason: 'It carries what looks like a key or a token.' };
  // Data cut into short pieces is as dense once put back together.
  const joined = texts.join('').replace(/[^A-Za-z0-9+/=_-]/g, '');
  if (joined.length >= 64 && entropy(joined) >= 4.9) return { ok: false, rule: 'encoded_data', reason: 'It carries pieces that together look like encoded data.' };
  return { ok: true };
}

/** checkOutbound, and then the host looked up: a name that points at a private address is refused too. */
export async function checkOutboundResolved(target: { url?: string; query?: string }, ctx: OutboundContext): Promise<OutboundVerdict> {
  const first = checkOutbound(target, ctx);
  if (!first.ok || !target.url || !ctx.resolve) return first;
  let host: string;
  try {
    host = new URL(target.url).hostname;
  } catch {
    return first;
  }
  const addresses = await ctx.resolve(host).catch(() => [] as string[]);
  if (addresses.some((a) => privateIp(a) || privateIp(a.replace(/^::ffff:/i, '')))) return { ok: false, rule: 'internal_host', reason: 'Its host points at a private address.' };
  return first;
}
