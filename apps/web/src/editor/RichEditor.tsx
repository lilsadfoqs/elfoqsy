// The WYSIWYG editor for Jira's rich text : a Jira-like toolbar (text style, bold, italic, inline
// code, link, bullet and numbered lists, table, code block, and a mention for comments), reading and writing ADF. Below
// it, Save and Cancel, and when someone else changed the field meanwhile, their name and "See theirs".
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { baseKeymap, setBlockType, toggleMark } from 'prosemirror-commands';
import { history, redo, undo } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';
import type { MarkType, NodeType } from 'prosemirror-model';
import { liftListItem, sinkListItem, splitListItem, wrapInList } from 'prosemirror-schema-list';
import { EditorState, type Command, type Transaction } from 'prosemirror-state';
import { goToNextCell, tableEditing } from 'prosemirror-tables';
import { EditorView } from 'prosemirror-view';
import { initials } from '@elfoqsy/state';
import { Floating, refTo, useLayer } from '../ui/layers';
import { adfToPm, pmToAdf, schema, type AdfNode } from './adfSchema';

export interface Conflict {
  by?: string;
  at?: string;
}

interface Props {
  initial: unknown;
  onSave: (doc: AdfNode) => void;
  onCancel: () => void;
  saving?: boolean;
  /** Someone else changed it since this editor opened: theirs is shown on "See theirs". */
  conflict?: Conflict;
  onSeeTheirs?: () => void;
  /** People to mention (comments). */
  people?: Array<{ accountId: string; displayName: string }>;
  label: string;
  error?: string;
  autoFocus?: boolean;
  /** Inside a form (his create form): every change is reported, and the form has the buttons. */
  onChange?: (doc: AdfNode) => void;
  /** Asked before Save writes over someone else's version (ReplaceAsk); it takes the footer while it asks. */
  ask?: ReactNode;
}

const N = schema.nodes;
const M = schema.marks;

const markActive = (state: EditorState, type: MarkType): boolean => {
  const { from, $from, to, empty } = state.selection;
  return empty ? !!type.isInSet(state.storedMarks ?? $from.marks()) : state.doc.rangeHasMark(from, to, type);
};
const blockIs = (state: EditorState, type: NodeType, attrs?: Record<string, unknown>): boolean => {
  const parent = state.selection.$from.parent;
  return parent.type === type && (!attrs || Object.entries(attrs).every(([k, v]) => parent.attrs[k] === v));
};
const inList = (state: EditorState, type: NodeType): boolean => {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) if ($from.node(d).type === type) return true;
  return false;
};

/** A list on or off: lift out of it when inside, wrap in it otherwise. */
const toggleList =
  (type: NodeType): Command =>
  (state, dispatch, view) =>
    inList(state, type) ? liftListItem(N.listItem!)(state, dispatch, view) : wrapInList(type)(state, dispatch, view);

/** A 3×3 table with a header row, after the current block. */
const insertTable: Command = (state, dispatch) => {
  const cell = (type: NodeType) => type.createAndFill()!;
  const row = (type: NodeType) => N.table_row!.create(null, [cell(type), cell(type), cell(type)]);
  const table = N.table!.create(null, [row(N.table_header!), row(N.table_cell!), row(N.table_cell!)]);
  if (dispatch) dispatch(state.tr.replaceSelectionWith(table).scrollIntoView());
  return true;
};

const setLink =
  (href: string): Command =>
  (state, dispatch) => {
    const { from, to, empty } = state.selection;
    if (!dispatch) return true;
    let tr = state.tr.removeMark(from, to, M.link!);
    if (href) {
      if (empty) tr = tr.insertText(href, from, to).addMark(from, from + href.length, M.link!.create({ href }));
      else tr = tr.addMark(from, to, M.link!.create({ href }));
    }
    dispatch(tr.scrollIntoView());
    return true;
  };

const STYLES: Array<{ label: string; command: Command; active: (s: EditorState) => boolean }> = [
  { label: 'Normal text', command: setBlockType(N.paragraph!), active: (s) => blockIs(s, N.paragraph!) },
  { label: 'Heading 1', command: setBlockType(N.heading!, { level: 1 }), active: (s) => blockIs(s, N.heading!, { level: 1 }) },
  { label: 'Heading 2', command: setBlockType(N.heading!, { level: 2 }), active: (s) => blockIs(s, N.heading!, { level: 2 }) },
  { label: 'Heading 3', command: setBlockType(N.heading!, { level: 3 }), active: (s) => blockIs(s, N.heading!, { level: 3 }) },
];

function Tool({ label, active, onClick, children }: { label: string; active?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className={`ed-tool${active ? ' ed-tool--on' : ''}`} aria-label={label} data-tip={label} aria-pressed={active} onMouseDown={(e) => e.preventDefault()} onClick={onClick}>
      {children}
    </button>
  );
}

export function RichEditor({ initial, onSave, onCancel, saving, conflict, onSeeTheirs, people, label, error, autoFocus = true, onChange, ask }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const changed = useRef(onChange);
  changed.current = onChange;
  const [, setTick] = useState(0);
  const [linking, setLinking] = useState<string | null>(null);
  const [mentioning, setMentioning] = useState<string | null>(null);
  // The text style menu is a floating layer: a click outside or Escape closes it.
  const styleMenu = useLayer('menu');

  useEffect(() => {
    const state = EditorState.create({
      doc: adfToPm(initial as AdfNode | null),
      plugins: [
        history(),
        keymap({
          'Mod-z': undo,
          'Mod-y': redo,
          'Mod-Shift-z': redo,
          'Mod-b': toggleMark(M.strong!),
          'Mod-i': toggleMark(M.em!),
          'Mod-e': toggleMark(M.code!),
          Enter: splitListItem(N.listItem!),
          Tab: (s, d) => goToNextCell(1)(s, d) || sinkListItem(N.listItem!)(s, d),
          'Shift-Tab': (s, d) => goToNextCell(-1)(s, d) || liftListItem(N.listItem!)(s, d),
          'Mod-Enter': () => {
            if (view.current && !onChange) onSave(pmToAdf(view.current.state.doc));
            return true;
          },
          Escape: () => {
            if (!onChange) onCancel();
            return !onChange;
          },
        }),
        keymap(baseKeymap),
        tableEditing(),
      ],
    });
    const v = new EditorView(host.current!, {
      state,
      attributes: { class: 'ed-content adf md', 'aria-label': label, role: 'textbox', 'aria-multiline': 'true' },
      dispatchTransaction(tr: Transaction) {
        v.updateState(v.state.apply(tr));
        setTick((t) => t + 1);
        if (tr.docChanged) changed.current?.(pmToAdf(v.state.doc));
        // "@" starts a mention, in comments.
        if (people && tr.docChanged) {
          const { $from } = v.state.selection;
          const before = $from.parent.textBetween(Math.max(0, $from.parentOffset - 30), $from.parentOffset, undefined, '￼');
          const m = /(^|\s)@([\p{L} .'-]{0,24})$/u.exec(before);
          setMentioning(m ? m[2]! : null);
        }
      },
    });
    view.current = v;
    if (autoFocus) v.focus();
    return () => v.destroy();
    // The editor is made once per opening; its document is its own from then on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = (c: Command) => {
    const v = view.current;
    if (!v) return;
    c(v.state, v.dispatch, v);
    v.focus();
  };
  const state = view.current?.state;
  const style = state ? (STYLES.find((s) => s.active(state))?.label ?? 'Normal text') : 'Normal text';

  const mention = (p: { accountId: string; displayName: string }) => {
    const v = view.current;
    if (!v) return;
    const { $from, from } = v.state.selection;
    const typed = /@[\p{L} .'-]{0,24}$/u.exec($from.parent.textBetween(Math.max(0, $from.parentOffset - 30), $from.parentOffset));
    const start = typed ? from - typed[0].length : from;
    const node = N.mention!.create({ adf: { id: p.accountId, text: `@${p.displayName}`, accessLevel: '' } });
    v.dispatch(v.state.tr.replaceWith(start, from, [node, schema.text(' ')]).scrollIntoView());
    setMentioning(null);
    v.focus();
  };
  const matches = mentioning !== null && people ? people.filter((p) => p.displayName.toLowerCase().includes(mentioning.trim().toLowerCase())).slice(0, 6) : [];

  return (
    <div className="ed" aria-busy={saving}>
      <div className="ed-toolbar" role="toolbar" aria-label={`${label} formatting`}>
        <div className="ed-style">
          <button ref={refTo(styleMenu.anchor)} type="button" className="ed-tool ed-tool--text" aria-haspopup="menu" aria-expanded={styleMenu.open} onMouseDown={(e) => e.preventDefault()} onClick={styleMenu.toggle}>
            {style}
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
          <Floating layer={styleMenu} side="bottom" align="start" className="ed-menu" role="menu" onMouseDown={(e) => e.preventDefault()}>
            {STYLES.map((s) => (
              <button
                key={s.label}
                type="button"
                role="menuitem"
                className={`ed-menu-item${state && s.active(state) ? ' ed-menu-item--on' : ''}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  run(s.command);
                  styleMenu.hide();
                }}
              >
                {s.label}
              </button>
            ))}
          </Floating>
        </div>
        <span className="ed-sep" aria-hidden="true" />
        <Tool label="Bold" active={!!state && markActive(state, M.strong!)} onClick={() => run(toggleMark(M.strong!))}>
          <b>B</b>
        </Tool>
        <Tool label="Italic" active={!!state && markActive(state, M.em!)} onClick={() => run(toggleMark(M.em!))}>
          <i>I</i>
        </Tool>
        <Tool label="Inline code" active={!!state && markActive(state, M.code!)} onClick={() => run(toggleMark(M.code!))}>
          <span className="ed-mono">&lt;/&gt;</span>
        </Tool>
        <Tool label="Link" active={!!state && markActive(state, M.link!)} onClick={() => setLinking(linking === null ? '' : null)}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" />
          </svg>
        </Tool>
        <span className="ed-sep" aria-hidden="true" />
        <Tool label="Bullet list" active={!!state && inList(state, N.bulletList!)} onClick={() => run(toggleList(N.bulletList!))}>
          <span className="ed-mono">•≡</span>
        </Tool>
        <Tool label="Numbered list" active={!!state && inList(state, N.orderedList!)} onClick={() => run(toggleList(N.orderedList!))}>
          <span className="ed-mono">1≡</span>
        </Tool>
        <Tool label="Table" onClick={() => run(insertTable)}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <rect x="3" y="4" width="18" height="16" rx="1.5" />
            <path d="M3 10h18M3 15h18M9 4v16M15 4v16" />
          </svg>
        </Tool>
        <Tool label="Code block" active={!!state && blockIs(state, N.codeBlock!)} onClick={() => run(blockIs(view.current!.state, N.codeBlock!) ? setBlockType(N.paragraph!) : setBlockType(N.codeBlock!))}>
          <span className="ed-mono">{'{ }'}</span>
        </Tool>
        {people && (
          <Tool label="Mention someone" onClick={() => setMentioning(mentioning === null ? '' : null)}>
            <span className="ed-mono">@</span>
          </Tool>
        )}
      </div>
      {linking !== null && (
        <div className="ed-inline-form">
          <input
            autoFocus
            type="url"
            className="ed-input"
            placeholder="Paste a link and press Enter; empty removes it"
            aria-label="Link address"
            value={linking}
            onChange={(e) => setLinking(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                run(setLink(linking.trim()));
                setLinking(null);
              } else if (e.key === 'Escape') setLinking(null);
            }}
          />
        </div>
      )}
      <div ref={host} className="ed-host" />
      {mentioning !== null && people && (
        <div className="ed-mentions" role="listbox" aria-label="People">
          {mentioning === '' && <span className="ed-hint">Type a name after @</span>}
          {matches.map((p) => (
            <button key={p.accountId} type="button" role="option" aria-selected={false} className="ed-mention" onMouseDown={(e) => e.preventDefault()} onClick={() => mention(p)}>
              <span className="person-initials person-initials--small" aria-hidden="true">
                {initials(p.displayName)}
              </span>
              {p.displayName}
            </button>
          ))}
        </div>
      )}
      {!onChange && (
        <div className="ed-foot">
          <span className="ed-note">
            {conflict ? (
              <>
                <span className="person-initials person-initials--small" aria-hidden="true">
                  {initials(conflict.by ?? 'Someone')}
                </span>
                {conflict.by ?? 'Someone'} changed {label} while you were editing
              </>
            ) : error ? (
              <span className="ed-error">{error}</span>
            ) : null}
          </span>
          {ask ?? (
            <>
              {conflict && onSeeTheirs && (
                <button type="button" className="button-outline button-outline--small" onClick={onSeeTheirs}>
                  See theirs
                </button>
              )}
              <button type="button" className="button-outline button-outline--small" onClick={onCancel}>
                Cancel
              </button>
              <button type="button" className="button-solid button-solid--small" disabled={saving} onClick={() => view.current && onSave(pmToAdf(view.current.state.doc))}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
