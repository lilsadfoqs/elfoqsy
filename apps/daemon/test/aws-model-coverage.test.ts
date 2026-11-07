// The classifier trusts a verb: describe-, list- and get- are reads. This test does not: it scans the service models the
// AWS CLI itself ships for every "read" whose answer holds what the proxy hides (environment variables, a field that holds
// a credential), whose answer is written to a file named in the call, or that has a switch that unmasks data, and checks
// that each one is hidden, asked or never done. A new CLI version with a new read fails here, with its name, instead of
// being found by a reviewer. Skipped where the CLI is not installed.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyAws, READ_OP } from '../src/permissions/aws';
import { ENV_KEYS, isSecretField } from '../src/permissions/hide';
import { environments } from './helpers/proxyFakes';

interface Shape {
  type: string;
  members?: Record<string, { shape: string }>;
  member?: { shape: string };
  value?: { shape: string };
  key?: { shape: string };
  payload?: string;
  enum?: string[];
}
interface Model {
  operations: Record<string, { input?: { shape: string }; output?: { shape: string } }>;
  shapes: Record<string, Shape>;
}

const ROOT = '/usr/local/aws-cli/v2';
const dataDir = (): string | undefined => {
  if (!existsSync(ROOT)) return undefined;
  // "current" is a link to the installed version: the version's own folder is the one to read.
  const versions = readdirSync(ROOT).filter((v) => v !== 'current' && existsSync(join(ROOT, v, 'dist/awscli/botocore/data')));
  return versions.length ? join(ROOT, versions.sort().at(-1)!, 'dist/awscli/botocore/data') : undefined;
};
const DATA = dataDir();

const kebab = (op: string): string => op.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2').toLowerCase();
// A service's directory in the models is not always its command: botocore's s3 is the CLI's s3api.
const COMMAND: Record<string, string> = { s3: 's3api' };

/** Reads the proxy takes as they are, whose environment-like or credential-like member is not a secret. One reason each. */
const NOT_SECRET: Array<[service: string, operations: RegExp, why: string]> = [
  ['iotsitewise', /^(describe-asset-model|describe-asset-model-composite-model|describe-asset-property|list-asset-model-properties)$/, 'formula variables: names of properties'],
  ['chatbot', /^get-custom-action$/, 'the variables of a custom action: names of what to fill in'],
  ['pinpoint-sms-voice-v2', /^describe-notify-templates$/, 'template placeholders'],
  ['appmesh', /^describe-virtual-(gateway|node)$/, 'privateKey is the path of a TLS key file on the proxy, not the key'],
  ['mailmanager', /^get-rule-set$/, 'HeaderValue is the value of an email header a rule adds'],
  ['ses', /^describe-(active-receipt-rule-set|receipt-rule|receipt-rule-set)$/, 'HeaderValue is the value of an email header a rule adds'],
  ['secretsmanager', /^get-random-password$/, 'a random string that opens nothing'],
  ['rds', /^describe-option-groups$/, 'engine option settings (a port, a bucket), not environment'],
];

type Feature = 'environment' | 'credential field' | 'writes a file' | 'unmask';

function scan(model: Model, output: string | undefined, features: Set<Feature>, members: Set<string>): void {
  const { shapes } = model;
  const walk = (name: string, seen: ReadonlySet<string>, depth: number): void => {
    if (depth > 9 || seen.has(name)) return;
    const shape = shapes[name];
    if (!shape) return;
    const next = new Set(seen).add(name);
    if (shape.type === 'structure') {
      for (const [member, ref] of Object.entries(shape.members ?? {})) {
        const target = shapes[ref.shape];
        if (ENV_KEYS.has(member) && target) {
          if (target.type === 'map') (features.add('environment'), members.add(member));
          else if (target.type === 'list') {
            const entry = shapes[target.member?.shape ?? ''];
            const keys = new Set(Object.keys(entry?.members ?? {}).map((k) => k.toLowerCase()));
            if (entry?.type === 'structure' && (keys.has('name') || keys.has('key')) && keys.has('value')) (features.add('environment'), members.add(member));
          }
        }
        if (isSecretField(member) && target && (target.type === 'string' || target.type === 'blob') && !target.enum) (features.add('credential field'), members.add(member));
        walk(ref.shape, next, depth + 1);
      }
    } else if (shape.type === 'list' && shape.member) walk(shape.member.shape, next, depth + 1);
    else if (shape.type === 'map' && shape.value) walk(shape.value.shape, next, depth + 1);
  };
  if (output) walk(output, new Set(), 0);
}

describe.skipIf(!DATA)('every read in the AWS CLI’s own models, against the tables', () => {
  const dev = environments.list.find((e) => e.name === 'dev')!.awsProfile!;
  const classify = (service: string, operation: string, ...rest: string[]) => classifyAws([service, operation, '--profile', dev, ...rest], environments);

  const found = new Map<string, Set<Feature>>();
  const named = new Map<string, Set<string>>();

  it('finds the reads to check', () => {
    for (const dir of readdirSync(DATA!).sort()) {
      if (!statSync(join(DATA!, dir)).isDirectory()) continue;
      const versions = readdirSync(join(DATA!, dir)).filter((v) => existsSync(join(DATA!, dir, v, 'service-2.json'))).sort();
      if (!versions.length) continue;
      const model = JSON.parse(readFileSync(join(DATA!, dir, versions.at(-1)!, 'service-2.json'), 'utf8')) as Model;
      const service = COMMAND[dir] ?? dir;
      for (const [op, spec] of Object.entries(model.operations)) {
        const cli = kebab(op);
        if (!READ_OP.test(cli) || !spec.output) continue;
        const features = new Set<Feature>();
        const members = new Set<string>();
        scan(model, spec.output.shape, features, members);
        named.set(`${service} ${cli}`, members);
        const out = model.shapes[spec.output.shape];
        if (out?.payload && model.shapes[out.members?.[out.payload]?.shape ?? '']?.type === 'blob') features.add('writes a file');
        const input = model.shapes[spec.input?.shape ?? ''];
        if (Object.keys(input?.members ?? {}).some((m) => m.toLowerCase() === 'unmask')) features.add('unmask');
        if (features.size) found.set(`${service} ${cli}`, features);
      }
    }
    // The scan is not vacuous: it finds the reads this round is about.
    expect(found.get('lambda list-functions')).toContain('environment');
    expect(found.get('cloudfront get-distribution-config')).toContain('credential field');
    expect(found.get('iot-data get-thing-shadow')).toContain('writes a file');
    expect(found.get('logs get-log-events')).toContain('unmask');
  }, 120_000);

  it('has every such read hidden, asked or never done', () => {
    const uncovered: string[] = [];
    for (const [key, features] of found) {
      const [service, operation] = key.split(' ') as [string, string];
      if (NOT_SECRET.some(([s, ops]) => s === service && ops.test(operation)) && !features.has('writes a file') && !features.has('unmask')) continue;
      const c = classify(service, operation);
      const guarded = c.tier !== 0 || c.hideSecrets === true;
      if ((features.has('environment') || features.has('credential field')) && !guarded) uncovered.push(`${key}: has ${[...features].filter((f) => f === 'environment' || f === 'credential field').join(' and ')} (${[...(named.get(key) ?? [])].join(', ')}), and is a plain read`);
      if (features.has('writes a file') && c.tier === 0) uncovered.push(`${key}: writes a file named in the call, and is a free read`);
      if (features.has('unmask') && classify(service, operation, '--unmask').tier === 0) uncovered.push(`${key}: --unmask returns masked data, and is a free read`);
    }
    expect(uncovered, `Add each to a table in permissions/aws.ts (HIDE_ENVIRONMENT, HIDE_FIELDS, SECRETS, WRITES_FILES or CREDENTIALS), or to NOT_SECRET with the reason:\n${uncovered.join('\n')}\n`).toEqual([]);
  });
});
