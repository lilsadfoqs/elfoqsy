// The tester may show Elfoqsy an image only when it is one of the repository's own pictures: the agreed
// screenshots in or a fixtures folder. The bytes are compared, not the name, so
// a screenshot of alex's screen never reaches her from the tester, whatever it is called.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const MAX_FILES = 500;
const MAX_DEPTH = 6;

const sha256 = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');

export class TesterImages {
  /** path -> its size, modification time and hash, so files are only hashed again when they change. */
  private readonly cache = new Map<string, { size: number; mtimeMs: number; hash: string }>();

  constructor(private readonly roots: string[]) {}

  /** Whether this stored attachment is byte for byte one of the allowed pictures. */
  allows(file: string): boolean {
    const hash = sha256(file);
    return this.pictures().has(hash);
  }

  private pictures(): Set<string> {
    const hashes = new Set<string>();
    let seen = 0;
    const walk = (dir: string, depth: number): void => {
      if (depth > MAX_DEPTH) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (seen >= MAX_FILES) return;
        const full = join(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) walk(full, depth + 1);
        else if (entry.isFile() && IMAGE.test(entry.name)) {
          seen++;
          const { size, mtimeMs } = statSync(full);
          const cached = this.cache.get(full);
          const hash = cached && cached.size === size && cached.mtimeMs === mtimeMs ? cached.hash : sha256(full);
          this.cache.set(full, { size, mtimeMs, hash });
          hashes.add(hash);
        }
      }
    };
    for (const root of this.roots) if (existsSync(root)) walk(root, 0);
    return hashes;
  }
}
