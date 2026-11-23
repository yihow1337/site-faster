// site-faster, the harness's program: the harness runs `node /bot/main.ts` (node22). It reads every case from
// /input/cases.json (a JSON array of {id, input}), answers each one alone with run() from solve.js, and writes
// /output/answers.json: a JSON array of the answers, one per case and in the cases' order. Outside a container
// MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and /output.

import { closeSync, openSync, readFileSync, writeFileSync } from 'node:fs';
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

/** The bytes of the answers so far, grown as an answer needs it. */
let out = Buffer.allocUnsafe(1 << 22);

// The answers, one per case and in the cases' order, written as the JSON array of them. An answer's own text is never
// built whole: every file's path and text is turned to JSON on its own and encoded straight into the bytes of the
// answer, so the 3 MB string of one answer and the second pass that would encode it never happen, and nothing of a
// page outlives the case that wrote it. The bytes are JSON.stringify(answers)' own: a path is quoted and escaped by
// JSON.stringify itself, a text likewise, the keys come in the order JSON.stringify would take them (Object.keys and
// JSON.stringify read the same own enumerable keys in the same order), and a value JSON.stringify would leave out is
// left out here too.
const fd = openSync(join(OUTPUT_DIR, 'answers.json'), 'w');
if (cases.length === 0) writeFileSync(fd, '[]');
for (let i = 0; i < cases.length; i++) {
  const answer = run(cases[i].input) as Record<string, unknown>;
  cases[i].input = null;
  let at = 0;
  out[at++] = i === 0 ? 0x5b : 0x2c; // "[" for the first answer, "," before each one after it
  out[at++] = 0x7b; // "{"
  let first = true;
  for (const path of Object.keys(answer)) {
    const text = JSON.stringify(answer[path]);
    if (text === undefined) continue;
    const key = JSON.stringify(path);
    // Three bytes a code unit is UTF-8's most for one, and key and text are already escaped, so this is their room.
    const need = (key.length + text.length) * 3 + 8;
    if (at + need > out.length) {
      const grown = Buffer.allocUnsafe(Math.max(out.length * 2, at + need));
      out.copy(grown, 0, 0, at);
      out = grown;
    }
    if (first) first = false;
    else out[at++] = 0x2c; // ","
    at += out.write(key, at, 'utf8');
    out[at++] = 0x3a; // ":"
    at += out.write(text, at, 'utf8');
    // The file's text is in the bytes now and nothing reads it again, so the answer lets go of it here: what a page
    // was built out of then dies with it, and the collector carries a shrinking tree through the rest of the case
    // rather than the whole of it.
    answer[path] = '';
  }
  out[at++] = 0x7d; // "}"
  if (i === cases.length - 1) out[at++] = 0x5d; // "]"
  writeFileSync(fd, out.subarray(0, at));
}
closeSync(fd);
