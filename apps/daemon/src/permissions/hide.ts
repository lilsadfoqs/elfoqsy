// Environment variables' values are secrets as often as not, and a read that lists a Lambda function, a task definition
// or a pod shows them. Those reads stay free, but the proxy hides every environment variable's value in what it returns
// and keeps the names. The same rule holds for a field that holds a credential (a client secret,
// a webhook's token, a pre-shared key): hidden in the answer, with the field kept. Reading the values themselves is
// reading secrets: asked for an agent, refused to Elfoqsy (the SECRETS table in aws.ts, kube's output formats that
// project values). This is the filter.
import { search } from 'jmespath';
import { parseAllDocuments, stringify } from 'yaml';

export const HIDDEN = '<hidden>';

/**
 * Keys that hold environment variables, or what plays their part, as a list of { name, value } (Kubernetes env, ECS,
 * Batch and CodeBuild environment) or a map of names to values (Lambda's Variables, API Gateway stage variables, Glue job
 * arguments, App Runner and SageMaker environment).
 */
export const ENV_KEYS = new Set([
  'env',
  'environment',
  'Environment',
  'environmentVariables',
  'EnvironmentVariables',
  'exportedEnvironmentVariables',
  'RuntimeEnvironmentVariables',
  'ContainerEnvironmentVariables',
  'AdditionalEnvironmentVariables',
  'EnvironmentOverride',
  'variables',
  'Variables',
  'StageVariables',
  'stageVariables',
  'stageVariableOverrides',
  'Arguments',
  'DefaultArguments',
  'NonOverridableArguments',
  'RunProperties',
  'AirflowConfigurationOptions',
  'commandLineArguments',
  'OptionSettings',
]);

/**
 * Fields that hold a credential's value, wherever they sit (lower case): a client secret, a webhook's token, a
 * pre-shared key, a custom origin header's value, an API key, a password, a basic-auth login, a launch script's user data.
 */
export const SECRET_FIELDS = new Set([
  'clientsecret',
  'clientsecretvalue',
  'secret',
  'secrettoken',
  'presharedkey',
  'customergatewayconfiguration',
  'headervalue',
  'apikey',
  'passphrase',
  'privatekey',
  'authtoken',
  'accesstoken',
  'refreshtoken',
  'jwttoken',
  'authorizationcode',
  'secretaccesskey',
  'sessiontoken',
  'jointoken',
  'securitytoken',
  'streamkey',
  'basicauthcredentials',
  'userdata',
  'resolvedvalue', // a pipeline execution's variables, as { name, resolvedValue }
]);
/** A field name that holds a credential: the list above, or any name that ends in "password" (SaslPassword, MasterUserPassword). */
export const isSecretField = (name: string): boolean => SECRET_FIELDS.has(name.toLowerCase()) || /password$/i.test(name);

/** Glue's connection properties: a map where only some keys are secrets (PASSWORD, a keystore's password, a secret's value). */
const SECRET_PROPERTY = /(PASSWORD|SECRET|TOKEN|PRIVATE_KEY)$/i;
/** A connection URL that carries its login (JDBC_CONNECTION_URL with user=&password=). */
const SECRET_IN_TEXT = /(password|pwd|secret|token)=/i;
/** The options of a container's log driver, where the keys that hold a credential end like this (splunk-token, apikey). */
const SECRET_OPTION = /(token|secret|password|api-?key)$/i;

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isValue = (v: unknown): boolean => v !== null && v !== undefined && typeof v !== 'object';

/** { name, value } with the value hidden; a reference (valueFrom) is not a value and stays. */
function hideEntry(entry: unknown): unknown {
  if (!isObject(entry)) return entry;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(entry)) out[k] = (k === 'value' || k === 'Value' || isSecretField(k)) && isValue(v) ? HIDDEN : walk(v);
  return out;
}

/** A map of names to values: every value hidden, whatever depth it sits at. */
function hideMap(map: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(map)) out[k] = isObject(v) ? hideMap(v) : Array.isArray(v) ? v.map((x) => (isObject(x) ? hideMap(x) : isValue(x) ? HIDDEN : x)) : isValue(v) ? HIDDEN : v;
  return out;
}

/**
 * An object under an environment key is the map itself, or an object that describes something and holds the map (a
 * Lambda function's Environment { Variables, Error }, CodeBuild's environment { type, image, environmentVariables }):
 * the latter is walked, so only the map in it is hidden. An environment variable that happens to be named like a key
 * (a plain value under "Variables") does not make a map into a description.
 */
const describesSomething = (v: Record<string, unknown>): boolean => Object.entries(v).some(([k, x]) => ENV_KEYS.has(k) && (Array.isArray(x) || isObject(x)));

/** What sits under an environment key: a list of entries, a map, or an object that holds one; a string is a word, or JSON written as text. */
function hideEnvironment(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(hideEntry);
  if (isObject(v)) return describesSomething(v) ? walk(v) : hideMap(v);
  // CodePipeline writes an action's environment variables as a JSON string: read it, hide it, write it back; a string that
  // looks like JSON and is not is hidden whole.
  if (typeof v === 'string' && /^\s*[[{]/.test(v)) {
    try {
      return JSON.stringify(hideEnvironment(JSON.parse(v)));
    } catch {
      return HIDDEN;
    }
  }
  return v;
}

function walk(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(walk);
  if (!isObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === 'kubectl.kubernetes.io/last-applied-configuration' && typeof v === 'string') out[k] = HIDDEN; // the whole manifest, env included
    else if (k === 'TokenValidityUnits') out[k] = v; // Cognito's units ("hours") for AccessToken and IdToken: no credential
    else if (isSecretField(k) && isValue(v)) out[k] = HIDDEN;
    else if (k === 'ConnectionProperties' && isObject(v)) out[k] = Object.fromEntries(Object.entries(v).map(([name, x]) => [name, (SECRET_PROPERTY.test(name) || (typeof x === 'string' && SECRET_IN_TEXT.test(x))) && isValue(x) ? HIDDEN : x]));
    else if ((k === 'logConfiguration' || k === 'firelensConfiguration') && isObject(v)) out[k] = hideOptions(walk(v));
    else if (ENV_KEYS.has(k)) out[k] = hideEnvironment(v);
    else out[k] = walk(v);
  }
  return out;
}

/** A container's log or firelens configuration, with the options that hold a credential (splunk-token) hidden. */
function hideOptions(config: unknown): unknown {
  if (!isObject(config) || !isObject(config.options)) return config;
  return { ...config, options: Object.fromEntries(Object.entries(config.options).map(([name, x]) => [name, SECRET_OPTION.test(name) && isValue(x) ? HIDDEN : x])) };
}

/** A parsed answer (JSON or YAML) with every environment variable's value and every credential field hidden, and the names kept. */
export function hideSecrets(value: unknown): unknown {
  return walk(value);
}

/**
 * Text that is JSON or YAML (one document, or several), with the values hidden, in the same form; null when it cannot be
 * read as that, in which case nothing of it may be shown.
 */
export function hideInStructuredText(text: string, form: 'json' | 'yaml'): string | null {
  try {
    if (form === 'json') return JSON.stringify(hideSecrets(JSON.parse(text)), null, 2);
    const docs = parseAllDocuments(text);
    if (docs.some((d) => d.errors.length)) return null;
    return docs.map((d) => stringify(hideSecrets(d.toJS()), { lineWidth: 0 })).join('---\n');
  } catch {
    return null;
  }
}

/**
 * What kubectl describe prints for an entry that is a reference, not a value, in full: a secret's or config map's key
 * (with its Optional), or a field of the object or of the container's resources. A value that merely begins like one is a value.
 */
const REFERENCE = /^(<set to the key '[^']*' (in secret|of config map) '[^']*'>(\s+Optional: (true|false))?|\(v1:[^)\s]+\)|\((limits|requests)\.[a-z0-9-]+\))\s*$/;

/**
 * kubectl describe's "Environment:" blocks, with each entry's value hidden. An entry that is a reference (a secret's key, a
 * field) stays: it is not a value. A value that runs over several lines is hidden over all of them, until the next heading;
 * that holds for the usual values and cannot hold for every possible one, which is why -o yaml and -o json, parsed,
 * are the way to read an object.
 */
export function hideDescribedEnvironment(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  const indentOf = (l: string): number => l.length - l.trimStart().length;
  const heading = (l: string): boolean => /^\s*[A-Za-z][A-Za-z0-9 /_.()-]*:(\s|$)/.test(l);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    out.push(line);
    const head = /^(\s*)Environment:\s*$/.exec(line);
    if (!head) continue;
    const base = head[1]!.length;
    let entry: number | undefined;
    for (i = i + 1; i < lines.length; i++) {
      const l = lines[i]!;
      if (l.trim() === '') {
        out.push(l);
        continue;
      }
      const indent = indentOf(l);
      if (indent <= base && heading(l)) {
        i--; // the block is over: this line is the next heading
        break;
      }
      entry ??= indent;
      const named = indent === entry ? /^(\s*)([^\s:][^\s:]*):(\s*)(.*)$/.exec(l) : null;
      if (named && (named[4] === '' || REFERENCE.test(named[4]!))) out.push(l);
      else if (named) out.push(`${named[1]}${named[2]}:${named[3] || ' '}${HIDDEN}`);
      else out.push(`${l.slice(0, indent)}${HIDDEN}`); // a value that carries on over another line
    }
  }
  return out.join('\n');
}

/** The caller's --query, run on an answer whose values are already hidden; throws when the query is not JMESPath. */
export function searchJson(data: unknown, query: string): unknown {
  return search(data as Parameters<typeof search>[0], query);
}
