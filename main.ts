// site-faster, the harness's program: the harness runs `node /bot/main.ts` (node22). It reads every case from
// /input/cases.json (a JSON array of {id, input}), answers each one alone with run() from solve.js, and writes
// /output/answers.json: a JSON array of the answers, one per case and in the cases' order. Outside a container
// MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and /output.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8's flags, set before solve.js is imported so all of its work runs under them (the rules: the house baseline runs
// with --no-incremental-marking, and an entry may tune V8's flags too).
//   --no-incremental-marking  the house baseline's own: a build allocates its pages and drops them, and marking in
//                             steps costs more here than it saves.
//   --maglev --no-turbofan    one set is one pass: Maglev's compiler pays for itself in it, TurboFan's does not, and
//                             the CPU it would spend optimising is CPU the answer never needs.
setFlagsFromString('--no-incremental-marking --maglev --no-turbofan');

/** solve.js, imported by its URL (a .js module carries no types) and typed by its contract. */
const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as { run: (input: unknown) => unknown };

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; input: unknown }[];

// The answers, one per case and in the cases' order, written as the JSON array of them: each answer is turned to text
// as soon as it is answered, and the case and the answer are let go of there, so the run never holds every case's
// output tree at once. The bytes are JSON.stringify(answers)' own, element for element and separator for separator.
let out = '[';
for (let i = 0; i < cases.length; i++) {
  if (i > 0) out += ',';
  const answer = JSON.stringify(run(cases[i].input));
  out += answer === undefined ? 'null' : answer;
  cases[i].input = null;
}
out += ']';
writeFileSync(join(OUTPUT_DIR, 'answers.json'), out);
