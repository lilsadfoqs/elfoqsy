// Prints what the SDK's sandbox does for each agent kind that has a shell, as a table: the same proof as
// test/sandbox-proof.test.ts, for reading. `pnpm --filter @elfoqsy/daemon sandbox:proof`. No Claude call is made.
import { rmSync } from 'node:fs';
import { hostServers, makeLayout, runProof, sandboxAvailable, type Kind } from '../helpers/sandboxProof';

if (!sandboxAvailable()) {
  console.log('The sandbox cannot run here (it needs bubblewrap, socat and user namespaces).');
  process.exit(1);
}
const kinds: Kind[] = ['ticket', 'task', 'subagent'];
const runs = await Promise.all(
  kinds.map(async (kind, i) => {
    const layout = makeLayout(`k${i}`);
    const servers = await hostServers(layout);
    const proof = await runProof(kind, layout, servers);
    await servers.close();
    rmSync(layout.tmpMarker, { force: true });
    return { kind, layout, proof };
  }),
);
const names = [...runs[0]!.proof.results.keys()];
const width = Math.max(...names.map((n) => n.length)) + 2;
console.log(`${''.padEnd(width)}${kinds.map((k) => k.padEnd(14)).join('')}`);
for (const name of names) console.log(`${name.padEnd(width)}${runs.map((r) => (r.proof.results.get(name) ?? '-').padEnd(14)).join('')}`);
for (const { kind, layout, proof } of runs) {
  console.log(`${kind}: files created on the host: ${JSON.stringify(proof.created.map((p) => p.replace(layout.base, '<base>')))}, .bashrc untouched: ${proof.bashrc === '# bashrc\n'}`);
  rmSync(layout.base, { recursive: true, force: true });
}
console.log('\nA write that exits 0 but created nothing on the host went to the sandbox’s private layer. Read: READABLE means the secret came back.');
