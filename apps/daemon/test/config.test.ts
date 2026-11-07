import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ConfigError, ELFOQSY_EFFORT, ELFOQSY_REPLY_EFFORT, REPO_ROOT, loadConfig } from '../src/config';

describe('loadConfig', () => {
  it('needs no secrets in simulate mode and fills the brief defaults', () => {
    const config = loadConfig({}, 'simulate');
    expect(config).toMatchObject({
      mode: 'simulate',
      DAEMON_PORT: 4317,
      JIRA_SITE: 'https://acme.atlassian.net',
      JIRA_PROJECTS: ['SHOP', 'CORE'],
      JIRA_STORY_POINTS_FIELD: 'customfield_16486',
      JIRA_SPRINT_FIELD: 'customfield_10521',
      MAX_PARALLEL_AGENTS: 6,
      INTERNAL_HOSTS: [],
      AGENT_MAX_MINUTES: 45,
    });
  });

  it('lists the variables live mode is missing, by name only', () => {
    const secret = 'not-a-real-token-but-treat-it-like-one';
    const error = (() => {
      try {
        loadConfig({ JIRA_API_TOKEN: secret }, 'live');
      } catch (e) {
        return e as Error;
      }
    })();
    expect(error).toBeInstanceOf(ConfigError);
    expect(error?.message).toBe(
      'Missing environment variables for live mode: JIRA_EMAIL, GITHUB_REPOS, REPOS_ROOT.\n' +
        'Copy .env.example to .env and fill them in, or run `pnpm dev:sim` for the demo, which needs no tokens.',
    );
    expect(error?.message).not.toContain(secret);
  });

  it('reads repositories as owner/name, enterprise-managed owners included', () => {
    const config = loadConfig(
      {
        JIRA_EMAIL: 'n@example.com',
        JIRA_API_TOKEN: 'x',
        GITHUB_REPOS: 'acme/shop-api, acme/shop-infra,acme/shop-local-deploy,acme/shop-api',
        REPOS_ROOT: '/code',
      },
      'live',
    );
    expect(config.GITHUB_REPOS).toEqual(['acme/shop-api', 'acme/shop-infra', 'acme/shop-local-deploy']);
    expect(() => loadConfig({ GITHUB_REPOS: 'shop-api' }, 'simulate')).toThrow(/GITHUB_REPOS/);
  });

  it('has the milestone 6 defaults: three sub-agent models, four efforts, at most 4 sub-agents', () => {
    const config = loadConfig({}, 'simulate');
    expect(config).toMatchObject({
      SUBAGENT_MODELS: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'],
      SUBAGENT_EFFORTS: ['low', 'medium', 'high', 'xhigh'],
      MAX_PARALLEL_SUBAGENTS: 4,
      AGENT_MAX_TOKENS: 3_000_000,
      USAGE_WARN_FIVE_HOUR: 60,
      USAGE_WARN_SEVEN_DAY: 80,
    });
    expect(() => loadConfig({ SUBAGENT_EFFORTS: 'low,turbo' }, 'simulate')).toThrow(/SUBAGENT_EFFORTS/);
    expect(() => loadConfig({ SUBAGENT_MODELS: 'gpt-5' }, 'simulate')).toThrow(/SUBAGENT_MODELS/);
  });

  it('keeps run folders outside this repository and outside REPOS_ROOT', () => {
    expect(loadConfig({ HOME: '/home/l' }, 'simulate').worktreesRoot).toBe('/home/l/.local/share/elfoqsy/runs');
    expect(loadConfig({ HOME: '/home/l', XDG_DATA_HOME: '/data/l' }, 'simulate').worktreesRoot).toBe('/data/l/elfoqsy/runs');
    expect(loadConfig({ WORKTREES_ROOT: '/srv/runs' }, 'simulate').worktreesRoot).toBe('/srv/runs');
    expect(() => loadConfig({ WORKTREES_ROOT: resolve(REPO_ROOT, 'data/worktrees') }, 'simulate')).toThrow('WORKTREES_ROOT must be outside the elfoqsy repository.');
    expect(() => loadConfig({ WORKTREES_ROOT: REPO_ROOT }, 'simulate')).toThrow(/outside the elfoqsy repository/);
    expect(() => loadConfig({ REPOS_ROOT: '/code', WORKTREES_ROOT: '/code/runs' }, 'simulate')).toThrow('WORKTREES_ROOT must be outside REPOS_ROOT.');
    // Each run's TMPDIR holds the sandbox's socket files, so the root must be short.
    expect(() => loadConfig({ WORKTREES_ROOT: `/srv/${'x'.repeat(50)}` }, 'simulate')).toThrow(/WORKTREES_ROOT is too long: at most 50 characters/);
  });

  it('puts the agents’ shared cache beside the run folders, in a folder of its own, never his home or a clone', () => {
    expect(loadConfig({ HOME: '/home/l' }, 'simulate').agentCacheDir).toBe('/home/l/.local/share/elfoqsy/cache');
    expect(loadConfig({ HOME: '/home/l', WORKTREES_ROOT: '/srv/runs' }, 'simulate').agentCacheDir).toBe('/srv/cache');
    expect(loadConfig({ HOME: '/home/l', AGENT_CACHE_DIR: '/srv/agent-cache' }, 'simulate').agentCacheDir).toBe('/srv/agent-cache');
    // Every agent's shell reads and writes all of it: not his home, a folder above it, this repository or his clones.
    expect(() => loadConfig({ HOME: '/home/l', AGENT_CACHE_DIR: '/home/l' }, 'simulate')).toThrow('AGENT_CACHE_DIR must not be his home or a folder above it.');
    expect(() => loadConfig({ HOME: '/home/l', AGENT_CACHE_DIR: '/home' }, 'simulate')).toThrow(/his home or a folder above it/);
    expect(() => loadConfig({ HOME: '/home/l', AGENT_CACHE_DIR: '/' }, 'simulate')).toThrow(/his home or a folder above it/);
    expect(() => loadConfig({ AGENT_CACHE_DIR: resolve(REPO_ROOT, 'data/cache') }, 'simulate')).toThrow('AGENT_CACHE_DIR must be apart from the elfoqsy repository.');
    expect(() => loadConfig({ REPOS_ROOT: '/code', AGENT_CACHE_DIR: '/code/cache' }, 'simulate')).toThrow('AGENT_CACHE_DIR must be apart from REPOS_ROOT.');
  });

  it('puts the mirrors beside the run folders, apart from the cache, his home, this repository and his clones', () => {
    expect(loadConfig({ HOME: '/home/l' }, 'simulate').agentMirrorsDir).toBe('/home/l/.local/share/elfoqsy/mirrors');
    expect(loadConfig({ HOME: '/home/l', WORKTREES_ROOT: '/srv/runs' }, 'simulate').agentMirrorsDir).toBe('/srv/mirrors');
    expect(loadConfig({ HOME: '/home/l', AGENT_MIRRORS_DIR: '/srv/m' }, 'simulate').agentMirrorsDir).toBe('/srv/m');
    expect(() => loadConfig({ HOME: '/home/l', AGENT_MIRRORS_DIR: '/home/l' }, 'simulate')).toThrow('AGENT_MIRRORS_DIR must not be his home or a folder above it.');
    expect(() => loadConfig({ AGENT_MIRRORS_DIR: resolve(REPO_ROOT, 'data/mirrors') }, 'simulate')).toThrow('AGENT_MIRRORS_DIR must be apart from the elfoqsy repository.');
    expect(() => loadConfig({ REPOS_ROOT: '/code', AGENT_MIRRORS_DIR: '/code/mirrors' }, 'simulate')).toThrow('AGENT_MIRRORS_DIR must be apart from REPOS_ROOT.');
    // A mirror of the run folders or of the cache would be written to by the runs themselves.
    expect(() => loadConfig({ WORKTREES_ROOT: '/srv/runs', AGENT_MIRRORS_DIR: '/srv/runs/mirrors' }, 'simulate')).toThrow('AGENT_MIRRORS_DIR must be apart from WORKTREES_ROOT.');
    expect(() => loadConfig({ AGENT_CACHE_DIR: '/srv/c', AGENT_MIRRORS_DIR: '/srv/c' }, 'simulate')).toThrow('AGENT_MIRRORS_DIR must be apart from AGENT_CACHE_DIR.');
  });

  it('rejects an invalid value without echoing it', () => {
    expect(() => loadConfig({ DAEMON_PORT: 'ninety' }, 'simulate')).toThrow(/Invalid environment variables: DAEMON_PORT$/);
  });
});

describe('the effort of her sessions', () => {
  const src = (file: string): string => readFileSync(join(REPO_ROOT, 'apps/daemon/src', file), 'utf8');

  it('is high for her conversation replies, and medium for her short sessions', () => {
    expect(ELFOQSY_REPLY_EFFORT).toBe('high');
    expect(ELFOQSY_EFFORT).toBe('medium');
    expect(src('main.ts')).toContain('effort: ELFOQSY_REPLY_EFFORT,');
    expect(src('main.ts')).not.toMatch(/effort: ELFOQSY_EFFORT/);
  });

  it('is what the brain hands each conversation session', () => {
    expect(src('elfoqsy/brain.ts')).toContain('...(this.o.effort ? { effort: this.o.effort } : {}),');
  });
});
