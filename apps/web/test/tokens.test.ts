import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..', '..', '..');
const tokens = readFileSync(join(root, 'design', 'tokens.css'), 'utf8');
const styles = readFileSync(join(__dirname, '..', 'src', 'styles.css'), 'utf8');
const defined = new Set([...tokens.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((m) => m[1]!));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sources(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : [],
  );
}

describe('type comes only from design/tokens.css', () => {
  it('has no literal font size in the stylesheet', () => {
    expect(styles.match(/font-size:\s*[0-9.]+(px|em|rem)/g) ?? []).toEqual([]);
  });

  it('has no literal font size in components or on the map canvas', () => {
    for (const file of sources(join(__dirname, '..', 'src'))) {
      const text = readFileSync(file, 'utf8');
      expect(text.match(/fontSize:\s*[0-9]|[0-9]+px \$\{/g) ?? [], file).toEqual([]);
    }
  });

  it('uses only tokens that exist', () => {
    const used = new Set([...styles.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]!));
    // Set inline by components, not by the tokens.
    for (const local of ['--ring', '--badge-gap', '--tile-bg', '--tile-fg', '--state-ink', '--map-k', '--p']) used.delete(local);
    expect([...used].filter((t) => !defined.has(t))).toEqual([]);
  });

  it('keeps every step of the type scale at 12px or more, but the calendar month band', () => {
    const steps = [...tokens.matchAll(/--font-size-([a-z0-9]+):\s*(\d+)px/g)].map((m) => ({ step: m[1]!, px: Number(m[2]) }));
    expect(steps.length).toBeGreaterThan(8);
    expect(steps.filter((s) => s.px < 12).map((s) => s.step)).toEqual(['2xs']);
    expect([...styles.matchAll(/var\(--font-size-2xs\)/g)]).toHaveLength(0); // only through --type-tile-month-size
  });
});

describe('the weights the code says are the weights the screen draws', () => {
  // What index.html asks the fonts for: a weight not in it is drawn as the nearest one that is (700 as 800 in the sans, as 600 in the mono),
  // so a rule saying 700 would say what the screen does not show.
  const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
  const loaded = (family: string): number[] => {
    const m = new RegExp(`family=${family}:wght@([0-9;]+)`).exec(html);
    return (m?.[1] ?? '').split(';').map(Number);
  };
  const sans = loaded('Atkinson\\+Hyperlegible\\+Next');
  const mono = loaded('JetBrains\\+Mono');

  it('asks the fonts for the weights it reads', () => {
    expect(sans).toEqual([400, 600, 800]);
    expect(mono).toEqual([400, 600]);
  });

  it('has no rule with a weight its font does not have (a mono rule at 600, a sans one at 400, 600 or 800)', () => {
    const bad: string[] = [];
    for (const m of styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = m[1]!.trim().split('\n').at(-1)!;
      const weight = /font-weight:\s*(\d+)/.exec(m[2]!)?.[1];
      if (!weight) continue;
      const isMono = /font-family:\s*var\(--font-mono\)/.test(m[2]!);
      if (!(isMono ? mono : sans).includes(Number(weight))) bad.push(`${selector}: ${weight} in the ${isMono ? 'mono' : 'sans'}`);
    }
    expect(bad).toEqual([]);
  });

  it('has no token with a weight the font does not have', () => {
    const weights = [...tokens.matchAll(/--type-[a-z-]+-weight:\s*(\d+)/g)].map((m) => Number(m[1]));
    expect(weights.length).toBeGreaterThan(2);
    expect(weights.filter((w) => !sans.includes(w))).toEqual([]);
  });
});
