import { describe, expect, it, vi } from 'vitest';
import { BILLING_SWITCHES, assertSubscriptionBilling, claudeLoggedIn, sessionEnv } from '../src/claude/login';
import { ConfigError } from '../src/config';

describe('billing stays on the subscription login', () => {
  it('starts when no billing switch is set', () => {
    expect(() => assertSubscriptionBilling({ HOME: '/home/alex', CLAUDE_CODE_OAUTH_TOKEN: 'from-setup-token' })).not.toThrow();
    expect(() => assertSubscriptionBilling({ ANTHROPIC_API_KEY: '   ' })).not.toThrow();
  });

  it.each(BILLING_SWITCHES)('refuses to start when %s is set, naming it but never its value', (name) => {
    const value = 'value-that-must-not-be-printed';
    let error: unknown;
    try {
      assertSubscriptionBilling({ [name]: value });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toContain(name);
    expect((error as Error).message).toContain('Claude Code login');
    expect((error as Error).message).not.toContain(value);
  });

  it('names every switch that is set', () => {
    expect(() => assertSubscriptionBilling({ ANTHROPIC_API_KEY: 'a', ANTHROPIC_AUTH_TOKEN: 'b' })).toThrow(/ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN are set/);
  });
});

describe('session environment', () => {
  it('passes only what Claude Code needs, never keys or other tokens', () => {
    const env = sessionEnv({
      PATH: '/usr/bin',
      HOME: '/home/alex',
      CLAUDE_CONFIG_DIR: '/home/alex/.claude',
      ANTHROPIC_API_KEY: 'x',
      ANTHROPIC_AUTH_TOKEN: 'x',
      ANTHROPIC_BASE_URL: 'x',
      GH_TOKEN: 'x',
      GITHUB_TOKEN: 'x',
      JIRA_API_TOKEN: 'x',
      SSH_AUTH_SOCK: 'x',
    });
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/alex',
      CLAUDE_CONFIG_DIR: '/home/alex/.claude',
      CLAUDE_AGENT_SDK_CLIENT_APP: 'elfoqsy/0.6',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', // never his own Claude Code memory
    });
  });
});

describe('claude CLI login check', () => {
  it('uses only the exit code of `claude auth status`, with the session environment', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '{"loggedIn":true,"email":"not-kept"}' });
    expect(await claudeLoggedIn(exec, { HOME: '/home/alex', JIRA_API_TOKEN: 'x' })).toBe(true);
    const [file, args, options] = exec.mock.calls[0]!;
    expect([file, args]).toEqual(['claude', ['auth', 'status']]);
    expect(options.env).not.toHaveProperty('JIRA_API_TOKEN');
    expect(await claudeLoggedIn(vi.fn().mockRejectedValue({ code: 1 }), {})).toBe(false);
  });
});
