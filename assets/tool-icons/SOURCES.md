# Tool icons: where each file comes from

Original files only, never redrawn (except `file-types/`, drawn for this project). Every file here is as downloaded and unchanged (the Atlassian ones say below what was done to them); the tiles draw them in white (as a mask) or in their own colours. Brand marks remain their owners' trademarks; they are used to say which tool a tile stands for, nothing more.

**One registry, never a letter**: `apps/web/src/ui/toolIcons.ts` names every tile; `ui/linkIcons.ts` maps addresses by their domain, attachments by their type and pull request and CI states; a tool or connector with no official file gets a generic icon for its kind (Lucide), never a letter. `apps/web/test/icons.test.ts` fails if a tool or connector the proxies know has no icon, if a file here is not used, or if a file has no row in this table; a browser test fails if a letter tile is drawn.

## Vendors' own files

| File | What | From | Licence and what is checked |
| --- | --- | --- | --- |
| `atlassian/jira.svg`, `atlassian/confluence.svg`, `atlassian/rovo.svg` | Jira, Confluence, Rovo (the Atlassian connector) | Atlassian's own logo package `@atlaskit/logo` 23.3.1 (npm), `artifacts/logo-components/<name>/icon.js`: the `svg` string of each component. Atlassian's design system lists it as the logo source: https://atlassian.design/components/logo | The package is Apache-2.0 (`atlassian/LICENSE`); the marks are Atlassian's trademarks. **Changed, and only so**: the CSS variables inside the file (`var(--tile-color,#1868db)`, `var(--icon-color, white)`, and Rovo's three) are replaced by their own defaults, and `xmlns`, `width="24" height="24"` are added so the file loads as an image. Drawn as it is, with no tile behind it. |
| `file-types/{docx,xlsx,pptx,pdf,txt,csv,zip,xml,html,code,photo,genericfile}.svg` | File type icons (attachments) | Drawn for this project: a page with a coloured band and the type's short name | MIT, with the rest of the repository. |
| `github/mark-github-16.svg` and the state icons `git-pull-request-16`, `git-pull-request-draft-16`, `git-merge-16`, `git-pull-request-closed-16`, `check-circle-fill-16`, `x-circle-fill-16`, `clock-16`, `skip-16`, `git-branch-16` | GitHub's mark; a pull request's and its CI's states | GitHub's Octicons `@primer/octicons` 19.41.0 (npm), `build/svg/` | MIT (`github/LICENSE`): GitHub's own icon set, and its mark as it is in Octicons. Drawn as masks in the state's colour. |
| `kubernetes/logo.svg` | Kubernetes (kubectl, the cluster) | The Kubernetes repository's own logo: https://github.com/kubernetes/kubernetes/tree/master/logo | "A choice of either Apache-2.0 or CC-BY-4.0" (`kubernetes/LICENSE`), and the Linux Foundation's trademark guidelines (`logo/usage_guidelines.md`: the mark must not imply the Foundation sponsors or endorses the product). Drawn whole on the neutral tile. |


## As a watermark on an Abilities card

No file here is changed or added for it. The card draws the tool's logo faint and turned behind its title, as the prototype does, and three vendors' files cannot be drawn that way as they are, so `ui/toolIcons.ts` (`mark()`) makes the watermark from the same file when the card is drawn, leaving out only what a watermark cannot take; the paths are the vendor's own: Jira and Confluence (`atlassian/*.svg`) are the mark on a blue rounded square, which is left out, and the white mark takes Atlassian's blue (`#1868db`, the colour of the square); the AWS logo (`aws/AWS-Cloud-logo_32.svg`) is white on a dark square, which is left out; Kubernetes' wheel (`kubernetes/logo.svg`) is white and drawn in the card's own colour, so the heptagon has the wheel cut out of it (a white wheel at 16% over a dark card is a hot spot). Everywhere else (filters of a chosen tool, chips, notices, terminals) the file is shown as it is. Each logo is drawn at the size and place it has in the prototype's picture (`MARK` in `ui/AbilityCard.tsx`). Her own workspace (an ability about her runs, events and sprint) has her fox from `assets/elfoqsy/fox/fox-quiet.png`, her own art, not a vendor's.

## simple-icons 16.35.0 (npm `simple-icons@16.35.0`), for the tools whose own kit is not a file we can fetch

These are not the vendors' own files: simple-icons traces each from the brand's kit and lists the kit's address as the official source. The SVG data is CC0 and the brands' terms apply as before. Replacing one with the vendor's own file is a one-line change in the registry (`brand()` to `own()`).

The SVG data is CC0-1.0 (`simple-icons/LICENSE.md`), and the brands' own terms still apply (`simple-icons/DISCLAIMER.md`). Each icon's official source, as simple-icons lists it:

| File | Brand | Tile colour (simple-icons hex, or the prototype's tile) | Official source |
| --- | --- | --- | --- |
| `simple-icons/git.svg` | Git | #F05032 (prototype; simple-icons #F03C2E). The logo is CC-BY-3.0, by Jason Long. | https://git-scm.com/community/logos |
| `simple-icons/npm.svg` | npm | #CB3837 | https://www.npmjs.com |
| `simple-icons/pnpm.svg` | pnpm | #F69220 | https://pnpm.io/logos |
| `simple-icons/docker.svg` | Docker | #2496ED | https://www.docker.com/company/newsroom/media-resources |
| `simple-icons/sonar.svg` | Sonar (the brand, not one of its products: SonarQube Server, Cloud and IDE are services of it) | #126ED3 | https://www.sonarsource.com/company/press-kit |
| `simple-icons/yarn.svg` | Yarn (its own mark: it was npm's) | neutral tile | https://yarnpkg.com/ |
| `simple-icons/apachekafka.svg` | Apache Kafka (Apache-2.0) | neutral tile | https://apache.org/logos |
| `simple-icons/nodedotjs.svg` | Node.js | #5FA04E | https://nodejs.org/en/about/branding |
| `simple-icons/helm.svg` | Helm | #0F1689 | https://helm.sh |
| `simple-icons/gnubash.svg` | GNU Bash (MIT) | neutral tile | https://github.com/odb/official-bash-logo/tree/61eff022f2dad3c7468f5deb4f06652d15f2c143 |
| `simple-icons/claude.svg` | Claude | #D97757 | https://claude.ai |

## Vendors' official kits, for brands simple-icons lacks

| File | Brand | From | Terms |
| --- | --- | --- | --- |
| `aws/AWS-Cloud-logo_32.svg` | **AWS, the tool** (the aws CLI, a link to the console, a card, a chip, a filter): the AWS logo | AWS Architecture Icons, package 07312026: https://d1.awsstatic.com/onedam/marketing-channels/website/public/shared/architecture-icon-release/Icon-package_07312026.5846e92413caa21490223536cc97f1269e44fa92.zip, `Architecture-Group-Icons_07312026/AWS-Cloud-logo_32.svg` (linked from https://aws.amazon.com/architecture/icons/) | "We allow customers and partners to use these toolkits and assets to create architecture diagrams" and similar materials. The file carries its own dark square, so the tile shows it whole. The AWS logo stands for AWS as a whole; a service's own icon is used only where that service is the subject. |
| `aws/Arch_Amazon-Elastic-Kubernetes-Service_32.svg`, `Arch_Amazon-Elastic-Container-Registry_32.svg`, `Arch_Amazon-Simple-Storage-Service_32.svg`, `Arch_AWS-Identity-and-Access-Management_32.svg`, `Arch_AWS-CloudTrail_32.svg` | **A service named on its own**: EKS, ECR, S3, IAM, CloudTrail | The same package, `Architecture-Service-Icons_07312026/` | The same. Shown only where the service is the subject (a console address that names it, `/cloudtrail/home`, `/iam/home`); everything else about AWS shows the AWS logo. |
| `coralogix/coralogix-green-icon.svg` (the kit's white one is not used, and is not kept) | Coralogix (the logs tool) | Coralogix Logo Kit: https://go.coralogix.com/rs/371-WTH-691/images/Coralogix-Logo-Kit.zip (linked from https://land.coralogix.com/brand) | The brand page invites use and asks: no modified logos, not combined with another logo, the right background and contrast. |
| `minikube/minikube-logo.svg` | minikube | the minikube repository's own logo: https://raw.githubusercontent.com/kubernetes/minikube/master/images/logo/logo.svg (the README shows images/logo/logo.png) | The repository is Apache-2.0; the mark is minikube's (Kubernetes). |

**No official file, so the tile is a generic icon for what the tool is** (never a letter; only third-party copies turned up, which are not used):
- Black Duck: no official media kit on blackduck.com (shield-check).
- Zephyr (SmartBear): no official brand-assets page on smartbear.com (flask).
- Microsoft 365 products (Outlook, Teams, SharePoint, OneDrive): Microsoft publishes no licence for its product icons, so links to them get generic icons (mail, chat, folder, cloud, person).
Neither Black Duck nor Zephyr has a tool in the workspace yet.

## Lucide 1.55.0 (npm `lucide-static@1.55.0`, ISC, `lucide/LICENSE`)

For tools without a brand:

| File | Tools |
| --- | --- |
| `lucide/file-text.svg` | Read |
| `lucide/flask-conical.svg` | an ability about tests; Zephyr (no official file) |
| `lucide/sparkles.svg` | an ability about another tool |
| `lucide/pencil.svg` | Edit, MultiEdit, NotebookEdit |
| `lucide/file-plus.svg` | Write |
| `lucide/search.svg` | Grep |
| `lucide/folder-search.svg` | Glob |
| `lucide/globe.svg` | WebFetch, WebSearch |
| `lucide/bot.svg` | Sub-agent (Agent, Task) |
| `lucide/terminal.svg` | a plain shell command |
| `lucide/target.svg` | declare_goal |
| `lucide/flag.svg` | begin_step |
| `lucide/activity.svg` | heartbeat |
| `lucide/clipboard-check.svg` | report_result, request_check_approval |
| `lucide/message-circle-question.svg` | ask_user |
| `lucide/shield-check.svg` | Black Duck (no official file) |
| `lucide/link.svg` | the generic `link` tile |
| `lucide/mail.svg` | Outlook, if its Microsoft file is taken out |
| `lucide/message-square.svg` | Teams, if its Microsoft file is taken out |
| `lucide/folder-open.svg` | SharePoint, if its Microsoft file is taken out |
| `lucide/cloud.svg` | OneDrive, if its Microsoft file is taken out |
| `lucide/user.svg` | Microsoft 365, if its Microsoft file is taken out |
| `lucide/layout-dashboard.svg` | the workspace's own actions in her activity (it was the Claude logo) |

Source: https://www.npmjs.com/package/lucide-static/v/1.55.0, https://lucide.dev
