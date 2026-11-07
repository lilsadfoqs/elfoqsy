// Jira descriptions arrive as Atlassian Document Format. The workspace shows plain text, so this keeps
// the words and the shape that matters for reading (paragraphs, lists, code) and drops media.

export interface AdfNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
}

const BLOCKS = new Set(['paragraph', 'heading', 'blockquote', 'codeBlock', 'panel', 'rule', 'table', 'mediaSingle', 'expand', 'nestedExpand']);

const attr = (node: AdfNode, name: string): string | undefined => {
  const value = node.attrs?.[name];
  return typeof value === 'string' ? value : undefined;
};

function inline(node: AdfNode): string {
  switch (node.type) {
    case 'text':
      return node.text ?? '';
    case 'hardBreak':
      return '\n';
    case 'mention':
      return attr(node, 'text') ?? '@someone';
    case 'emoji':
      return attr(node, 'text') ?? attr(node, 'shortName') ?? '';
    case 'inlineCard':
    case 'blockCard':
    case 'embedCard':
      return attr(node, 'url') ?? '';
    case 'status':
      return attr(node, 'text') ?? '';
    case 'date': {
      const ts = Number(attr(node, 'timestamp'));
      return Number.isFinite(ts) ? new Date(ts).toISOString().slice(0, 10) : '';
    }
    case 'media':
    case 'mediaGroup':
    case 'mediaSingle':
      return '';
    default:
      return (node.content ?? []).map(inline).join('');
  }
}

function block(node: AdfNode, indent = ''): string {
  switch (node.type) {
    case 'bulletList':
    case 'orderedList':
      return (node.content ?? [])
        .map((item, i) => {
          const marker = node.type === 'orderedList' ? `${i + 1}. ` : '- ';
          const body = (item.content ?? []).map((child) => block(child, `${indent}  `)).join('\n');
          return `${indent}${marker}${body.trimStart()}`;
        })
        .join('\n');
    case 'table':
      return (node.content ?? [])
        .map((row) => (row.content ?? []).map((cell) => (cell.content ?? []).map((c) => block(c)).join(' ').trim()).join(' | '))
        .join('\n');
    case 'rule':
      return '---';
    case 'mediaSingle':
    case 'mediaGroup':
      return '';
    case 'codeBlock':
      return (node.content ?? []).map(inline).join('');
    default:
      if (node.content?.some((c) => BLOCKS.has(c.type) || c.type.endsWith('List'))) {
        return node.content.map((c) => block(c, indent)).filter(Boolean).join('\n\n');
      }
      return inline(node);
  }
}

/** Plain text of an ADF document; plain strings (older API shapes) pass through. */
export function adfToText(doc: unknown): string {
  if (typeof doc === 'string') return doc;
  if (!doc || typeof doc !== 'object') return '';
  const root = doc as AdfNode;
  return (root.content ?? [])
    .map((node) => block(node))
    .filter((text) => text.trim() !== '')
    .join('\n\n')
    .trim();
}
