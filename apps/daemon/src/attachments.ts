// Files and screenshots alex attaches to a message. The workspace uploads them here first; the
// message then names them by id, and the daemon fills in what it stored, so a client cannot claim a name,
// type or size the file does not have. Text is redacted before it is written, like everything else.
// Stored under the data folder, which agents cannot read.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Attachment } from '@elfoqsy/contracts';
import { redact } from './redact';
import { ulid } from './ulid';

export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const ATTACHMENTS_PER_MESSAGE = 8;

/** What may be attached, and how it is kept: text is redacted, images and PDFs are kept as they are. */
export const ATTACHMENT_TYPES: Record<string, 'text' | 'image' | 'binary'> = {
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/gif': 'image',
  'image/webp': 'image',
  'text/plain': 'text',
  'text/markdown': 'text',
  'text/csv': 'text',
  'application/json': 'text',
  'application/pdf': 'binary',
};

const ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export class AttachmentError extends Error {}

/** A file name as shown: no folders, no control characters, at most 120 characters, redacted. */
export function cleanName(name: string): string {
  const base = basename(name.replace(/\\/g, '/'))
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 120);
  return redact(base) || 'attachment';
}

export class AttachmentStore {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  save(name: string, mediaType: string, body: Buffer): Attachment {
    const type = mediaType.split(';')[0]!.trim().toLowerCase();
    const kind = ATTACHMENT_TYPES[type];
    if (!kind) throw new AttachmentError(`${type || 'That type'} cannot be attached; images, text, JSON, CSV and PDF can.`);
    if (!body.length) throw new AttachmentError('That file is empty.');
    if (body.length > ATTACHMENT_MAX_BYTES) throw new AttachmentError('That file is over 10 MB.');
    const stored = kind === 'text' ? Buffer.from(redact(body.toString('utf8')), 'utf8') : body;
    const attachment: Attachment = { attachmentId: ulid(), name: cleanName(name), mediaType: type, bytes: stored.length };
    const file = join(this.dir, attachment.attachmentId);
    writeFileSync(file, stored, { mode: 0o600 });
    writeFileSync(`${file}.json`, JSON.stringify(attachment), { mode: 0o600 });
    chmodSync(file, 0o600);
    return attachment;
  }

  get(id: string): { attachment: Attachment; file: string } | undefined {
    if (!ID.test(id)) return undefined;
    const file = join(this.dir, id);
    if (!existsSync(file) || !existsSync(`${file}.json`)) return undefined;
    return { attachment: JSON.parse(readFileSync(`${file}.json`, 'utf8')) as Attachment, file };
  }
}
