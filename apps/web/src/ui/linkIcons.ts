// Which tool an address, a file or a state is, so that it shows that tool's icon and never a letter: links by their domain
// (Confluence, Jira, Outlook, Teams, SharePoint, OneDrive, GitHub, Coralogix, AWS and the rest), attachments by their type
// (Microsoft's file type icons) and pull requests and CI by GitHub's own state icons. Pure, so the tests read the same rules.
import { iconUrl, type TileName } from './toolIcons';

/** The tool a web address belongs to, by its host (and for Atlassian's cloud, its path): null for an address nobody here knows. */
export function tileForUrl(address: string): TileName | null {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol)) return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const on = (...domains: string[]): boolean => domains.some((d) => host === d || host.endsWith(`.${d}`));
  if (on('atlassian.net')) return url.pathname.startsWith('/wiki') ? 'confluence' : 'jira';
  if (on('atlassian.com')) return url.pathname.startsWith('/wiki') ? 'confluence' : 'rovo';
  if (on('github.com', 'githubusercontent.com', 'ghcr.io')) return 'github';
  if (on('outlook.office.com', 'outlook.office365.com', 'outlook.live.com', 'outlook.cloud.microsoft')) return 'outlook';
  if (on('teams.microsoft.com', 'teams.live.com', 'teams.cloud.microsoft')) return 'teams';
  // A personal OneDrive is a SharePoint host of its own (acme-my.sharepoint.com).
  if (/-my\.sharepoint\.com$/.test(host) || on('onedrive.live.com', 'onedrive.com', '1drv.ms')) return 'onedrive';
  if (on('sharepoint.com')) return 'sharepoint';
  if (on('office.com', 'microsoft365.com', 'm365.cloud.microsoft', 'cloud.microsoft')) return 'microsoft365';
  if (on('coralogix.com')) return 'coralogix';
  if (on('console.aws.amazon.com', 'aws.amazon.com', 'awsapps.com', 'amazonaws.com')) return awsServiceTile(url.pathname) ?? 'aws';
  if (on('kubernetes.io')) return 'kubernetes';
  if (on('docker.com', 'docker.io')) return 'docker';
  if (on('npmjs.com')) return 'npm';
  if (on('pnpm.io')) return 'pnpm';
  if (on('nodejs.org')) return 'node';
  if (on('helm.sh')) return 'helm';
  if (on('sonarsource.com', 'sonarcloud.io', 'sonarqube.org')) return 'sonar';
  if (on('blackduck.com', 'blackducksoftware.com')) return 'blackduck';
  if (on('smartbear.com')) return 'zephyr';
  if (on('claude.ai', 'claude.com', 'anthropic.com')) return 'claude';
  if (on('git-scm.com')) return 'git';
  return null;
}

/** A service the console's address names on its own (/cloudtrail/home, /iam/home): that service's icon; else the AWS logo. */
const AWS_SERVICES: Record<string, TileName> = { eks: 'eks', ecr: 'ecr', s3: 's3', iam: 'iam', cloudtrail: 'cloudtrail' };
export const awsServiceTile = (path: string): TileName | null => AWS_SERVICES[/^\/([a-z0-9-]+)/.exec(path.toLowerCase())?.[1] ?? ''] ?? null;

/** The kinds of file an attachment can be: Microsoft's file type icons, by what the file is. */
export type FileKind = 'docx' | 'xlsx' | 'pptx' | 'pdf' | 'txt' | 'csv' | 'zip' | 'xml' | 'html' | 'code' | 'photo' | 'genericfile';

const BY_EXTENSION: Record<string, FileKind> = {
  doc: 'docx', docx: 'docx', docm: 'docx', odt: 'docx', rtf: 'docx',
  xls: 'xlsx', xlsx: 'xlsx', xlsm: 'xlsx', ods: 'xlsx',
  ppt: 'pptx', pptx: 'pptx', pptm: 'pptx', odp: 'pptx',
  pdf: 'pdf',
  txt: 'txt', md: 'txt', markdown: 'txt', log: 'txt', text: 'txt',
  csv: 'csv', tsv: 'csv',
  zip: 'zip', gz: 'zip', tgz: 'zip', tar: 'zip', '7z': 'zip', rar: 'zip', bz2: 'zip', xz: 'zip',
  xml: 'xml', xsd: 'xml', xsl: 'xml',
  html: 'html', htm: 'html',
  json: 'code', yaml: 'code', yml: 'code', toml: 'code', js: 'code', mjs: 'code', cjs: 'code', ts: 'code', tsx: 'code', jsx: 'code', py: 'code', sh: 'code', bash: 'code', java: 'code', go: 'code', rs: 'code', c: 'code', cpp: 'code', h: 'code', cs: 'code', rb: 'code', php: 'code', sql: 'code', css: 'code', ini: 'code', conf: 'code', properties: 'code', dockerfile: 'code',
  png: 'photo', jpg: 'photo', jpeg: 'photo', gif: 'photo', webp: 'photo', bmp: 'photo', svg: 'photo', ico: 'photo', tif: 'photo', tiff: 'photo', heic: 'photo',
};

/** What an attachment is, from its name and (when the name says nothing) its media type. */
export function fileKind(filename: string, mimeType?: string): FileKind {
  const extension = /\.([A-Za-z0-9]+)$/.exec(filename)?.[1]?.toLowerCase() ?? filename.toLowerCase();
  const known = BY_EXTENSION[extension];
  if (known) return known;
  const mime = (mimeType ?? '').toLowerCase();
  if (mime.startsWith('image/')) return 'photo';
  if (mime === 'application/pdf') return 'pdf';
  if (mime.includes('zip') || mime.includes('tar') || mime.includes('compressed')) return 'zip';
  if (mime.includes('json') || mime.includes('javascript') || mime.includes('yaml')) return 'code';
  if (mime.includes('xml')) return 'xml';
  if (mime.includes('html')) return 'html';
  if (mime.startsWith('text/')) return 'txt';
  return 'genericfile';
}

/** The workspace's own file type icon for a kind of file (assets/tool-icons/file-types, drawn for this project). */
export const fileIconSrc = (kind: FileKind): string => iconUrl(`file-types/${kind}.svg`);

/** GitHub's own icons for the state of a pull request and of its CI (Octicons), with the colour each is drawn in. */
export const STATE_ICONS = {
  'pr-open': { file: 'git-pull-request-16', ink: '--green-400', label: 'Open' },
  'pr-draft': { file: 'git-pull-request-draft-16', ink: '--gray-400', label: 'Draft' },
  'pr-merged': { file: 'git-merge-16', ink: '--violet-400', label: 'Merged' },
  'pr-closed': { file: 'git-pull-request-closed-16', ink: '--red-400', label: 'Closed' },
  'ci-passed': { file: 'check-circle-fill-16', ink: '--green-400', label: 'CI passed' },
  'ci-failed': { file: 'x-circle-fill-16', ink: '--red-400', label: 'CI failed' },
  'ci-running': { file: 'clock-16', ink: '--blue-400', label: 'CI running' },
  'ci-skipped': { file: 'skip-16', ink: '--gray-500', label: 'CI skipped' },
  branch: { file: 'git-branch-16', ink: '--gray-400', label: 'Branch' },
} as const;
export type StateIconName = keyof typeof STATE_ICONS;

/** The icon of a pull request's state, as GitHub's own states are named. */
export const prStateIcon = (state: string): StateIconName => (state === 'merged' ? 'pr-merged' : state === 'closed' ? 'pr-closed' : state === 'draft' ? 'pr-draft' : 'pr-open');
