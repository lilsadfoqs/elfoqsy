// The one Markdown renderer, used for chat, ticket details, briefs and handoffs, reviews
// and tool outputs: paragraphs, headings, bulleted and numbered lists, `code`, **bold** and http(s) links; fenced code
// with a header (path, line range, Copy), numbered lines and highlighted lines; diffs in the terminal's style; tables,
// where a cell may start with a coloured dot. It builds React elements, so no HTML in the text ever runs. No syntax
// colours: code stays monochrome, bright on dark.
import { useState, type ReactNode } from 'react';
import { LinkIcon } from './Icons';

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g;

export function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const token = m[0];
    const key = `${m.index}`;
    if (m[1]) out.push(<code key={key}>{token.slice(1, -1)}</code>);
    else if (m[2]) out.push(<b key={key}>{token.slice(2, -2)}</b>);
    else {
      const [, label, url] = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)!;
      out.push(
        <a key={key} href={url} target="_blank" rel="noreferrer">
          <LinkIcon url={url ?? ''} />
          {label}
        </a>,
      );
    }
    last = m.index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** A fence's info string: ```ts path=shop-api/src/auth.ts start=24 highlight=27,29-30 */
export interface CodeInfo {
  language?: string;
  path?: string;
  startLine?: number;
  highlight?: number[];
}

export type Block =
  | { kind: 'p'; text: string }
  | { kind: 'ul' | 'ol'; items: string[] }
  | { kind: 'h'; level: 1 | 2 | 3; text: string }
  | { kind: 'code'; code: string; info: CodeInfo }
  | { kind: 'table'; head: string[]; rows: string[][] };

/** "27", "27,29-30" as line numbers. */
function lineList(spec: string): number[] {
  return spec.split(',').flatMap((part) => {
    const [a, b] = part.split('-').map((n) => Number(n.trim()));
    if (!a || !Number.isFinite(a)) return [];
    if (!b || b < a) return [a];
    return Array.from({ length: Math.min(b - a + 1, 500) }, (_, i) => a + i);
  });
}

export function parseInfo(info: string): CodeInfo {
  const [first = '', ...rest] = info.trim().split(/\s+/);
  const words = first.includes('=') ? [first, ...rest] : rest;
  const out: CodeInfo = first && !first.includes('=') ? { language: first } : {};
  for (const w of words) {
    const eq = w.indexOf('=');
    if (eq < 0) continue;
    const key = w.slice(0, eq);
    const value = w.slice(eq + 1).replace(/^["']|["']$/g, '');
    if (key === 'path' || key === 'file') out.path = value;
    else if (key === 'start' || key === 'from') {
      const n = Number(value);
      if (n > 0) out.startLine = n;
    } else if (key === 'lines') {
      const [from] = lineList(value);
      if (from) out.startLine = from;
    } else if (key === 'highlight' || key === 'hl') out.highlight = lineList(value);
  }
  return out;
}

const cells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
const SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

export function blocks(markdown: string): Block[] {
  const out: Block[] = [];
  const lines = markdown.replace(/\r/g, '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^\s*(```+|~~~+)(.*)$/.exec(line);
    if (fence) {
      const close = fence[1]!;
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i]!.trim().startsWith(close); i++) body.push(lines[i]!);
      out.push({ kind: 'code', code: body.join('\n'), info: parseInfo(fence[2] ?? '') });
      continue;
    }
    if (line.includes('|') && SEPARATOR.test(lines[i + 1] ?? '')) {
      const head = cells(line);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && lines[i]!.includes('|') && lines[i]!.trim(); i++) rows.push(cells(lines[i]!));
      i--;
      out.push({ kind: 'table', head, rows });
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      out.push({ kind: 'h', level: heading[1]!.length as 1 | 2 | 3, text: heading[2]!.trim() });
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const number = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const prev = out.at(-1);
    if (bullet || number) {
      const kind = bullet ? 'ul' : 'ol';
      const item = (bullet ?? number)![1]!;
      if (prev && prev.kind === kind) prev.items.push(item);
      else out.push({ kind, items: [item] });
    } else if (!line.trim()) {
      out.push({ kind: 'p', text: '' });
    } else if (prev?.kind === 'p' && prev.text) {
      prev.text += ` ${line.trim()}`;
    } else {
      out.push({ kind: 'p', text: line.trim() });
    }
  }
  return out.filter((b) => b.kind !== 'p' || b.text);
}

/** A diff row in the terminal's style: a sign column, a faint red or green row, monochrome text. */
export interface DiffRow {
  n?: number;
  sign: '+' | '-' | ' ';
  text: string;
}

/** Diff rows from a diff's lines ("+x", "-y", " z"), numbered from start when known (removed lines keep the old count). */
export function diffRows(lines: string[], start?: { old: number; new: number }): DiffRow[] {
  let oldN = start?.old;
  let newN = start?.new;
  return lines
    .filter((l) => !/^(\+\+\+|---|@@)/.test(l))
    .map((l) => {
      const sign: DiffRow['sign'] = l[0] === '+' ? '+' : l[0] === '-' ? '-' : ' ';
      const text = sign === ' ' && l[0] !== ' ' ? l : l.slice(1);
      const n = sign === '-' ? oldN : newN;
      if (sign !== '+' && oldN !== undefined) oldN++;
      if (sign !== '-' && newN !== undefined) newN++;
      return { ...(n !== undefined ? { n } : {}), sign, text };
    });
}

export function DiffLines({ rows }: { rows: DiffRow[] }) {
  const numbered = rows.some((r) => r.n !== undefined);
  return (
    <div className={`diff${numbered ? '' : ' diff--plain'}`}>
      {rows.map((r, i) => (
        <div key={i} className={`diff-row${r.sign === '+' ? ' diff-row--add' : r.sign === '-' ? ' diff-row--del' : ''}`}>
          {numbered && <span className="diff-n">{r.n ?? ''}</span>}
          <span className="diff-sign">{r.sign === '-' ? '−' : r.sign === '+' ? '+' : ''}</span>
          <span className="diff-text">{r.text}</span>
        </div>
      ))}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="code-copy"
      onClick={() =>
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        })
      }
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

/**
 * Code: a header with the file, the line range and Copy, then numbered lines, the referenced ones lighter with a white
 * bar. `plain` is a tool's output: mono text, no header or numbers.
 */
export function CodeBlock({ code, info = {}, diff, plain }: { code: string; info?: CodeInfo; diff?: boolean; plain?: boolean }) {
  const text = code.replace(/\n$/, '');
  if (plain) return <pre className="code code--plain">{text}</pre>;
  const lines = text.split('\n');
  const start = info.startLine ?? 1;
  const end = start + lines.length - 1;
  const highlight = new Set(info.highlight ?? []);
  const isDiff = diff || info.language === 'diff';
  const range =
    info.highlight?.length === 1 ? `line ${info.highlight[0]}` : info.startLine !== undefined ? (lines.length === 1 ? `line ${start}` : `lines ${start}–${end}`) : undefined;
  return (
    <div className="code">
      <div className="code-head">
        {info.path ? <span className="code-path">{info.path}</span> : <span className="code-lang">{info.language ?? (isDiff ? 'diff' : 'code')}</span>}
        {range && <span className="code-range">{range}</span>}
        <CopyButton text={text} />
      </div>
      {isDiff ? (
        <DiffLines rows={diffRows(lines, info.startLine !== undefined ? { old: start, new: start } : undefined)} />
      ) : (
        <div className="code-body">
          {lines.map((l, i) => (
            <div key={i} className={`code-row${highlight.has(start + i) ? ' code-row--hl' : ''}`}>
              <span className="code-n">{start + i}</span>
              <span className="code-text">{l}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const DOTS: Record<string, string> = { '🔴': 'failed', '🟠': 'waiting', '🟡': 'waiting', '🟢': 'done', '🔵': 'running', '⚪': 'idle' };

function Cell({ text }: { text: string }) {
  const dot = Object.keys(DOTS).find((d) => text.startsWith(d));
  if (!dot) return <>{inline(text)}</>;
  return (
    <>
      <span className={`dot dot--${DOTS[dot]}`} />
      {inline(text.slice(dot.length).trim())}
    </>
  );
}

function Table({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <div className="md-table">
      <table>
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i}>{inline(h)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {head.map((_, j) => (
                <td key={j}>
                  <Cell text={r[j] ?? ''} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={className ? `md ${className}` : 'md'}>
      {blocks(text).map((b, i) => {
        switch (b.kind) {
          case 'p':
            return <p key={i}>{inline(b.text)}</p>;
          case 'h':
            return b.level === 1 ? <h3 key={i}>{inline(b.text)}</h3> : b.level === 2 ? <h4 key={i}>{inline(b.text)}</h4> : <h5 key={i}>{inline(b.text)}</h5>;
          case 'ul':
            return (
              <ul key={i}>
                {b.items.map((it, j) => (
                  <li key={j}>{inline(it)}</li>
                ))}
              </ul>
            );
          case 'ol':
            return (
              <ol key={i}>
                {b.items.map((it, j) => (
                  <li key={j}>{inline(it)}</li>
                ))}
              </ol>
            );
          case 'code':
            return <CodeBlock key={i} code={b.code} info={b.info} />;
          case 'table':
            return <Table key={i} head={b.head} rows={b.rows} />;
        }
      })}
    </div>
  );
}
