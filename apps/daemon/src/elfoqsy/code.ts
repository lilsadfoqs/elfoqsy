// Grep and read over alex's clones under REPOS_ROOT, for Elfoqsy's lookups. Only files are read:
// no git command runs, so nothing in a clone can change, not even its index. Symlinks are never
// followed, files that usually hold secrets are skipped, and everything is capped. Results are
// redacted by the tool layer before they reach a model.
import { lstatSync, openSync, readFileSync, readSync, closeSync, readdirSync, realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', 'vendor', '.next', 'target', '.venv', '__pycache__', '.turbo', '.cache']);
/** Files that usually hold credentials: never searched or read, whatever the redactor would catch. */
const SECRET_FILE = /^(\.env(\..*)?|\.npmrc|\.netrc|id_(rsa|ed25519|ecdsa)(\.pub)?|.*\.(pem|key|p12|pfx|jks|keystore))$/i;
const MAX_FILE = 512 * 1024;
const MAX_FILES = 20_000;
const MAX_LINE = 300;

export interface GrepArgs {
  repo: string;
  /** Searched for as written, not as a pattern. */
  text: string;
  /** Only paths matching this, like `src/**\/*.ts` or `*.go`. */
  glob?: string;
  ignoreCase?: boolean;
  max?: number;
}

export interface ReadArgs {
  repo: string;
  path: string;
  from?: number;
  lines?: number;
}

export class CodeError extends Error {}

/** `src/**\/*.ts` -> a RegExp over paths relative to the clone. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i++;
      if (glob[i + 1] === '/') i++;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  // A bare name or pattern ("*.ts") matches at any depth.
  return new RegExp(glob.includes('/') ? `^${re}$` : `(^|/)${re}$`);
}

const isBinary = (file: string): boolean => {
  const fd = openSync(file, 'r');
  try {
    const head = Buffer.alloc(1024);
    const n = readSync(fd, head, 0, 1024, 0);
    return head.subarray(0, n).includes(0);
  } finally {
    closeSync(fd);
  }
};

export class CodeReader {
  /** repo (owner/name) -> its clone's real path. */
  private readonly roots = new Map<string, string>();

  constructor(clones: Map<string, string>) {
    for (const [repo, path] of clones) this.roots.set(repo.toLowerCase(), realpathSync(path));
  }

  repos(): string[] {
    return [...this.roots.keys()];
  }

  private root(repo: string): string {
    const name = repo.trim().toLowerCase();
    const byName = [...this.roots.keys()].filter((k) => k.split('/')[1] === name);
    const root = this.roots.get(name) ?? (byName.length === 1 ? this.roots.get(byName[0]!) : undefined);
    if (!root) throw new CodeError(`${repo} is not one of the repositories I can read: ${this.repos().join(', ')}.`);
    return root;
  }

  grep(args: GrepArgs): { repo: string; matches: Array<{ path: string; line: number; text: string }>; filesSearched: number; truncated: boolean } {
    const root = this.root(args.repo);
    if (!args.text.trim()) throw new CodeError('Nothing to search for.');
    const max = Math.min(args.max ?? 60, 200);
    const only = args.glob ? globToRegExp(args.glob) : null;
    const needle = args.ignoreCase ? args.text.toLowerCase() : args.text;
    const matches: Array<{ path: string; line: number; text: string }> = [];
    let filesSearched = 0;
    let truncated = false;
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (truncated) return;
        const full = join(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) walk(full);
          continue;
        }
        if (!entry.isFile() || SECRET_FILE.test(entry.name)) continue;
        const rel = relative(root, full).split(sep).join('/');
        if (only && !only.test(rel)) continue;
        if (++filesSearched > MAX_FILES) {
          truncated = true;
          return;
        }
        if (lstatSync(full).size > MAX_FILE || isBinary(full)) continue;
        const lines = readFileSync(full, 'utf8').split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!;
          if (!(args.ignoreCase ? line.toLowerCase() : line).includes(needle)) continue;
          matches.push({ path: rel, line: i + 1, text: line.trim().slice(0, MAX_LINE) });
          if (matches.length >= max) {
            truncated = true;
            return;
          }
        }
      }
    };
    walk(root);
    return { repo: args.repo, matches, filesSearched: Math.min(filesSearched, MAX_FILES), truncated };
  }

  read(args: ReadArgs): { repo: string; path: string; from: number; to: number; totalLines: number; text: string } {
    const root = this.root(args.repo);
    const rel = args.path.replace(/^\/+/, '');
    let real: string;
    try {
      real = realpathSync(join(root, rel));
    } catch {
      throw new CodeError(`${args.path} is not in ${args.repo}.`);
    }
    // Inside the clone, after every link is resolved.
    if (real !== root && !real.startsWith(root + sep)) throw new CodeError(`${args.path} is outside ${args.repo}.`);
    const parts = relative(root, real).split(sep);
    if (parts.includes('.git') || SECRET_FILE.test(parts.at(-1) ?? '')) throw new CodeError(`${args.path} is not readable here.`);
    const stat = lstatSync(real);
    if (!stat.isFile()) throw new CodeError(`${args.path} is not a file.`);
    if (stat.size > 4 * MAX_FILE || isBinary(real)) throw new CodeError(`${args.path} is too large or not text.`);
    const all = readFileSync(real, 'utf8').split('\n');
    const from = Math.max(1, Math.floor(args.from ?? 1));
    const count = Math.min(Math.max(1, Math.floor(args.lines ?? 200)), 400);
    const slice = all.slice(from - 1, from - 1 + count).map((l) => (l.length > 1000 ? `${l.slice(0, 1000)} [cut]` : l));
    return { repo: args.repo, path: parts.join('/'), from, to: from + slice.length - 1, totalLines: all.length, text: slice.join('\n') };
  }
}
