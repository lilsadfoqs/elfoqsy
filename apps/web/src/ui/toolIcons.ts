// Which tool a call is, as the cards and Elfoqsy's thinking indicator show it: its display name (the program a shell
// command runs, the proxy's tool), the call without that name, and its tile. Icons are the original files in
// assets/tool-icons (sources and licences in SOURCES.md): each vendor's own (Atlassian, Microsoft, GitHub, Kubernetes, AWS,
// Coralogix), brand marks drawn white on their brand colour, and Lucide's generic icons for a kind of tool with no official
// file (Black Duck, Zephyr). Never a letter: a tool with no icon gets a generic one (`other`), and a test checks every tool and
// connector the proxies know (test/icons.test.ts).

import type { ActivityTool, ProxyName } from '@elfoqsy/contracts';
import { ART } from './elfoqsy';

const files = import.meta.glob<string>('../../../../assets/tool-icons/**/*.svg', { eager: true, import: 'default' });

/** An icon file of assets/tool-icons by its path there. */
export function iconUrl(path: string): string {
  const src = files[`../../../../assets/tool-icons/${path}`];
  if (!src) throw new Error(`assets/tool-icons/${path} is missing`);
  return src;
}
const icon = iconUrl;

/**
 * A tile: a logo drawn as a mask in the tile's ink on a colour, a vendor's own full-colour file on a neutral tile (`bg`), or one
 * that is its own tile (`bg: null`: Atlassian's and Microsoft's product icons, whose colours are not changed). Colours are token names.
 */
export type Tile = { kind: 'mask'; src: string; bg: string; ink: string; mark?: string } | { kind: 'img'; src: string; bg: string | null; mark?: string };

const rawFiles = import.meta.glob<string>('../../../../assets/tool-icons/{atlassian,aws,kubernetes,lucide}/*.svg', { eager: true, query: '?raw', import: 'default' });

/**
 * A vendor's logo as a watermark: its own paths, with what a watermark cannot take left out. Atlassian's and AWS's files are the mark
 * on a square (Jira's blue rounded square, AWS's dark one), and a square at 209 px fills a card; Kubernetes' wheel is white, a hot
 * spot at 16% over a dark card, so it is drawn in the card's own colour: the heptagon's cut-out. Where the file is not as expected (an edit finds
 * nothing to change) the file itself is returned.
 */
const marks = new Map<string, string>();
function mark(path: string, edits: Array<[string | RegExp, string]>): string {
  const known = marks.get(path);
  if (known) return known;
  const svg = rawFiles[`../../../../assets/tool-icons/${path}`];
  if (!svg || !edits.every(([from]) => (typeof from === 'string' ? svg.includes(from) : from.test(svg)))) return icon(path);
  const edited = edits.reduce((s, [from, to]) => (typeof from === 'string' ? s.replaceAll(from, to) : s.replace(from, to)), svg);
  const src = `data:image/svg+xml,${encodeURIComponent(edited)}`;
  marks.set(path, src);
  return src;
}
const ATLASSIAN_TILE = /<path fill="#1868db" d="M0 6a6 6 0 0 1 6-6h12a6 6 0 0 1 6 6v12a6 6 0 0 1-6 6H6a6 6 0 0 1-6-6z"\/>/;
/** Atlassian's mark is its blue: what was white on the square is blue without it. */
const atlassian = (path: string): Tile => ({ kind: 'img', src: icon(path), bg: null, mark: mark(path, [[ATLASSIAN_TILE, ''], ['fill="white"', 'fill="#1868db"']]) });

const brand = (file: string, bg: string): Tile => ({ kind: 'mask', src: icon(`simple-icons/${file}.svg`), bg, ink: '--tile-ink' });
const plain = (file: string): Tile => ({ kind: 'mask', src: icon(`lucide/${file}.svg`), bg: '--tile-neutral', ink: '--text-primary' });
/**
 * A vendor's file that is its own tile. Where the file is not there (a licence he has not confirmed, say, and the file is taken
 * out), the generic icon for the kind of tool takes its place: never a letter.
 */
const own = (path: string, generic?: () => Tile): Tile => (generic && !files[`../../../../assets/tool-icons/${path}`] ? generic() : { kind: 'img', src: icon(path), bg: null });
/** A vendor's full-colour file on the neutral tile. */
const framed = (path: string): Extract<Tile, { kind: 'img' }> => ({ kind: 'img', src: icon(path), bg: '--tile-neutral' });

export const TILES = {
  git: () => brand('git', '--tile-git'),
  github: (): Tile => ({ kind: 'mask', src: icon('github/mark-github-16.svg'), bg: '--tile-neutral', ink: '--text-primary' }),
  jira: () => atlassian('atlassian/jira.svg'),
  confluence: () => atlassian('atlassian/confluence.svg'),
  rovo: () => own('atlassian/rovo.svg'),
  kubernetes: (): Tile => ({ ...framed('kubernetes/logo.svg'), mark: mark('kubernetes/logo.svg', [['fill:#ffffff', 'fill:#0d1010']]) }),
  npm: () => brand('npm', '--tile-npm'),
  pnpm: () => brand('pnpm', '--tile-pnpm'),
  yarn: () => brand('yarn', '--tile-neutral'),
  node: () => brand('nodedotjs', '--tile-node'),
  docker: () => brand('docker', '--tile-docker'),
  helm: () => brand('helm', '--tile-helm'),
  sonar: () => brand('sonar', '--tile-sonar'),
  kafka: () => brand('apachekafka', '--tile-neutral'),
  claude: () => brand('claude', '--tile-claude'),
  bash: () => brand('gnubash', '--tile-neutral'),
  // AWS as a tool is the AWS logo (the AWS Cloud logo of the Architecture Icons); a service's own icon is only for a service named on its own.
  aws: (): Tile => ({ ...framed('aws/AWS-Cloud-logo_32.svg'), mark: mark('aws/AWS-Cloud-logo_32.svg', [[/<rect id="Rectangle" fill="#242F3E"[^>]*><\/rect>/, '']]) }),
  // Her own workspace (an ability about her runs, events and sprint): her fox, the badge of her art.
  elfoqsy: (): Tile => ({ kind: 'img', src: ART.quiet.fox, bg: null }),
  eks: () => framed('aws/Arch_Amazon-Elastic-Kubernetes-Service_32.svg'),
  ecr: () => framed('aws/Arch_Amazon-Elastic-Container-Registry_32.svg'),
  s3: () => framed('aws/Arch_Amazon-Simple-Storage-Service_32.svg'),
  iam: () => framed('aws/Arch_AWS-Identity-and-Access-Management_32.svg'),
  cloudtrail: () => framed('aws/Arch_AWS-CloudTrail_32.svg'),
  coralogix: () => framed('coralogix/coralogix-green-icon.svg'),
  minikube: () => framed('minikube/minikube-logo.svg'),
  // Microsoft 365 products: generic icons of their kind (Microsoft publishes no licence for its product icons).
  outlook: () => plain('mail'),
  teams: () => plain('message-square'),
  sharepoint: () => plain('folder-open'),
  onedrive: () => plain('cloud'),
  microsoft365: () => plain('user'),
  // No official file exists for these (SOURCES.md): a generic icon for what the tool is, never a letter.
  blackduck: () => plain('shield-check'),
  zephyr: () => plain('flask-conical'),
  link: () => plain('link'),
  read: () => plain('file-text'),
  edit: () => plain('pencil'),
  write: () => plain('file-plus'),
  grep: () => plain('search'),
  glob: () => plain('folder-search'),
  web: () => plain('globe'),
  agent: (): Tile => ({ kind: 'mask', src: icon('lucide/bot.svg'), bg: '--tile-agent', ink: '--text-primary' }),
  shell: () => plain('terminal'),
  goal: () => plain('target'),
  step: () => plain('flag'),
  heartbeat: () => plain('activity'),
  result: () => plain('clipboard-check'),
  question: () => plain('message-circle-question'),
  // The prototype draws its flask a little lighter than Lucide's 2 px line: 1.6, for the watermark.
  test: (): Tile => ({ ...plain('flask-conical'), mark: mark('lucide/flask-conical.svg', [['stroke-width="2"', 'stroke-width="1.6"']]) }),
  workspace: () => plain('layout-dashboard'),
  other: () => plain('sparkles'),
} satisfies Record<string, () => Tile>;

export type TileName = keyof typeof TILES;

/** A shell program and its tile; anything else is a plain shell command. */
export const PROGRAMS: Record<string, TileName> = {
  git: 'git',
  npm: 'npm',
  npx: 'npm',
  pnpm: 'pnpm',
  yarn: 'yarn',
  node: 'node',
  docker: 'docker',
  helm: 'helm',
  kubectl: 'kubernetes',
  minikube: 'minikube',
  aws: 'aws',
  gh: 'github',
  bash: 'bash',
  sh: 'shell',
};

export interface ToolIdentity {
  /** The name in bold: "npm", "kubectl", "Jira", "Read", "Sub-agent". */
  name: string;
  /** The call after the name, in mono. */
  call: string;
  tile: TileName;
}

/**
 * The tile of every proxy the daemon has (git and gh, kube, aws, jira, confluence, logs, file, docker, shop, web). A record over
 * the contract's names, so a proxy added without an icon is a type error.
 */
export const PROXY_TILES: Record<ProxyName, TileName> = {
  git: 'git',
  gh: 'github',
  kube: 'kubernetes',
  aws: 'aws',
  jira: 'jira',
  confluence: 'confluence',
  logs: 'coralogix',
  file: 'write',
  docker: 'docker',
  shop: 'shell', // the team's own script: no brand, a generic icon for a script (not Kubernetes')
  web: 'web',
};

export const RUN_TOOLS: Record<string, { name: string; tile: TileName }> = {
  kube: { name: 'kubectl', tile: PROXY_TILES.kube },
  aws: { name: 'aws', tile: PROXY_TILES.aws },
  gh: { name: 'gh', tile: PROXY_TILES.gh },
  jira: { name: 'Jira', tile: PROXY_TILES.jira },
  confluence: { name: 'Confluence', tile: PROXY_TILES.confluence },
  logs: { name: 'Coralogix', tile: PROXY_TILES.logs },
  docker: { name: 'docker', tile: PROXY_TILES.docker },
  shop: { name: 'shop.sh', tile: PROXY_TILES.shop },
  report_verdict: { name: 'report_verdict', tile: 'result' },
  declare_inputs: { name: 'declare_inputs', tile: 'goal' },
  report_hypothesis: { name: 'report_hypothesis', tile: 'question' },
  report_finding: { name: 'report_finding', tile: 'result' },
  ask_decision: { name: 'ask_decision', tile: 'question' },
  declare_goal: { name: 'declare_goal', tile: 'goal' },
  begin_step: { name: 'begin_step', tile: 'step' },
  heartbeat: { name: 'heartbeat', tile: 'heartbeat' },
  report_result: { name: 'report_result', tile: 'result' },
  request_check_approval: { name: 'request_check_approval', tile: 'result' },
  ask_user: { name: 'ask_user', tile: 'question' },
};

export const FILE_TOOLS: Record<string, TileName> = { Read: 'read', Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit', Write: 'write', Grep: 'grep', Glob: 'glob', WebFetch: 'web', WebSearch: 'web' };

/** The tool a call is, from its tool name and its title as the transcript keeps it. */
export function toolIdentity(tool: string, title: string): ToolIdentity {
  const run = /^mcp__run__(.+)$/.exec(tool)?.[1];
  if (run) {
    const known = RUN_TOOLS[run];
    // The proxies' titles are the arguments after the program's name; older ones may still start with it.
    const call = known ? title.replace(new RegExp(`^(${known.name}|${run})\\s+`, 'i'), '') : title;
    return { name: known?.name ?? run, call, tile: known?.tile ?? 'claude' };
  }
  if (tool === 'Bash') {
    // "cd shop-api && npm run test:unit" is an npm call in shop-api.
    const command = title.replace(/^cd\s+\S+\s*&&\s*/, '').replace(/^([A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '');
    const [program = '', ...rest] = command.split(/\s+/);
    const base = program.split('/').at(-1) ?? program;
    const tile = PROGRAMS[base];
    if (tile) return { name: base, call: rest.join(' '), tile };
    return { name: base || 'Bash', call: rest.join(' '), tile: 'shell' };
  }
  if (tool === 'Agent' || tool === 'Task') return { name: 'Sub-agent', call: title, tile: 'agent' };
  const file = FILE_TOOLS[tool];
  if (file) return { name: tool, call: title, tile: file };
  // A tool of an MCP server or a claude.ai connector: its own name, and the service's icon (a generic one for a server nobody knows).
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
  if (mcp) return { name: mcp[2]!, call: title, tile: mcpServerTile(mcp[1]!) };
  return { name: tool, call: title, tile: 'other' };
}

/** The tile of an MCP server by its name: a claude.ai connector (claude_ai_Microsoft_365) or one of his own (blackduck-sca). */
export function mcpServerTile(server: string): TileName {
  const name = server.replace(/^claude[_.\s]ai[_.\s]/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const known: Array<[RegExp, TileName]> = [
    [/^(microsoft365|m365|office365)$/, 'microsoft365'],
    [/outlook/, 'outlook'],
    [/teams/, 'teams'],
    [/sharepoint/, 'sharepoint'],
    [/onedrive/, 'onedrive'],
    [/rovo|atlassian/, 'rovo'],
    [/jira/, 'jira'],
    [/confluence/, 'confluence'],
    [/coralogix/, 'coralogix'],
    [/github/, 'github'],
    [/blackduck/, 'blackduck'],
    [/sonar/, 'sonar'],
    [/zephyr/, 'zephyr'],
    [/docker/, 'docker'],
    [/kubernetes|k8s/, 'kubernetes'],
    [/^(claudedocs|claude)$/, 'claude'],
  ];
  return known.find(([pattern]) => pattern.test(name))?.[1] ?? 'other';
}

/** Elfoqsy's activity tiles, by what an action reached: the service's own icon, or a generic one for the kind of work. */
export const ACTIVITY_TILES: Record<ActivityTool, TileName> = {
  jira: 'jira',
  github: 'github',
  confluence: 'confluence',
  code: 'grep',
  logs: 'coralogix',
  agent: 'agent',
  memory: 'result',
  workspace: 'workspace',
  kube: 'kubernetes',
  aws: 'aws',
  outlook: 'outlook',
  teams: 'teams',
  sharepoint: 'sharepoint',
  microsoft365: 'microsoft365',
};

/** The tile of an activity line: the wire carries a plain string so that an older log replays, and a name nobody knows is generic. */
export const activityTile = (tool: string): TileName => (ACTIVITY_TILES as Record<string, TileName>)[tool] ?? 'other';
