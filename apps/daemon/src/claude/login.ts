// Elfoqsy (and, from milestone 6, every agent) runs on Alex's Claude Code login: his subscription,
// read from the claude CLI's own credentials. Nothing here may switch billing to pay-per-token or to
// another provider without him noticing, so the daemon refuses to start instead.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ConfigError } from '../config';

/** Variables that would move Claude Code off the subscription login. */
export const BILLING_SWITCHES = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
] as const;

/** Throws, naming the variables but never their values, if any billing switch is set. */
export function assertSubscriptionBilling(env: NodeJS.ProcessEnv): void {
  const set = BILLING_SWITCHES.filter((name) => (env[name] ?? '').trim() !== '');
  if (!set.length) return;
  const names = set.join(', ');
  throw new ConfigError(
    `${names} ${set.length === 1 ? 'is' : 'are'} set. Elfoqsy runs only on your Claude Code login, so it will not start ` +
      `where billing could switch to pay-per-token or another provider. Unset ${set.length === 1 ? 'it' : 'them'} in your shell and in .env.`,
  );
}

/**
 * The only environment a Claude Code process gets: enough to find Alex's login and reach Anthropic.
 * The SDK's `env` option replaces the environment, so anything not listed here, Anthropic keys, GitHub
 * and Jira tokens included, never reaches a session.
 */
const PASS_THROUGH = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS',
  'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', // the subscription login, or its long-lived token from `claude setup-token`
  'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
];

export function sessionEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  // No auto-memory: a session must never read or write the memory of alex's own Claude Code.
  const env: Record<string, string> = { CLAUDE_AGENT_SDK_CLIENT_APP: 'elfoqsy/0.6', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };
  for (const name of PASS_THROUGH) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

type Exec = (file: string, args: string[], options: { env: NodeJS.ProcessEnv; timeout: number }) => Promise<unknown>;

/** Whether the claude CLI is logged in. Only the exit code of `claude auth status` is used. */
export async function claudeLoggedIn(
  exec: Exec = promisify(execFile) as unknown as Exec,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  try {
    await exec('claude', ['auth', 'status'], { env: sessionEnv(env), timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}
