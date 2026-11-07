import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32

/** A ULID: 48-bit millisecond timestamp, then 80 random bits, as 26 Crockford base32 characters. */
export function ulid(now: number = Date.now()): string {
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = ALPHABET.charAt(now % 32) + time;
    now = Math.floor(now / 32);
  }
  const bytes = randomBytes(16);
  let random = '';
  for (let i = 0; i < 16; i++) random += ALPHABET.charAt(bytes.readUInt8(i) % 32);
  return time + random;
}
