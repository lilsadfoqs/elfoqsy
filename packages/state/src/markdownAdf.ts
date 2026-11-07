// Markdown, as Elfoqsy and the agents write it, as Atlassian Document Format for Jira's rich-text fields:
// headings, paragraphs, bullet and numbered lists (one level of nesting), fenced code, rules, and inline bold, italic,
// code and links. A bare link alone on its line is a card, as his writing rules ask. Shared: the daemon writes her
// edits with it, and the left screen fills a drafted ticket's Description with it.
type Node = Record<string, unknown>;

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*|_[^_\n]+_)|(\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

export function inlineAdf(text: string): Node[] {
  const out: Node[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push({ type: 'text', text: text.slice(last, m.index) });
    const [t] = m;
    if (m[1]) out.push({ type: 'text', text: t.slice(1, -1), marks: [{ type: 'code' }] });
    else if (m[2]) out.push({ type: 'text', text: t.slice(2, -2), marks: [{ type: 'strong' }] });
    else if (m[3]) out.push({ type: 'text', text: t.slice(1, -1), marks: [{ type: 'em' }] });
    else if (m[4]) {
      const [, label, href] = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(t)!;
      out.push({ type: 'text', text: label!, marks: [{ type: 'link', attrs: { href } }] });
    } else out.push({ type: 'text', text: t, marks: [{ type: 'link', attrs: { href: t } }] });
    last = m.index + t.length;
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) });
  return out.filter((n) => n.text !== '');
}

const paragraph = (lines: string[]): Node => {
  const one = lines.join('\n').trim();
  if (/^https?:\/\/\S+$/.test(one)) return { type: 'paragraph', content: [{ type: 'inlineCard', attrs: { url: one } }] };
  return { type: 'paragraph', content: lines.flatMap((l, i) => [...(i ? [{ type: 'hardBreak' }] : []), ...inlineAdf(l)]) };
};

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

export function markdownToAdf(markdown: string): Node {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const content: Node[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = /^```(\w*)/.exec(line);
    if (fence) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i]!)) code.push(lines[i++]!);
      i++;
      content.push({ type: 'codeBlock', ...(fence[1] ? { attrs: { language: fence[1] } } : {}), content: code.length ? [{ type: 'text', text: code.join('\n') }] : [] });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      content.push({ type: 'heading', attrs: { level: heading[1]!.length }, content: inlineAdf(heading[2]!) });
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      content.push({ type: 'rule' });
      i++;
      continue;
    }
    if (LIST_ITEM.test(line)) {
      // A list, with items one level deeper nested under the item before them.
      const items: Array<{ depth: number; ordered: boolean; text: string }> = [];
      while (i < lines.length && LIST_ITEM.test(lines[i]!)) {
        const [, indent, marker, text] = LIST_ITEM.exec(lines[i]!)!;
        items.push({ depth: indent!.length >= 2 ? 1 : 0, ordered: /\d/.test(marker!), text: text! });
        i++;
      }
      const list = (ordered: boolean): Node => ({ type: ordered ? 'orderedList' : 'bulletList', content: [] as Node[] });
      const top = list(items[0]!.ordered);
      for (const it of items) {
        const item: Node = { type: 'listItem', content: [paragraph([it.text])] };
        const topItems = top.content as Node[];
        if (it.depth === 1 && topItems.length) {
          const parent = topItems.at(-1)!;
          const kids = parent.content as Node[];
          let nested = kids.find((k) => k.type === 'bulletList' || k.type === 'orderedList');
          if (!nested) kids.push((nested = list(it.ordered)));
          (nested.content as Node[]).push(item);
        } else topItems.push(item);
      }
      content.push(top);
      continue;
    }
    const block: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^(#{1,6}\s|```)/.test(lines[i]!) && !LIST_ITEM.test(lines[i]!)) block.push(lines[i++]!);
    content.push(paragraph(block));
  }
  return { type: 'doc', version: 1, content };
}
