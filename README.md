# site-faster

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/yihow1337/site-faster/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/yihow1337/site-faster/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

<sub>Entered on [make.fun](https://make.fun/?ref=j5ka5y6n&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>

A faster drop-in for make.fun's own static site generator, **makefun-site 1.0.0**.

`run(input)` takes one site — `{ site, templates, files }`, 200 to 600 Markdown sources, a few static files and 14 to 30
templates — and returns the same output tree makefun-site's `build(input)` returns: every output path and that file's
text, byte for byte. Same front matter, same Markdown subset, same template dialect, same slug rule, same
`build-report.txt`. No dependencies, Node 22's standard library only.

## Layout

| file | what it is |
| --- | --- |
| `main.ts` | the program the harness runs: reads `/input/cases.json`, answers each case with `run`, writes `/output/answers.json` |
| `solve.js` | the generator itself, one dependency-free ES module exporting `run(input)` |
| `tests/differential.mjs` | every case answered both ways, this entry's against makefun-site's own `build(input)` |

## How it goes faster

The reference is a pipeline of plugins over a build, with a Markdown lexer that builds a line array and a token array,
an inline renderer that escapes one character at a time, and a template tree walked once per page. The answer has to
be identical, so the work has to be the same work — only less of it:

- **Templates are folded, not just parsed.** Each template is parsed once into nodes, then every node is asked what it
  reads. A run of nodes that reads only `site`, `tags` and `recent` — the values every page of a build shares — is
  rendered once per build and kept as text, so a shared header, nav and footer cost one render between all 500 pages.
  A run that reads one loop variable besides is memoised by that value, so a post's card is rendered once however many
  index and tag pages list it. Both caches are kept per include depth, because an include past the eighth renders
  nothing.
- **A source is read in one pass.** No line array, no token array: every line test reads the source over a range, and a
  paragraph whose lines are already trimmed is one slice of it rather than a join of trimmed copies. A fenced block's
  body is escaped in one call instead of one a line.
- **Scans are table driven and branch free where it pays.** One entry a code unit, so finding what opens something
  inline, or counting a body's words, is a load and a test a character instead of a chain of range branches that the
  CPU mispredicts on ordinary prose.
- **Nothing is resolved twice.** A source's link targets resolve once each, slugs and long dates are memoised, a page's
  word count is counted once rather than once a card, and Unicode normalisation is skipped for text that is all ASCII,
  where NFKD is the identity and no combining mark can appear.
- **Values live in shapes, not in objects built by spread.** One scope object shape, one node shape, a scope's names as
  small integers, and the values every template sees in a seven-slot array, so every lookup is monomorphic.
- **An answer becomes bytes once.** Writing one 7 MB string of every answer costs a second copy of all of it to flatten
  and a third to encode, so the driver never builds one: each file's path and text is turned to JSON on its own and
  encoded straight into the bytes of its answer, which go to the file as the answer is finished. Every file's text is
  dropped from the answer the moment it is in those bytes, so what a page was built out of dies with it and a case's
  collector carries a shrinking tree rather than the whole of it. The bytes are `JSON.stringify(answers)`' own, path
  for path and separator for separator.
- **The output tree is an ordinary object.** `{}`, which is also makefun-site's own: it keeps the shape V8's JSON
  writer has a fast path for, where a tree made a dictionary up front costs that path once a page, and it answers a
  path named `__proto__` the way makefun-site does.
- **V8 is told the truth about the run.** One set is one pass over 3 sites: `--maglev --no-turbofan` keeps the compiler
  that pays for itself in that pass and drops the one that does not, and `--no-incremental-marking` is the house
  baseline's own. Everything else was tried and measured against those three — eager tiering, a single-threaded heap,
  the young generation's other collector, a bigger semi-space — and none of it earns its place.

Measured here against the house baseline on the practice instance — 3 sites, 1,070 Markdown sources, 1,135 output
files, 7.4 MB of text — both timed the same way on the same machine, pinned to one CPU and run one after the other in
rotation so a busy minute falls on both alike, the trimmed mean of 13 runs each: **0.24 s of CPU against 0.68 s**,
about 2.8× less, or 3.0× less once a do-nothing program in the same runtime (0.018 s) is taken off both. The
`answers.json` it writes is the baseline's byte for byte.

Answers are identical on the practice instance, on 21 more instances drawn from the kit's own generator on other
seeds, on 75,000 randomly built sites, and on the 181 hand-written cases in
[`tests/differential.mjs`](tests/differential.mjs) — every reason a source is refused, every Markdown block and inline
form, the template dialect's parse errors, a cycle of includes, the include depth limit, a for that binds a name the
build shares, and the pages a missing template leaves out:

```sh
node tests/differential.mjs <kit directory>   # 184 identical, 0 not
```

## Checking it

```sh
mkdir -p /tmp/site-gen-out /tmp/site-gen-scores
MAKEFUN_INPUT_DIR=<kit>/practice/input MAKEFUN_OUTPUT_DIR=/tmp/site-gen-out node main.ts
MAKEFUN_OUTPUT_DIR=/tmp/site-gen-out MAKEFUN_REFERENCE_DIR=<kit>/practice/reference \
  MAKEFUN_SCORES_DIR=/tmp/site-gen-scores node <kit>/program/scorer/main.ts
cat /tmp/site-gen-scores/scores.json
```

`{"passed":1,"cases_passed":3,"cases_total":3}`.

## Licence

MIT, see [LICENSE](LICENSE).
