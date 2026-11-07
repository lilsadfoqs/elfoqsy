// Jira's rich text (Atlassian Document Format) on screen: headings, paragraphs, lists, task lists, tables, code
// blocks, inline code (v1.2's rule), marks, links, mentions, emoji, dates, status lozenges, expands, panels and media.
// Everything in it is untrusted text: rendered as React text, never as HTML, never executed. Links are sorted here:
// a ticket key or a Jira issue link opens inside Elfoqsy, a Confluence page shows as a chip with its title, anything
// else opens in a new tab. Panels are an icon beside the text: no fill, no stripe. Colour marks are dropped (monochrome
// for reading).
import { Fragment, type ReactNode } from 'react';
import { LinkIcon, ToolMark } from './Icons';

export interface AdfNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  content?: AdfNode[];
}

export interface AdfContext {
  /** https://acme.atlassian.net, to tell its links apart. */
  site: string;
  /** Opens a ticket inside Elfoqsy. */
  openTicket: (key: string) => void;
  /** Confluence page titles by page id, looked up by the daemon. */
  confluence: Record<string, string>;
  /** The ticket's attachments, to show its images and files. */
  attachments: Array<{ id: string; filename: string; mimeType?: string; size?: number }>;
  /** Project keys whose plain-text keys are links (SHOP-1234 in a sentence). */
  projects: Set<string>;
}

/** The node types this renderer shows as Jira does; the editor uses the same list to know what it may edit. */
export const RENDERED_NODES = new Set([
  'doc',
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'listItem',
  'taskList',
  'taskItem',
  'decisionList',
  'decisionItem',
  'blockquote',
  'codeBlock',
  'rule',
  'panel',
  'expand',
  'nestedExpand',
  'table',
  'tableRow',
  'tableHeader',
  'tableCell',
  'mediaSingle',
  'mediaGroup',
  'media',
  'mediaInline',
  'hardBreak',
  'text',
  'mention',
  'emoji',
  'date',
  'status',
  'inlineCard',
  'blockCard',
  'embedCard',
]);

const KEY = /\b([A-Z][A-Z0-9]+)-(\d+)\b/g;

/** What a URL is: a ticket here, a Confluence page here (its id), or somewhere else. */
export function classifyUrl(url: string, site: string): { kind: 'ticket'; key: string } | { kind: 'confluence'; pageId: string } | { kind: 'external' } {
  const host = site.replace(/^https?:\/\//, '').replace(/\/$/, '');
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { kind: 'external' };
  }
  if (u.host === host) {
    const ticket = /^\/browse\/([A-Z][A-Z0-9]+-\d+)/.exec(u.pathname) ?? /selectedIssue=([A-Z][A-Z0-9]+-\d+)/.exec(u.search);
    if (ticket) return { kind: 'ticket', key: ticket[1]! };
    const page = /\/wiki\/.*?pages\/(\d+)/.exec(u.pathname) ?? (/\/wiki\//.test(u.pathname) ? /pageId=(\d+)/.exec(u.search) : null);
    if (page) return { kind: 'confluence', pageId: page[1]! };
  }
  return { kind: 'external' };
}

/** A key that opens a ticket inside Elfoqsy. */
export function TicketLink({ ticketKey, ctx, children }: { ticketKey: string; ctx: AdfContext; children?: ReactNode }) {
  return (
    <a
      href={`${ctx.site.replace(/\/$/, '')}/browse/${ticketKey}`}
      className="adf-key"
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // a new tab still goes to Jira
        e.preventDefault();
        ctx.openTicket(ticketKey);
      }}
    >
      {children ?? ticketKey}
    </a>
  );
}

/** A Confluence page as Jira shows it: its icon and its title. */
export function ConfluenceChip({ url, title }: { url: string; title: string }) {
  return (
    <a className="confluence-chip" href={url} target="_blank" rel="noreferrer noopener">
      <ToolMark name="confluence" />
      {title}
    </a>
  );
}

function LinkTo({ url, ctx, children }: { url: string; ctx: AdfContext; children?: ReactNode }) {
  const c = classifyUrl(url, ctx.site);
  if (c.kind === 'ticket') return <TicketLink ticketKey={c.key} ctx={ctx}>{children}</TicketLink>;
  if (c.kind === 'confluence') {
    const title = ctx.confluence[c.pageId];
    // A link whose words are its own address shows the page's title instead, as Jira does.
    if (title && (children === undefined || children === url)) return <ConfluenceChip url={url} title={title} />;
  }
  return (
    <a href={safeHref(url)} target="_blank" rel="noreferrer noopener">
      <LinkIcon url={url} />
      {children ?? url}
    </a>
  );
}

/** Only web and mail links; anything else (javascript:, data:) becomes inert. */
const safeHref = (url: string): string => (/^(https?:|mailto:)/i.test(url) ? url : '#');

/** Plain text with ticket keys of known projects made into links. */
function withKeys(text: string, ctx: AdfContext, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(KEY)) {
    if (!ctx.projects.has(m[1]!)) continue;
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(<TicketLink key={`${keyPrefix}-${m.index}`} ticketKey={m[0]} ctx={ctx} />);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function TextNode({ node, ctx, k }: { node: AdfNode; ctx: AdfContext; k: string }) {
  const marks = node.marks ?? [];
  const link = marks.find((m) => m.type === 'link' && typeof m.attrs?.href === 'string');
  const code = marks.some((m) => m.type === 'code');
  let body: ReactNode = code || link ? (node.text ?? '') : withKeys(node.text ?? '', ctx, k);
  if (code) body = <code>{body}</code>;
  for (const m of marks) {
    if (m.type === 'strong') body = <strong>{body}</strong>;
    else if (m.type === 'em') body = <em>{body}</em>;
    else if (m.type === 'strike') body = <s>{body}</s>;
    else if (m.type === 'underline') body = <u>{body}</u>;
    else if (m.type === 'subsup') body = m.attrs?.type === 'sup' ? <sup>{body}</sup> : <sub>{body}</sub>;
  }
  return link ? <LinkTo url={String(link.attrs!.href)} ctx={ctx}>{node.text === link.attrs!.href ? undefined : body}</LinkTo> : <>{body}</>;
}

const STATUS_TONE: Record<string, string> = { neutral: 'todo', purple: 'todo', blue: 'in-progress', red: 'blocked', yellow: 'todo', green: 'done' };

const PANEL_ICON: Record<string, { label: string; d: string; tone: string }> = {
  info: { label: 'Info', d: 'M12 16v-5M12 8h.01M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18', tone: 'info' },
  note: { label: 'Note', d: 'M8 4h8l4 4v12H4V4h4zM8 12h8M8 16h5', tone: 'note' },
  tip: { label: 'Tip', d: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.6.6 1 1.4 1 2.5h6c0-1.1.4-1.9 1-2.5A6 6 0 0 0 12 3', tone: 'success' },
  success: { label: 'Success', d: 'm5 12 4.5 4.5L19 7', tone: 'success' },
  warning: { label: 'Warning', d: 'M12 9v4M12 17h.01M10.3 3.9 2 18a2 2 0 0 0 1.7 3h16.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0', tone: 'warning' },
  error: { label: 'Error', d: 'M12 8v5M12 16h.01M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18', tone: 'danger' },
  custom: { label: 'Panel', d: 'M5 5h14v14H5z', tone: 'note' },
};

/** A media node's attachment: Jira matches them by file name (alt). */
const attachmentOf = (node: AdfNode, ctx: AdfContext) => {
  const alt = typeof node.attrs?.alt === 'string' ? node.attrs.alt : undefined;
  return alt ? ctx.attachments.find((a) => a.filename === alt) : undefined;
};

function Media({ node, ctx }: { node: AdfNode; ctx: AdfContext }) {
  const file = attachmentOf(node, ctx);
  const name = file?.filename ?? (typeof node.attrs?.alt === 'string' ? node.attrs.alt : 'Attached file');
  if (file && /^image\//.test(file.mimeType ?? '')) {
    const width = Number(node.attrs?.width) || undefined;
    return <img className="adf-image" src={`/jira/attachments/${file.id}`} alt={name} loading="lazy" style={width ? { width } : undefined} />;
  }
  return file ? (
    <a className="adf-file" href={`/jira/attachments/${file.id}`}>
      {name}
    </a>
  ) : (
    <span className="adf-file adf-file--unknown">{name}</span>
  );
}

function Block({ node, ctx, k }: { node: AdfNode; ctx: AdfContext; k: string }): ReactNode {
  const kids = (sep?: ReactNode) =>
    (node.content ?? []).map((c, i) => (
      <Fragment key={i}>
        {sep && i > 0 ? sep : null}
        <Block node={c} ctx={ctx} k={`${k}.${i}`} />
      </Fragment>
    ));
  const a = node.attrs ?? {};
  switch (node.type) {
    case 'doc':
      return <>{kids()}</>;
    case 'paragraph':
      return <p>{kids()}</p>;
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(a.level) || 3));
      const H = `h${Math.min(6, level + 1)}` as 'h2';
      return <H className={`adf-h adf-h${level}`}>{kids()}</H>;
    }
    case 'bulletList':
      return <ul>{kids()}</ul>;
    case 'orderedList':
      return <ol start={Number(a.order) > 1 ? Number(a.order) : undefined}>{kids()}</ol>;
    case 'listItem':
      return <li>{kids()}</li>;
    case 'taskList':
    case 'decisionList':
      return <ul className="adf-tasks">{kids()}</ul>;
    case 'taskItem':
    case 'decisionItem': {
      const done = a.state === 'DONE' || a.state === 'DECIDED';
      return (
        <li className={`adf-task${done ? ' adf-task--done' : ''}`}>
          <span className="adf-check" role="img" aria-label={done ? 'done' : 'to do'}>
            {done && (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m5 12 4.5 4.5L19 7" />
              </svg>
            )}
          </span>
          <span>{kids()}</span>
        </li>
      );
    }
    case 'blockquote':
      return <blockquote className="adf-quote">{kids()}</blockquote>;
    case 'codeBlock':
      return (
        <pre className="adf-code" data-language={typeof a.language === 'string' ? a.language : undefined}>
          <code>{(node.content ?? []).map((c) => c.text ?? '').join('')}</code>
        </pre>
      );
    case 'rule':
      return <hr />;
    case 'panel': {
      const icon = PANEL_ICON[String(a.panelType)] ?? PANEL_ICON.info!;
      return (
        <div className="adf-panel">
          <svg className={`adf-panel-icon adf-panel-icon--${icon.tone}`} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" role="img" aria-label={icon.label}>
            <path d={icon.d} />
          </svg>
          <div className="adf-panel-body">{kids()}</div>
        </div>
      );
    }
    case 'expand':
    case 'nestedExpand':
      return (
        <details className="adf-expand">
          <summary>{typeof a.title === 'string' && a.title ? a.title : 'Details'}</summary>
          {kids()}
        </details>
      );
    case 'table':
      return (
        <div className="adf-table-wrap">
          <table className="adf-table">
            <tbody>{kids()}</tbody>
          </table>
        </div>
      );
    case 'tableRow':
      return <tr>{kids()}</tr>;
    case 'tableHeader':
    case 'tableCell': {
      const Cell = node.type === 'tableHeader' ? 'th' : 'td';
      return (
        <Cell colSpan={Number(a.colspan) > 1 ? Number(a.colspan) : undefined} rowSpan={Number(a.rowspan) > 1 ? Number(a.rowspan) : undefined}>
          {kids()}
        </Cell>
      );
    }
    case 'mediaSingle':
    case 'mediaGroup':
      return <div className="adf-media">{kids()}</div>;
    case 'media':
    case 'mediaInline':
      return <Media node={node} ctx={ctx} />;
    case 'hardBreak':
      return <br />;
    case 'text':
      return <TextNode node={node} ctx={ctx} k={k} />;
    case 'mention': {
      const name = String(a.text ?? '@someone').replace(/^@/, '');
      return (
        <span className="adf-mention">
          <span className="person-initials person-initials--small" aria-hidden="true">
            {name
              .split(/\s+/)
              .map((w) => w[0])
              .join('')
              .slice(0, 2)
              .toUpperCase()}
          </span>
          {name}
        </span>
      );
    }
    case 'emoji':
      return <span className="adf-emoji">{String(a.text ?? a.shortName ?? '')}</span>;
    case 'date': {
      const ts = Number(a.timestamp);
      return <span className="adf-date">{Number.isFinite(ts) ? new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : ''}</span>;
    }
    case 'status':
      return <span className={`adf-status adf-status--${STATUS_TONE[String(a.color)] ?? 'todo'}`}>{String(a.text ?? '')}</span>;
    case 'inlineCard':
    case 'blockCard':
    case 'embedCard': {
      const url = typeof a.url === 'string' ? a.url : '';
      const card = url ? <LinkTo url={url} ctx={ctx} /> : <span className="adf-unknown">a card</span>;
      return node.type === 'inlineCard' ? card : <p>{card}</p>;
    }
    default:
      // Something Jira can show that this cannot: say so rather than drop it.
      return node.content?.length ? <>{kids()}</> : <span className="adf-unknown">[{node.type} shown in Jira]</span>;
  }
}

/** Every node type in a document. */
export function nodeTypes(doc: unknown, found = new Set<string>()): Set<string> {
  if (doc && typeof doc === 'object') {
    const n = doc as AdfNode;
    if (typeof n.type === 'string') found.add(n.type);
    for (const c of n.content ?? []) nodeTypes(c, found);
  }
  return found;
}

export function Adf({ doc, ctx, className }: { doc: unknown; ctx: AdfContext; className?: string }) {
  if (typeof doc === 'string') return <div className={`adf md ${className ?? ''}`}>{doc.split(/\n{2,}/).map((p, i) => <p key={i}>{withKeys(p, ctx, `s${i}`)}</p>)}</div>;
  if (!doc || typeof doc !== 'object') return null;
  return (
    <div className={`adf md ${className ?? ''}`}>
      <Block node={doc as AdfNode} ctx={ctx} k="0" />
    </div>
  );
}
