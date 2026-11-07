// Two folders of PNGs compared pixel by pixel, with anti-aliasing noise allowed: a pixel differs only when a channel is off by
// more than NOISE (the same code rendered twice differs by 1 on a few corner pixels).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const { PNG } = createRequire(import.meta.url)('playwright-core/lib/utilsBundle');
const NOISE = 2;

/** What differs between the pictures of two folders: [] when every picture is the same. */
export function compareDirs(before, after) {
  const out = [];
  for (const name of readdirSync(before).filter((f) => f.endsWith('.png')).sort()) {
    let b;
    try {
      b = PNG.sync.read(readFileSync(join(after, name)));
    } catch {
      out.push(`${name}: missing`);
      continue;
    }
    const a = PNG.sync.read(readFileSync(join(before, name)));
    if (a.width !== b.width || a.height !== b.height) {
      out.push(`${name}: ${a.width}x${a.height} became ${b.width}x${b.height}`);
      continue;
    }
    let n = 0;
    let x0 = a.width, y0 = a.height, x1 = 0, y1 = 0;
    for (let i = 0; i < a.data.length; i += 4) {
      if (Math.abs(a.data[i] - b.data[i]) > NOISE || Math.abs(a.data[i + 1] - b.data[i + 1]) > NOISE || Math.abs(a.data[i + 2] - b.data[i + 2]) > NOISE) {
        n++;
        const px = (i / 4) % a.width;
        const py = Math.floor(i / 4 / a.width);
        x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py);
      }
    }
    if (n) out.push(`${name}: ${n} pixels differ, within ${x0},${y0} to ${x1},${y1}`);
  }
  return out;
}
