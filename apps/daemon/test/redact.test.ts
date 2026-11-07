import { describe, expect, it } from 'vitest';
import { redact, redactDeep } from '../src/redact';

// Every secret below is synthetic and assembled at run time, so no token-shaped literal lives in the repo.
const hex = (length: number, seed = 7): string => {
  let out = '';
  let x = seed;
  for (let i = 0; i < length; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out += ((x >>> 16) % 16).toString(16);
  }
  return out;
};

// The shape of the real CORE-18891 description: a lowercase hex key next to the word apikey.
const core18891 = (separator: string, key: string): string =>
  [
    'shop-api calls the payment provider with its own API key, which falls back',
    'to the enterprise default of 500 requests per minute.',
    '',
    `Key in use on all environments: apikey${separator}${key}`,
    '',
    'Request: set the rate limit on the key to 2000 per minute in every Platform environment and region.',
  ].join('\n');

describe('redact: the CORE-18891 shape', () => {
  const lengths = Array.from({ length: 33 }, (_, i) => 32 + i); // 32 to 64

  it.each(lengths)('removes a %i-character hex key written as "apikey: x"', (length) => {
    const key = hex(length, length);
    const out = redact(core18891(': ', key));
    expect(out).not.toContain(key);
    expect(out).toContain('apikey: [redacted secret]');
    expect(out).toContain('2000 per minute');
  });

  it.each(lengths)('removes a %i-character hex key written as "apikey=x"', (length) => {
    const key = hex(length, length + 100);
    const out = redact(core18891('=', key));
    expect(out).not.toContain(key);
    expect(out).toContain('apikey=[redacted secret]');
  });

  it('removes it in JSON and in upper case too', () => {
    const key = hex(40);
    expect(redact(`{"apikey": "${key}"}`)).toBe('{"apikey": "[redacted secret]"}');
    expect(redact(`APIKEY=${key}`)).toBe('APIKEY=[redacted secret]');
  });

  it('removes a run that comes before the word', () => {
    const key = hex(48);
    expect(redact(`${key} is the API key`)).toBe('[redacted secret] is the API key');
  });

  it('leaves a 31-character run alone (the rule starts at 32)', () => {
    const short = hex(31);
    expect(redact(`apikey: ${short}`)).toBe(`apikey: ${short}`);
  });
});

describe('redact: other secrets', () => {
  it('removes base64 runs next to token and secret', () => {
    const b64 = `${'Zm9vYmFy'.repeat(5)}+/Q==`;
    expect(redact(`access_token: ${b64}`)).toBe('access_token: [redacted secret]');
    expect(redact(`client_secret="${b64}"`)).toBe('client_secret="[redacted secret]"');
  });

  it('removes known token formats wherever they appear', () => {
    const cases: Array<[string, string]> = [
      ['sk-ant-' + 'api03-' + 'x'.repeat(40), 'anthropic key'],
      ['gh' + 'p_' + 'A1b2'.repeat(9), 'github token'],
      ['github_' + 'pat_' + '11AB'.repeat(10), 'github token'],
      ['ATA' + 'TT3x' + 'Ff'.repeat(20), 'atlassian token'],
      ['AK' + 'IA' + 'ABCDEFGHIJ234567', 'aws key'],
      ['xo' + 'xb-' + '1234-5678-abcdef', 'slack token'],
      ['eyJ' + 'hbGciOiJIUzI1NiJ9' + '.eyJ' + 'zdWIiOiIxMjM0In0' + '.' + 'c2lnbmF0dXJlLXNpZw', 'jwt'],
    ];
    for (const [secret, kind] of cases) {
      const out = redact(`see ${secret} here`);
      expect(out, kind).toBe(`see [redacted ${kind}] here`);
    }
  });

  it('removes private keys, including a truncated block', () => {
    const body = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC'.repeat(3);
    const pem = ['-----BEGIN ' + 'PRIVATE KEY-----', body, '-----END ' + 'PRIVATE KEY-----'].join('\n');
    expect(redact(`key:\n${pem}\ndone`)).toBe('key:\n[redacted private key]\ndone');
    const truncated = ['-----BEGIN OPENSSH ' + 'PRIVATE KEY-----', body].join('\n');
    expect(redact(truncated)).toBe('[redacted private key]');
  });

  it('removes Authorization header values and keeps the scheme', () => {
    expect(redact('Authorization: Bearer abc.def.ghi')).toBe('Authorization: Bearer [redacted credentials]');
    expect(redact("curl -H 'authorization: Basic dXNlcjpwYXNz' https://x")).toBe(
      "curl -H 'authorization: Basic [redacted credentials]' https://x",
    );
    expect(redact('{"Authorization":"token abc123"}')).toBe('{"Authorization":"token [redacted credentials]"}');
    // In a template literal too (v1.2: code in chat and thoughts).
    expect(redact('headers.Authorization = `Basic dXNlcjpwYXNz`;')).toBe('headers.Authorization = `Basic [redacted credentials]`;');
  });

  it('leaves a template variable in code alone: it names a value, it is not one', () => {
    for (const code of ['headers.Authorization = `Basic ${token}`;', 'Authorization: Bearer ${process.env.TOKEN}']) expect(redact(code)).toBe(code);
  });

  it('still redacts a value that only starts like an earlier redaction', () => {
    expect(redact('Authorization: [redacted-s3cr3tvalue]')).toBe('Authorization: [redacted credentials]');
  });

  it('is idempotent on Authorization values, whatever their quoting', () => {
    for (const text of ['Authorization: Bearer abc.def', "authorization: 'Basic dXNlcjpwYXNz'", 'Authorization = `Basic dXNlcjpwYXNz`', 'Authorization = abc']) {
      const once = redact(text);
      expect(redact(once)).toBe(once);
    }
  });

  it('removes passwords inside URLs', () => {
    expect(redact('git clone https://bot:s3cret@github.com/org/repo')).toBe(
      'git clone https://bot:[redacted password]@github.com/org/repo',
    );
  });
});

describe('redact: leaves ordinary text alone', () => {
  it.each([
    'SHOP-3546 is blocked by CORE-18891.',
    'Merge shared-modules #159 first, then #212.',
    'The key insight: lift error_code from details.',
    'Set the rate limit on the key to 2000 per minute.',
    `Rebased onto ${hex(40)} after CI failed.`, // a commit SHA with no key/token/secret next to it
    'Read https://acme.atlassian.net/browse/SHOP-3546',
    'token budget exceeded after 45 minutes',
  ])('%s', (text) => {
    expect(redact(text)).toBe(text);
  });

  it('is idempotent', () => {
    const once = redact(core18891(': ', hex(64)));
    expect(redact(once)).toBe(once);
  });
});

describe('redact: pre-signed URLs (2026-10-18)', () => {
  // Assembled at run time: a key id, a 64-hex signature, a session token and SAS and Google signatures.
  const keyId = `AKIA${'Q'.repeat(4)}${hex(12).toUpperCase().replace(/[^A-Z0-9]/g, 'Z')}`;
  const sig = hex(64, 3);
  const token = `IQoJb3JpZ2luX2Vj${hex(40, 5)}%2F%2F${hex(30, 9)}%3D`;
  const s3 = (date: string) =>
    `https://shop-testing.s3.us-west-2.amazonaws.com/test_file_zstd.zip?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=${keyId}%2F${date}%2Fus-west-2%2Fs3%2Faws4_request&X-Amz-Date=${date}T105856Z&X-Amz-Expires=604800&X-Amz-Security-Token=${token}&X-Amz-Signature=${sig}`;

  it.each(['20260507', '20991231'])('removes the signature, the session token and the key id, expired or not (%s)', (date) => {
    const out = redact(`Request: {"files": [{"url": "${s3(date)}"}]}`);
    expect(out).not.toContain(sig);
    expect(out).not.toContain(token);
    expect(out).not.toContain(keyId);
    expect(out).toContain('X-Amz-Signature=[redacted signature]');
    expect(out).toContain('X-Amz-Security-Token=[redacted session token]');
    expect(out).toContain(`X-Amz-Date=${date}T105856Z&X-Amz-Expires=604800`); // what is not secret stays
    expect(out).toContain('"}]}');
    expect(redact(out)).toBe(out); // idempotent
  });

  it('removes Google, CloudFront and SigV2, and Azure SAS signatures', () => {
    const g = hex(256, 11);
    const cf = `${hex(40, 13)}~${hex(30, 17)}__`;
    const sas = `${hex(40, 19)}%2B${hex(10, 23)}%3D`;
    const text = [
      `https://storage.googleapis.com/b/o.zip?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Credential=svc%40p.iam.gserviceaccount.com%2F20260507&X-Goog-Signature=${g}`,
      `https://d1.cloudfront.net/f.zip?Expires=1778000000&Signature=${cf}&Key-Pair-Id=K2JCJMDEHXQW5F`,
      `https://acct.blob.core.windows.net/c/f.zip?sv=2024-11-04&se=2026-05-08T00%3A00%3A00Z&sp=r&sig=${sas}`,
      `escaped in JSON: https://b.s3.amazonaws.com/k?X-Amz-Date=20260507T000000Z\\u0026X-Amz-Signature=${sig}`,
    ].join('\n');
    const out = redact(text);
    for (const secret of [g, cf, sas, sig]) expect(out).not.toContain(secret);
    expect(out.match(/\[redacted signature\]/g)).toHaveLength(4);
    expect(out).toContain('Key-Pair-Id=K2JCJMDEHXQW5F');
    expect(out).toContain('sv=2024-11-04&se=2026-05-08T00%3A00%3A00Z&sp=r&sig=');
    expect(redact(out)).toBe(out);
  });

  it.each(['https://example.com/search?q=signature&sig=abc', 'The signature= field is checked by verifySignature()', 'Signature=valid in the release notes'])('leaves alone %s', (text) => {
    expect(redact(text)).toBe(text);
  });
});

describe('redactDeep', () => {
  it('redacts every string in a nested payload and keeps other values', () => {
    const key = hex(36);
    const payload = {
      ticket: { key: 'CORE-18891', storyPoints: null, labels: ['payments', `apikey=${key}`], description: `apikey: ${key}` },
      count: 3,
      ok: true,
    };
    const out = redactDeep(payload);
    expect(JSON.stringify(out)).not.toContain(key);
    expect(out.ticket.key).toBe('CORE-18891');
    expect(out.ticket.storyPoints).toBeNull();
    expect(out.count).toBe(3);
    expect(out.ok).toBe(true);
    expect(payload.ticket.description).toContain(key); // input is not mutated
  });
});
