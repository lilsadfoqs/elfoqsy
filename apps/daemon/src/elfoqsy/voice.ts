// The lines the workspace writes in her voice (the digest, the one-line notices) are in the language of his latest message, as her
// identity says: English, or Vietnamese with "tôi" for herself and "cậu" for him. Not a translation of a table: each line is written
// twice where it is made, and tr picks. Her own replies are not here: they are written by the model, which answers in his language.
import type { EventLog } from '../eventLog';

export type Lang = 'en' | 'vi';

/** The language of his latest message. English until he has written. */
export const language: { current: Lang } = { current: 'en' };

/** Her words, in the language of his latest message: tr('English', 'Tiếng Việt'). */
export const tr = <T>(en: T, vi: T): T => (language.current === 'vi' ? vi : en);

/** The `lang` an event carries when her line in it is in Vietnamese, for the web to word the rest of it the same way; nothing for English. */
export const langField = (): { lang?: 'vi' } => (language.current === 'vi' ? { lang: 'vi' } : {});

/** Runs `work` with another language, and puts the language back: for tests and for a line that is about someone else's. */
export function inLanguage<T>(lang: Lang, work: () => T): T {
  const before = language.current;
  language.current = lang;
  try {
    return work();
  } finally {
    language.current = before;
  }
}

// Letters only Vietnamese has: đ, ă, ơ, ư, and the vowels with a second mark (ạ ả ấ ầ ẩ ẫ ậ ế ề ể ễ ệ ố ồ ổ ỗ ộ ớ ờ ở ỡ ợ ứ ừ ử ữ ự ...).
// â, ê, ô and plain accents are shared with French and Portuguese, so they decide nothing alone.
const VIETNAMESE_ONLY = /[đĐăĂơƠưƯẠ-ỹ]/;
// Words people write without the accents. Three different ones, since a name or an English word can be one of them.
// They are matched with the accents taken off, so a sentence with only the accents French has ("Làm giúp tôi cái này") is read too.
const UNACCENTED = new Set(['toi', 'khong', 'duoc', 'nhe', 'giup', 'cua', 'roi', 'nhung', 'muon', 'nhieu', 'cau', 'minh', 'voi', 'cho', 'nay', 'nao', 'thi', 'lam', 'xem', 'dung', 'cai', 'biet', 'xong', 'sao', 'vay', 'dang', 'chua', 'gio', 'nhin']);
const stripAccents = (text: string): string => text.normalize('NFD').replace(/\p{M}/gu, '').replace(/[đĐ]/g, 'd');

// What says nothing about the language of a message: addresses, `code`, paths, ticket keys.
const NOISE = /https?:\/\/\S+|`[^`]*`|\S*\/\S*|\b[A-Za-z][A-Za-z0-9]*-\d+\b/g;

/**
 * The language a message is written in: Vietnamese when it has letters only Vietnamese has, or three of the words above; English when
 * it is plain Latin text of two words or more; undefined when it says nothing either way ("ok", a ticket key, a /command, an emoji):
 * the language before it stays.
 */
export function languageOf(text: string): Lang | undefined {
  const t = text.normalize('NFC');
  if (VIETNAMESE_ONLY.test(t)) return 'vi';
  if (t.trimStart().startsWith('/')) return undefined;
  const plain = t.replace(NOISE, ' ');
  const bare = stripAccents(plain).toLowerCase().match(/[a-z]+/g) ?? [];
  if (new Set(bare.filter((w) => UNACCENTED.has(w))).size >= 3) return 'vi';
  const words = plain.toLowerCase().match(/[a-z]+/g) ?? [];
  if (words.filter((w) => w.length >= 2).length >= 2 && words.join('').length >= 4 && !/[^\x00-\x7f]/.test(plain.replace(/[‘’“”—–…]/g, ''))) return 'en';
  return undefined;
}

/**
 * Follows his messages in the log and keeps `language.current` at the language of the latest one that says. The tester's messages are not
 * his: they do not change it.
 */
export class Voice {
  private readonly unsubscribe: () => void;

  constructor(log: EventLog) {
    let latest: Lang | undefined;
    for (const e of log.readFrom(0, 10_000_000, ['elfoqsy.message'])) {
      if (e.type === 'elfoqsy.message' && e.payload.role === 'you') latest = languageOf(e.payload.text) ?? latest;
    }
    if (latest) language.current = latest;
    this.unsubscribe = log.subscribe((e) => {
      if (e.type === 'elfoqsy.message' && e.payload.role === 'you') language.current = languageOf(e.payload.text) ?? language.current;
    });
  }

  close(): void {
    this.unsubscribe();
  }
}
