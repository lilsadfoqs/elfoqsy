// The composer, like Claude web's: multi-line, attach a file or a screenshot (button, paste or drop),
// and a round send button. Enter sends, Shift+Enter starts a new line. Files go up as soon as they are
// chosen; the message names them by id.
import { useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import type { Attachment } from '@elfoqsy/contracts';
import { stream } from '../../state/workspace';
import { sizeLabel } from '../model';

const ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,text/plain,text/markdown,text/csv,application/json,application/pdf,.md,.log,.txt,.csv,.json';
const MAX_FILES = 8;

type Pending = { key: string; name: string; state: 'uploading' } | { key: string; name: string; state: 'ready'; attachment: Attachment } | { key: string; name: string; state: 'failed'; error: string };

/** A file's type as the daemon accepts it: logs and Markdown count as text. */
function mediaType(file: File): string {
  if (file.type) return file.type;
  if (/\.(log|txt)$/i.test(file.name)) return 'text/plain';
  if (/\.md$/i.test(file.name)) return 'text/markdown';
  return 'application/octet-stream';
}

async function upload(file: File): Promise<Attachment> {
  const res = await fetch('/attachments', {
    method: 'POST',
    headers: { 'content-type': mediaType(file), 'x-file-name': encodeURIComponent(file.name || 'screenshot.png') },
    body: file,
  });
  const body = (await res.json()) as Attachment | { error: string };
  if (!res.ok || 'error' in body) throw new Error('error' in body ? body.error : `Upload failed (${res.status}).`);
  return body;
}

export function Composer({ conversationId, onSent }: { conversationId: string | undefined; onSent: () => void }) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState<Pending[]>([]);
  const picker = useRef<HTMLInputElement>(null);
  const uploading = files.some((f) => f.state === 'uploading');
  const canSend = text.trim().length > 0 && !uploading;

  const add = (list: FileList | File[]) => {
    for (const file of [...list].slice(0, MAX_FILES - files.length)) {
      const key = `${file.name}-${file.size}-${Math.random()}`;
      setFiles((f) => [...f, { key, name: file.name || 'screenshot.png', state: 'uploading' }]);
      upload(file).then(
        (attachment) => setFiles((f) => f.map((p) => (p.key === key ? { key, name: attachment.name, state: 'ready', attachment } : p))),
        (error: Error) => setFiles((f) => f.map((p) => (p.key === key ? { key, name: p.name, state: 'failed', error: error.message } : p))),
      );
    }
  };

  const send = () => {
    if (!canSend) return;
    const ids = files.flatMap((f) => (f.state === 'ready' ? [f.attachment.attachmentId] : []));
    if (stream.say(text.trim(), conversationId, ids)) {
      setText('');
      setFiles([]);
      onSent();
    }
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (e.clipboardData.files.length) {
      e.preventDefault();
      add(e.clipboardData.files);
    }
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    add(e.dataTransfer.files);
  };

  return (
    <div className="composer" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <label htmlFor="message-elfoqsy" className="visually-hidden">
        Message Elfoqsy
      </label>
      <textarea id="message-elfoqsy" rows={2} placeholder="Message Elfoqsy" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} onPaste={onPaste} />
      {files.length > 0 && (
        <div className="composer-files">
          {files.map((f) => (
            <span key={f.key} className={`composer-file composer-file--${f.state}`} data-tip={f.state === 'failed' ? f.error : f.name}>
              <span className="composer-file-name">{f.name}</span>
              <span className="composer-file-state">{f.state === 'uploading' ? 'uploading' : f.state === 'failed' ? f.error : sizeLabel(f.attachment.bytes)}</span>
              <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles((all) => all.filter((x) => x.key !== f.key))}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="composer-bar">
        <button type="button" className="icon-button" aria-label="Attach a file or screenshot" data-tip="Attach a file or screenshot" onClick={() => picker.current?.click()}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m21 12-8.5 8.5a5.5 5.5 0 0 1-7.8-7.8L13.5 4a3.7 3.7 0 0 1 5.2 5.2l-8.8 8.8a1.8 1.8 0 0 1-2.6-2.6L15 7.7" />
          </svg>
        </button>
        <input
          ref={picker}
          type="file"
          multiple
          accept={ACCEPT}
          hidden
          onChange={(e) => {
            if (e.target.files) add(e.target.files);
            e.target.value = '';
          }}
        />
        <button type="button" className="send" aria-label="Send" data-tip="Send" disabled={!canSend} onClick={send}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 19V5M5 12l7-7 7 7" />
          </svg>
        </button>
      </div>
    </div>
  );
}
