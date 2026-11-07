// Icons, never letters (21 October 2026): every tool and connector the proxies know has an icon (an official one, or a generic
// one for its kind), every file in assets/tool-icons is used and has its source and licence written down, links, attachments and
// states get their icons by rule, and no tile is drawn from text. The browser test (e2e) looks for a letter in the page as drawn.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ABILITY_TOOLS, ACTIVITY_TOOLS, proxySchema } from '@elfoqsy/contracts';
import { TOOL_TILE, toolName } from '../src/ui/AbilityCard';
import { fileIconSrc, fileKind, prStateIcon, STATE_ICONS, tileForUrl, type FileKind } from '../src/ui/linkIcons';
import { ACTIVITY_TILES, FILE_TOOLS, PROGRAMS, PROXY_TILES, RUN_TOOLS, TILES, activityTile, iconUrl, mcpServerTile, toolIdentity, type TileName } from '../src/ui/toolIcons';

const root = join(__dirname, '../../..');
const assets = join(root, 'assets/tool-icons');
const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
const svgs = walk(assets).filter((f) => f.endsWith('.svg'));

/** An SVG file as the bundler gives it: a path, or the file inlined when it is small; or her own art (her fox is a picture, never text). */
const isSvg = (src: string): boolean => /^data:image\/svg\+xml/.test(src) || /\.svg(\?|$)/.test(src) || /\/assets\/elfoqsy\/fox\/[a-z-]+\.png(\?|$)/.test(src);

/** A tile that is an icon: a file the registry has, and not text. */
const isIcon = (name: TileName): boolean => {
  const tile = TILES[name]();
  return (tile.kind === 'mask' || tile.kind === 'img') && typeof tile.src === 'string' && isSvg(tile.src);
};

describe('every tool and connector the proxies know has an icon', () => {
  it('has one for every proxy of the daemon (the record is over the contract’s names)', () => {
    const proxies = proxySchema.options;
    expect(Object.keys(PROXY_TILES).sort()).toEqual([...proxies].sort());
    for (const proxy of proxies) expect(isIcon(PROXY_TILES[proxy]), proxy).toBe(true);
  });

  it('has one for every tool of the run proxies, every shell program, every file tool and every tile', () => {
    for (const [run, known] of Object.entries(RUN_TOOLS)) expect(isIcon(known.tile), `mcp__run__${run}`).toBe(true);
    for (const [program, tile] of Object.entries(PROGRAMS)) expect(isIcon(tile), program).toBe(true);
    for (const [tool, tile] of Object.entries(FILE_TOOLS)) expect(isIcon(tile), tool).toBe(true);
    for (const name of Object.keys(TILES) as TileName[]) expect(isIcon(name), name).toBe(true);
  });

  it('has one for everything Elfoqsy’s activity can reach, and a generic one for a name nobody knows (an older log)', () => {
    for (const tool of ACTIVITY_TOOLS) expect(isIcon(ACTIVITY_TILES[tool]), tool).toBe(true);
    expect(Object.keys(ACTIVITY_TILES).sort()).toEqual([...ACTIVITY_TOOLS].sort());
    expect(activityTile('microsoft')).toBe('other'); // what an earlier build logged for every Microsoft 365 read
    expect(isIcon(activityTile('something-new'))).toBe(true);
    // Microsoft 365 reads: the service's own icon, by what was read.
    expect(ACTIVITY_TILES.outlook).toBe('outlook');
    expect(ACTIVITY_TILES.teams).toBe('teams');
    expect(ACTIVITY_TILES.sharepoint).toBe('sharepoint');
  });

  it('has one for every tool of an ability', () => {
    for (const tool of ABILITY_TOOLS) {
      expect(isIcon(TOOL_TILE[tool]), tool).toBe(true);
      expect(toolName(tool).length).toBeGreaterThan(1);
    }
    expect(Object.keys(TOOL_TILE).sort()).toEqual([...ABILITY_TOOLS].sort());
  });

  it('has one for every claude.ai connector and MCP server, and a generic one for one nobody knows', () => {
    const connectors: Array<[string, TileName]> = [
      ['claude_ai_Microsoft_365', 'microsoft365'],
      ['claude.ai Microsoft 365', 'microsoft365'],
      ['claude_ai_Atlassian_Rovo', 'rovo'],
      ['claude_ai_Coralogix', 'coralogix'],
      ['claude_ai_Claude_Docs', 'claude'],
      ['blackduck-sca', 'blackduck'],
      ['sonarqube', 'sonar'],
      ['claude_ai_Amplitude', 'other'],
      ['claude_ai_HubSpot', 'other'],
      ['some-new-server', 'other'],
    ];
    for (const [server, tile] of connectors) {
      expect(mcpServerTile(server), server).toBe(tile);
      expect(isIcon(mcpServerTile(server))).toBe(true);
    }
    const call = toolIdentity('mcp__claude_ai_Microsoft_365__outlook_email_search', '');
    expect(call).toEqual({ name: 'outlook_email_search', call: '', tile: 'microsoft365' });
    expect(toolIdentity('mcp__blackduck-sca__scan', 'x').tile).toBe('blackduck');
    expect(toolIdentity('SomethingElse', 'x').tile).toBe('other');
  });

  it('draws Microsoft 365 products with generic icons of their kind: Microsoft publishes no licence for its product icons', () => {
    for (const name of ['outlook', 'teams', 'sharepoint', 'onedrive', 'microsoft365'] as const) expect(TILES[name]()).toMatchObject({ kind: 'mask', bg: '--tile-neutral' });
    for (const generic of ['mail', 'message-square', 'folder-open', 'cloud', 'user']) expect(svgs.some((f) => f.endsWith(`/lucide/${generic}.svg`)), generic).toBe(true);
    // Atlassian's are its own tiles, too; Black Duck and Zephyr have no official file and are generic icons of their kind.
    expect(TILES.jira()).toMatchObject({ kind: 'img', bg: null });
    expect(TILES.confluence()).toMatchObject({ kind: 'img', bg: null });
    expect(TILES.blackduck()).toMatchObject({ kind: 'mask' });
    expect(TILES.zephyr()).toMatchObject({ kind: 'mask' });
  });
});

describe('a brand logo for a tool, a service’s icon only for a service named on its own', () => {
  const SERVICES: TileName[] = ['eks', 'ecr', 's3', 'iam', 'cloudtrail'];

  it('shows AWS as the tool by the AWS logo, everywhere: cards, filters, chips, activity, proxies, links', () => {
    const logo = iconUrl('aws/AWS-Cloud-logo_32.svg');
    expect(TILES.aws()).toMatchObject({ kind: 'img', src: logo });
    expect(PROXY_TILES.aws).toBe('aws');
    expect(RUN_TOOLS.aws!.tile).toBe('aws');
    expect(PROGRAMS.aws).toBe('aws');
    expect(ACTIVITY_TILES.aws).toBe('aws');
    expect(TOOL_TILE.aws).toBe('aws');
    expect(toolIdentity('Bash', 'aws sts get-caller-identity').tile).toBe('aws');
    expect(toolIdentity('mcp__run__aws', 'eks list-clusters').tile).toBe('aws'); // naming a service in the call does not make the tool that service
    for (const service of SERVICES) expect(TILES[service]().kind === 'img' && (TILES[service]() as { src: string }).src).not.toBe(logo);
  });

  it('gives a service its own icon only when it is the subject: a console address that names it', () => {
    expect(tileForUrl('https://eu-west-1.console.aws.amazon.com/cloudtrail/home?region=eu-west-1')).toBe('cloudtrail');
    expect(tileForUrl('https://us-east-1.console.aws.amazon.com/iam/home')).toBe('iam');
    expect(tileForUrl('https://eu-west-1.console.aws.amazon.com/eks/home')).toBe('eks');
    expect(tileForUrl('https://s3.console.aws.amazon.com/s3/buckets/x')).toBe('s3');
    expect(tileForUrl('https://eu-west-1.console.aws.amazon.com/ec2/home')).toBe('aws'); // a service with no icon of its own here is AWS
    expect(tileForUrl('https://eu-west-1.console.aws.amazon.com/')).toBe('aws');
    expect(tileForUrl('https://myorg.awsapps.com/start')).toBe('aws');
  });

  it('keeps every service icon out of what stands for a tool', () => {
    const forTools: Array<[string, TileName[]]> = [
      ['the proxies', Object.values(PROXY_TILES)],
      ['the run tools', Object.values(RUN_TOOLS).map((t) => t.tile)],
      ['the shell programs', Object.values(PROGRAMS)],
      ['her activity', Object.values(ACTIVITY_TILES)],
      ['the abilities', Object.values(TOOL_TILE)],
    ];
    for (const [where, tiles] of forTools) for (const service of SERVICES) expect(tiles, `${where}: ${service}`).not.toContain(service);
  });

  it('gives each tool its own brand, never another’s: yarn is not npm, Bash’s scripts are not Kubernetes, her workspace is not Claude', () => {
    expect(PROGRAMS.yarn).toBe('yarn');
    expect(PROGRAMS.sh).toBe('shell');
    expect(PROXY_TILES.shop).toBe('shell');
    expect(RUN_TOOLS.shop!.tile).toBe('shell');
    expect(ACTIVITY_TILES.workspace).toBe('workspace');
    // No two tools share a brand tile unless they are one brand (npm and npx; kubectl and Kubernetes).
    const brands = new Map<TileName, string[]>();
    for (const [program, tile] of Object.entries(PROGRAMS)) brands.set(tile, [...(brands.get(tile) ?? []), program]);
    expect(brands.get('npm')).toEqual(['npm', 'npx']);
    expect(brands.get('kubernetes')).toEqual(['kubectl']);
    expect(brands.get('bash')).toEqual(['bash']);
  });
});

describe('no tile is drawn from text', () => {
  it('has no monogram kind, class or text in the app’s source', () => {
    const files = walk(join(root, 'apps/web/src')).filter((f) => /\.(tsx?|css)$/.test(f));
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      if (/kind:\s*'mono'|tile--mono|ability-mono|confluence-icon|monogram/.test(text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''))) offenders.push(relative(root, file));
    }
    expect(offenders).toEqual([]);
  });
});

describe('every icon file is used and has its source and licence written down', () => {
  const sources = readFileSync(join(assets, 'SOURCES.md'), 'utf8');
  const registry = ['toolIcons.ts', 'linkIcons.ts'].map((f) => readFileSync(join(root, 'apps/web/src/ui', f), 'utf8')).join('\n');
  const base = (file: string): string => file.replace(/^.*\//, '').replace(/\.svg$/, '');

  it('has a row in SOURCES.md for each file (by its name), and for each folder its licence file', () => {
    for (const file of svgs) expect(sources.includes(base(file)) || sources.includes(base(file).replace(/_48x1$/, '')), relative(assets, file)).toBe(true);
    for (const dir of ['atlassian', 'github', 'kubernetes', 'lucide', 'simple-icons']) expect(walk(join(assets, dir)).some((f) => /LICENSE/.test(f)), `${dir}/LICENSE`).toBe(true);
    expect(sources).toMatch(/Microsoft publishes no licence/);
  });

  it('is used by the registry: no file sits in assets/tool-icons that no tile, link, file type or state asks for', () => {
    const unused = svgs.filter((file) => {
      const name = base(file);
      if (file.includes('/file-types/')) return !Object.values(['docx', 'xlsx', 'pptx', 'pdf', 'txt', 'csv', 'zip', 'xml', 'html', 'code', 'photo', 'genericfile'] satisfies FileKind[]).includes(name as FileKind);
      if (file.includes('/github/') && /-16$/.test(name)) return !Object.values(STATE_ICONS).some((s) => s.file === name) && name !== 'mark-github-16';
      return !registry.includes(name) && !registry.includes(name.replace(/_48x1$/, ''));
    });
    expect(unused.map((f) => relative(assets, f))).toEqual([]);
  });

  it('loads: every file the registry names exists', () => {
    for (const kind of ['docx', 'xlsx', 'pptx', 'pdf', 'txt', 'csv', 'zip', 'xml', 'html', 'code', 'photo', 'genericfile'] satisfies FileKind[]) expect(isSvg(fileIconSrc(kind))).toBe(true);
    for (const spec of Object.values(STATE_ICONS)) expect(isSvg(iconUrl(`github/${spec.file}.svg`))).toBe(true);
  });
});

describe('links get their tool’s icon by their domain', () => {
  it.each([
    ['https://acme.atlassian.net/wiki/spaces/SHOP/pages/123/Plan', 'confluence'],
    ['https://acme.atlassian.net/browse/SHOP-3546', 'jira'],
    ['https://acme.atlassian.net/jira/software/projects/SHOP/boards/1', 'jira'],
    ['https://github.com/acme/shop-api/pull/140', 'github'],
    ['https://raw.githubusercontent.com/o/r/main/x.md', 'github'],
    ['https://outlook.office.com/mail/inbox/id/AAMk', 'outlook'],
    ['https://outlook.office365.com/owa/?path=/calendar', 'outlook'],
    ['https://teams.microsoft.com/l/message/19:abc/123', 'teams'],
    ['https://acme.sharepoint.com/sites/Eng/Shared%20Documents/x.docx', 'sharepoint'],
    ['https://acme-my.sharepoint.com/personal/foqs/Documents/x.xlsx', 'onedrive'],
    ['https://1drv.ms/w/s!abc', 'onedrive'],
    ['https://app.us1.coralogix.com/#/query-new/logs', 'coralogix'],
    ['https://eu-west-1.console.aws.amazon.com/eks/home', 'eks'],
    ['https://eu-west-1.console.aws.amazon.com/ec2/home', 'aws'],
    ['https://kubernetes.io/docs/concepts/', 'kubernetes'],
    ['https://hub.docker.com/r/library/node', 'docker'],
    ['https://www.npmjs.com/package/vitest', 'npm'],
    ['https://claude.ai/chat/abc', 'claude'],
  ])('%s is %s', (url, tile) => {
    expect(tileForUrl(url)).toBe(tile);
    expect(isIcon(tile as TileName)).toBe(true);
  });

  it('gives nothing to an address nobody here knows, or to what is not a web address (never a letter or a guess)', () => {
    for (const url of ['https://example.org/a', 'https://githubx.com/', 'https://evilgithub.com/x', 'javascript:alert(1)', 'data:text/html,x', 'mailto:a@b.c', 'not a url', '']) expect(tileForUrl(url), url).toBeNull();
  });
});

describe('attachments get their type’s icon, and states GitHub’s', () => {
  it.each([
    ['report.docx', undefined, 'docx'],
    ['Budget.XLSX', undefined, 'xlsx'],
    ['deck.pptx', undefined, 'pptx'],
    ['scan.pdf', undefined, 'pdf'],
    ['notes.md', undefined, 'txt'],
    ['export.csv', undefined, 'csv'],
    ['logs.tar.gz', undefined, 'zip'],
    ['config.yaml', undefined, 'code'],
    ['shot.png', undefined, 'photo'],
    ['page.html', undefined, 'html'],
    ['feed.xml', undefined, 'xml'],
    ['LICENSE', undefined, 'genericfile'],
    ['blob', 'image/png', 'photo'],
    ['blob', 'application/pdf', 'pdf'],
    ['blob', 'application/octet-stream', 'genericfile'],
  ])('%s (%s) is a %s', (name, mime, kind) => {
    expect(fileKind(name, mime)).toBe(kind);
    expect(isSvg(fileIconSrc(kind as FileKind))).toBe(true);
  });

  it('draws a pull request’s state and its CI’s with GitHub’s own icons', () => {
    expect([prStateIcon('open'), prStateIcon('draft'), prStateIcon('merged'), prStateIcon('closed')]).toEqual(['pr-open', 'pr-draft', 'pr-merged', 'pr-closed']);
    expect(Object.keys(STATE_ICONS)).toEqual(['pr-open', 'pr-draft', 'pr-merged', 'pr-closed', 'ci-passed', 'ci-failed', 'ci-running', 'ci-skipped', 'branch']);
  });
});

describe('a vendor’s logo as a watermark: its own paths without what a watermark cannot take', () => {
  const svgOf = (src: string): string => decodeURIComponent(src.replace(/^data:image\/svg\+xml,/, ''));
  const markOf = (name: TileName): string => {
    const tile = TILES[name]();
    expect(tile.mark, `${name} has a mark`).toBeTruthy();
    return svgOf(tile.mark!);
  };

  it('is Jira’s and Confluence’s mark in Atlassian’s blue, without the blue square it is set on', () => {
    for (const name of ['jira', 'confluence'] as const) {
      const mark = markOf(name);
      expect(mark, name).not.toContain('M0 6a6 6 0 0 1 6-6h12a6 6 0 0 1 6 6v12a6 6 0 0 1-6 6H6a6 6 0 0 1-6-6z');
      expect(mark, name).not.toContain('fill="white"');
      expect(mark, name).toContain('fill="#1868db"');
    }
  });

  it('is the AWS logo without its dark square, and Kubernetes’ heptagon with the wheel cut out of it', () => {
    expect(markOf('aws')).not.toContain('id="Rectangle"');
    expect(markOf('aws')).toContain('id="Fill-1"');
    const kubernetes = markOf('kubernetes');
    expect(kubernetes).not.toContain('fill:#ffffff');
    expect(kubernetes).toContain('fill:#326ce5');
    expect(kubernetes).toContain('fill:#0d1010');
  });

  it('is the vendor’s file itself, unchanged, where there is nothing to take out (the official files stay as they are)', () => {
    expect(TILES.coralogix().kind).toBe('img');
    expect((TILES.coralogix() as { mark?: string }).mark).toBeUndefined();
    // The tile that is shown everywhere else is still the official file.
    expect(TILES.jira().src).toBe(iconUrl('atlassian/jira.svg'));
    expect(TILES.aws().src).toBe(iconUrl('aws/AWS-Cloud-logo_32.svg'));
    expect(TILES.kubernetes().src).toBe(iconUrl('kubernetes/logo.svg'));
  });

  it('gives her own workspace her fox, not a generic icon', () => {
    expect(TOOL_TILE.elfoqsy).toBe('elfoqsy');
    expect(toolName('elfoqsy')).toBe('Elfoqsy');
    expect(TILES.elfoqsy().src).toMatch(/fox-quiet/);
  });
});
