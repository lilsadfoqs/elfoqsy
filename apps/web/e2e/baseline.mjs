// The two screens as they look, in a fixed set of states, as PNGs: the baseline for "with no layout saved, both screens look
// exactly as today" (P1, criterion 6). Run on the commit before a change and on the change, then compare the two folders pixel
// by pixel (compare.py), or let the browser tests compare against the folder kept in e2e/baseline.
//
//   node e2e/baseline.mjs <dir>
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { captureStates } from './baseline-states.mjs';
import { createStack } from './harness.mjs';

const out = resolve(process.argv[2] ?? 'baseline');
mkdirSync(out, { recursive: true });
const stack = await createStack();
await captureStates(stack, out, (name) => console.log(name));
await stack.close();
if (stack.errors.length) console.log('page errors:', stack.errors.join('\n'));
