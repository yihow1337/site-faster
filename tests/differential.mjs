// A differential test: this entry's run(input) against makefun-site 1.0.0's own build(input), answer for answer.
//
//   node tests/differential.mjs <kit directory>
//
// The kit directory is an unpacked site-generator-speed-01 kit: the oracle is its
// baselines/makefun-site/vendor/makefun-site/index.js, and every case of its practice/ instance is checked against the
// reference the kit ships. The cases below it are this entry's own, written for the rules a drawn instance rarely
// reaches: every reason a source is refused, every Markdown block and inline form, the template dialect's parse
// errors, a cycle of includes and the include depth limit, the generator's own directories, shadowed static files,
// slug collisions at the root, and the pages a missing template leaves out.
//
// It exits 0 when every case is identical and 1 otherwise, naming the first difference and where it starts.

import { readFileSync } from 'node:fs';

const kit = process.argv[2] ?? process.env.MAKEFUN_KIT;
if (kit === undefined) {
  console.error('usage: node tests/differential.mjs <kit directory>');
  process.exit(2);
}

const { build } = await import(new URL('baselines/makefun-site/vendor/makefun-site/index.js', `file://${kit}/`).href);
const { run } = await import(new URL('../solve.js', import.meta.url).href);

/** A JSON value with every object's keys in code-unit order: two values are equal when these strings are. */
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v !== null && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}

let pass = 0;
let fail = 0;

/** Where two output trees first differ, as a line to read. */
function difference(want, got) {
  for (const k of [...new Set([...Object.keys(want), ...Object.keys(got)])].sort()) {
    const a = want[k];
    const b = got[k];
    if (a === b) continue;
    if (a === undefined) return `  wrote ${k}, which makefun-site does not`;
    if (b === undefined) return `  did not write ${k}`;
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return `  ${k} differs at ${i}\n    makefun-site: ${JSON.stringify(a.slice(Math.max(0, i - 40), i + 80))}\n    this entry:   ${JSON.stringify(b.slice(Math.max(0, i - 40), i + 80))}`;
  }
  return '  the trees differ but no file does';
}

/** One input answered both ways, as JSON reads the answers back. */
function check(name, input) {
  const mine = JSON.parse(JSON.stringify(input));
  let want;
  let got;
  try {
    want = build(JSON.parse(JSON.stringify(input)));
  } catch (err) {
    want = `threw ${err.message}`;
  }
  try {
    got = run(mine);
  } catch (err) {
    got = `threw ${err.stack}`;
  }
  if (canonical(got) === canonical(want)) {
    pass++;
    return;
  }
  fail++;
  console.log(`FAIL ${name}`);
  if (typeof want === 'string' || typeof got === 'string') console.log(`  makefun-site: ${String(want).slice(0, 300)}\n  this entry:   ${String(got).slice(0, 300)}`);
  else console.log(difference(want, got));
}

// ---------------------------------------------------------------- the kit's own instance

const cases = JSON.parse(readFileSync(`${kit}/practice/input/cases.json`, 'utf8'));
const expected = JSON.parse(readFileSync(`${kit}/practice/reference/expected.json`, 'utf8'));
for (let i = 0; i < cases.length; i++) {
  const got = run(JSON.parse(JSON.stringify(cases[i].input)));
  if (canonical(got) === canonical(expected.cases[i].output)) pass++;
  else {
    fail++;
    console.log(`FAIL practice/${cases[i].id}`);
    console.log(difference(expected.cases[i].output, got));
  }
}

// ---------------------------------------------------------------- this entry's own cases

// A template of every value a page, an index page and a tag page see.
const SEEN = {
  page: 'P[{{ page.title }}|{{ page.slug }}|{{ page.date }}|{{ page.date_long }}|{{ page.summary }}|{{ page.reading_minutes }}|{{ page.is_post }}|{{{ page.content }}}|{{{ page.excerpt }}}|{% for h in page.toc %}({{ h.level }},{{ h.id }},{{{ h.html }}}){% endfor %}|{% for t in page.tags %}<{{ t.name }},{{ t.slug }},{{ t.url }}>{% endfor %}|{% if page.newer %}{{ page.newer.title }}{% endif %}|{% if page.older %}{{ page.older.url }}{% endif %}]',
  post: 'O[{{ page.title }}|{{ page.date_long }}|{{{ page.content }}}|{{ page.newer.title }}/{{ page.older.title }}|{% for t in page.tags %}{{ t.slug }},{% endfor %}]',
  index: 'I[{{ pager.number }}/{{ pager.total }}|{{ pager.url }}|{{ pager.newer_url }}|{{ pager.older_url }}|{% for p in posts %}{{ loop.index }}:{{ p.title }}:{{ p.url }}:{{ p.reading_minutes }};{% endfor %}|R{% for p in recent %}{{ p.title }};{% endfor %}|T{% for t in tags %}{{ t.name }}={{ t.count }}@{{ t.url }};{% endfor %}|{{ site.title }}@{{ site.base_url }}]',
  tag: 'G[{{ tag.name }}|{{ tag.slug }}|{{ tag.url }}|{{ tag.count }}|{% for p in tag.posts %}{{ p.title }};{% endfor %}]',
  tags: 'S[{% for t in tags %}{{ t.slug }}={{ t.count }};{% endfor %}]',
};
const SITE = { title: 'Site & Co', base_url: 'https://x.example/b//', per_page: 2, recent: 3 };
const site = (over) => ({ site: { ...SITE, ...(over.site ?? {}) }, templates: { ...SEEN, ...(over.templates ?? {}) }, files: over.files ?? [] });
const DEFAULT_BODY = 'Body *one* two & three.\n\n## A Head\n\n- item one\n- item two\n\npara [two](x.md)\n';
const src = (path, fm, body) => ({ path, content: `---\n${fm}\n---\n${body ?? DEFAULT_BODY}` });
const body = (text) => site({ files: [{ path: 'p.md', content: `---\ntitle: T\n---\n${text}` }] });

// Front matter: every reason a source is refused, and every value form that reads.
for (const [name, fm] of [
  ['plain', 'title: Hello World'],
  ['quoted', 'title: "A \\"q\\" and \\\\ back"'],
  ['quoted-unclosed', 'title: "nope'],
  ['quoted-stray', 'title: "a"b"'],
  ['quoted-bad-escape', 'title: "a\\nb"'],
  ['quoted-escape-at-end', 'title: "ab\\"'],
  ['bare-bracket', 'title: [a]'],
  ['no-title', 'summary: x'],
  ['given-twice', 'title: a\ntitle: b'],
  ['unknown-key', 'title: a\nauthor: me'],
  ['upper-key', 'title: a\nTitle: b'],
  ['no-value', 'title: a\nsummary:'],
  ['no-value-spaces', 'title: a\nsummary:   '],
  ['no-space', 'title: a\nsummary:x'],
  ['comments', '# c\ntitle: a\n#another'],
  ['blank-lines', 'title: a\n   \n\t\nsummary: s'],
  ['indented-comment', 'title: a\n  # c'],
  ['date', 'title: a\ndate: 2024-02-29'],
  ['date-not-a-leap-year', 'title: a\ndate: 2023-02-29'],
  ['date-out-of-range', 'title: a\ndate: 2100-01-01'],
  ['date-short', 'title: a\ndate: 24-01-01'],
  ['date-month', 'title: a\ndate: 2024-13-01'],
  ['date-day-zero', 'title: a\ndate: 2024-01-00'],
  ['tags', 'title: a\ntags: [x, y , z]'],
  ['tags-none', 'title: a\ntags: []'],
  ['tags-blank', 'title: a\ntags: [   ]'],
  ['tags-empty-one', 'title: a\ntags: [a, ]'],
  ['tags-quote', 'title: a\ntags: [a, "b"]'],
  ['tags-not-a-list', 'title: a\ntags: a, b'],
  ['tags-one-bracket', 'title: a\ntags: ['],
  ['draft', 'title: a\ndraft: true'],
  ['draft-false', 'title: a\ndraft: false'],
  ['draft-yes', 'title: a\ndraft: yes'],
  ['layout', 'title: a\nlayout: page'],
  ['layout-missing', 'title: a\nlayout: nope'],
  ['layout-upper', 'title: a\nlayout: Page'],
  ['slug', 'title: a\nslug: my-slug-2'],
  ['slug-spaces', 'title: a\nslug: My Slug'],
  ['slug-two-dashes', 'title: a\nslug: a--b'],
  ['slug-trailing-dash', 'title: a\nslug: ab-'],
  ['slug-65', `title: a\nslug: ${'a'.repeat(65)}`],
  ['slug-64', `title: a\nslug: ${'a'.repeat(64)}`],
  ['summary', 'title: a\nsummary: S & "x"'],
]) check(`front matter/${name}`, site({ files: [src('p.md', fm)] }));
for (const [name, content] of [
  ['none', 'no front matter\n'],
  ['not-closed', '---\ntitle: a\nbody\n'],
  ['not-closed-over-a-bad-line', '---\nbadline\n'],
  ['dashes-only', '---'],
  ['empty', ''],
  ['closed-at-once', '---\n---\n'],
  ['no-body', '---\ntitle: a\n---'],
  ['crlf', '---\r\ntitle: a\r\n---\r\nbody\r\nmore\r\n'],
  ['cr', '---\rtitle: a\r---\rbody\r'],
  ['dashes-with-a-space', '---\ntitle: a\n--- \n---\nbody\n'],
]) check(`front matter/file ${name}`, site({ files: [{ path: 'p.md', content }] }));

// Markdown: every block and every inline form.
for (const [name, text] of [
  ['fence', '```js\nvar a = 1 < 2 && "x";\n```'],
  ['fence-no-language', '```\nplain & <b>\n```'],
  ['fence-not-closed', '```js\nbody\nmore'],
  ['fence-empty', '```js\n```'],
  ['fence-blank-body', '```\n\n\n```'],
  ['fence-four-backticks', '````js\nx\n```'],
  ['fence-close-spaced', '```\nx\n```   '],
  ['fence-language-plus', '```c++\nx\n```'],
  ['fence-language-spaced', '```js \nx\n```'],
  ['fence-language-bad', '```js!\nx\n```'],
  ['fence-inner-fence', '```\n```\n```'],
  ['headings', '# a\n## b\n### c\n#### d\n##### e\n###### f'],
  ['heading-seven', '####### g'],
  ['heading-no-text', '#\n##   \n#\t'],
  ['heading-closing-hashes', '## abc ##'],
  ['heading-tab', '#\tabc'],
  ['heading-ids-collide', '## Dup\n## Dup\n## dup!\n## Dup'],
  ['heading-not-ascii', '## Café Zürich ﬁnal Ｗｉｄｅ'],
  ['heading-untitled', '## !!!\n## ???'],
  ['heading-inline', '## a *b* `c` [d](e) **f**'],
  ['break-dashes', '---'],
  ['break-stars', '***'],
  ['break-four', '----'],
  ['break-spaced', '---   '],
  ['break-mixed', '-*-'],
  ['quote', '> a\n> b'],
  ['quote-no-space', '>a\n>b'],
  ['quote-bare', '>'],
  ['quote-empty-lines', '> \n>\n> x'],
  ['quote-nested', '> > x'],
  ['quote-then-text', '> a\nb'],
  ['list-bullet', '- a\n- b'],
  ['list-star', '* a\n* b'],
  ['list-mixed-bullets', '- a\n* b'],
  ['list-empty-item', '- \n- a'],
  ['list-no-space', '-a\n-b'],
  ['list-continued', '- a\n  b\n- c'],
  ['list-continued-tab', '- a\n\tb'],
  ['list-ordered', '1. a\n2. b'],
  ['list-ordered-start', '5. a\n6. b'],
  ['list-ordered-zero', '0. a'],
  ['list-ordered-ten-digits', '1234567890. a'],
  ['list-ordered-nine-digits', '123456789. a'],
  ['list-ordered-no-space', '1.a'],
  ['list-ordered-then-bullet', '1. a\n- b'],
  ['list-then-paragraph', '- a\nb'],
  ['paragraph-trailing-spaces', 'a  \nb\t'],
  ['paragraph-indented', '   a\n   b'],
  ['paragraph-then-break', 'text\n---'],
  ['paragraph-then-underline', 'text\n==='],
  ['paragraph-html', '<div class="x">\nhi\n</div>'],
  ['paragraph-hash', '#notheading x'],
  ['paragraph-then-fence', 'text\n```\nx\n```'],
  ['paragraph-then-quote', 'text\n> q'],
  ['paragraph-no-newline', 'abc'],
  ['blank-only', '   \n\t\n'],
  ['empty', ''],
  ['escapes', 'a \\* \\_ \\> \\\\ \\` \\[ \\] \\( \\) \\# \\+ \\- \\. \\! \\a \\'],
  ['code-spans', '`a < b` `` `x` `a`b`'],
  ['code-span-not-closed', '`abc'],
  ['strong', '**a** **a*b** ** ** **'],
  ['emphasis', '*a* *a**b* * *'],
  ['strong-and-emphasis', '***a***'],
  ['stars-escaped', '\\*a\\* **a\\**b**'],
  ['underscores', '_a_ a_b_c'],
  ['escape-table', 'a & b "c" \'d\' <e> >f<'],
  ['links', '[t](u) [t](u v) [t]() [t] [t](u [a](b)'],
  ['link-nested', '[a [b](c)](d)'],
  ['link-escaped-bracket', '[a\\]b](c)'],
  ['link-targets', '[a](#f) [b](/abs) [c](https://h/x?a=1&b=2) [d](mailto:a@b.c)'],
  ['link-no-text', '[](u)'],
  ['link-inline-text', '[*a* `b`](u)'],
  ['excerpt-after-a-heading', '# h\nfirst para\n\nsecond'],
  ['excerpt-after-a-quote', '> q\n\npara'],
]) check(`markdown/${name}`, body(text));

// The template dialect: what does not parse, and what every form renders.
for (const [name, text] of [
  ['var-not-closed', '{{ x '],
  ['raw-not-closed', '{{{ x }}'],
  ['tag-not-closed', '{% if x '],
  ['path-leading-digit', '{{ 1bad }}'],
  ['path-trailing-dot', '{{ a. }}'],
  ['path-empty', '{{ }}'],
  ['raw-path-empty', '{{{ }}}'],
  ['tag-unknown', '{% foo %}'],
  ['else-outside-an-if', '{% else %}'],
  ['endfor-with-no-for', '{% endfor %}'],
  ['endif-with-no-if', '{% endif %}'],
  ['for-not-closed', '{% for x in y %}'],
  ['if-not-closed', '{% if x %}'],
  ['for-bad-path', '{% for x in 1y %}{% endfor %}'],
  ['if-bad-path', '{% if 1y %}{% endif %}'],
  ['closed-out-of-order', '{% for x in y %}{% endif %}{% endfor %}'],
  ['two-elses', '{% if x %}{% else %}{% else %}{% endif %}'],
  ['include-upper', '{% include "Bad" %}'],
  ['include-unquoted', '{% include bad %}'],
  ['nested-closed-out-of-order', '{% for a in b %}{% if c %}{% endfor %}{% endif %}'],
]) check(`template/${name}`, site({ templates: { [name]: text }, files: [src('p.md', 'title: A'), src('posts/q.md', 'title: Q\ndate: 2024-01-02\ntags: [One, two]')] }));

const files = [
  src('a.md', 'title: A\ntags: [one, Two]'),
  src('docs/b.md', 'title: B'),
  src('posts/p1.md', 'title: P1\ndate: 2024-01-01\ntags: [one, two, three]'),
  src('posts/p2.md', 'title: P2\ndate: 2024-01-02\ntags: [one]'),
  src('posts/p3.md', 'title: P3\ndate: 2024-01-03\nsummary: S3'),
  src('posts/p4.md', 'title: P4\ndate: 2024-01-04\ntags: [two, three]'),
  { path: 'r.txt', content: 'static' },
];
const parts = {
  standalone: 'A\n{% if page %}\nB\n{% endif %}\nC\n',
  'standalone-indented': 'A\n  {% if page %}  \nB\n\t{% endif %}\t\nC\n',
  'standalone-at-the-end': 'A\n{% if page %}B{% endif %}',
  'not-standalone': 'x {% if page %}\nB\n{% endif %}\n',
  'var-on-a-line': 'A\n{{ page.title }}\nB\n',
  'no-spaces': '{{page.title}}{{{page.content}}}',
  'extra-spaces': '{{   page.title   }}',
  'lone-braces': '{ x } {{ page.title }} {',
  'brace-at-the-end': 'tail {',
  'braces-at-the-end': 'tail {{',
  'percent-close': 'a %} b',
  'loop-values': '{% for t in tags %}{{ loop.index }}/{{ loop.length }}/{{ loop.first }}/{{ loop.last }}:{{ t.name }};{% endfor %}',
  'loop-bound-as-loop': '{% for loop in tags %}{{ loop.name }}/{{ loop.index }}{% endfor %}',
  'loops-nested': '{% for t in tags %}{% for p in t.posts %}{{ t.slug }}:{{ p.title }};{% endfor %}{% endfor %}',
  'loop-shadowing': '{% for p in recent %}{% for p in p.tags %}{{ p.slug }},{% endfor %}{% endfor %}',
  'for-over-a-string': '{% for x in page.title %}never{% endfor %}',
  'for-over-nothing': '{% for x in nope %}never{% endfor %}',
  'if-not': '{% if not page %}no{% else %}yes{% endif %}',
  'if-undefined': '{% if nope %}y{% else %}n{% endif %}',
  'if-a-number': '{% if page.reading_minutes %}rm{% endif %}',
  'if-an-empty-array': '{% if page.tags %}tags{% else %}none{% endif %}',
  'if-an-empty-string': '{% if page.summary %}s{% else %}no-s{% endif %}',
  'an-array-as-text': 'TAGS={{ tags }} ONE={{ page.tags }}',
  'length-of': 'n={{ tags.length }} m={{ page.toc.length }}',
  'undefined-deep': '{{ page.newer.title }}|{{ a.b.c.d }}|{{ site.nope }}',
  'escaped-and-raw': 'esc={{ page.title }} raw={{{ page.title }}}',
  'include-missing': 'a{% include "nope" %}b',
  'include-itself': 'x{% include "include-itself" %}',
  'include-a-cycle': 'A{% include "the-other-side" %}B',
  'the-other-side': 'C{% include "include-a-cycle" %}D',
  d1: '1{% include "d2" %}',
  d2: '2{% include "d3" %}',
  d3: '3{% include "d4" %}',
  d4: '4{% include "d5" %}',
  d5: '5{% include "d6" %}',
  d6: '6{% include "d7" %}',
  d7: '7{% include "d8" %}',
  d8: '8{% include "d9" %}',
  d9: '9{% include "d10" %}',
  d10: 'X',
  'include-nine-deep': 'start{% include "d1" %}end',
  'include-in-a-loop': '{% for t in tags %}{% include "a-tag" %}{% endfor %}',
  'a-tag': '[{{ t.name }}:{{ t.count }}]',
  'a-loop-variable-at-the-top': 'p={{ p.title }} t={{ t.name }}',
  'only-what-a-build-shares': '[{{ site.title }}{% for t in tags %}{{ t.slug }}{% endfor %}{% for p in recent %}{{ p.title }}{% endfor %}]',
};
check('template/every form', site({
  templates: {
    ...parts,
    page: Object.keys(parts).map((k) => `--${k}:{% include "${k}" %}`).join('\n'),
    post: '{% include "loop-values" %}{% include "include-nine-deep" %}{% include "include-in-a-loop" %}{% include "only-what-a-build-shares" %}',
    index: 'I{% include "loops-nested" %}{% include "only-what-a-build-shares" %}',
    tag: 'T{% include "a-tag" %}{% include "only-what-a-build-shares" %}',
    tags: 'S{% include "an-array-as-text" %}',
  },
  files,
}));

// A partial reached at one depth and at another, so a folded subtree may not be shared between them.
const chain = {};
for (let i = 1; i <= 12; i++) chain[`c${i}`] = `(${i}:{{ site.title }}${i < 12 ? `{% include "c${i + 1}" %}` : ''})`;
check('template/depth of a shared subtree', site({
  templates: {
    ...chain,
    page: `P{% include "c1" %}|{% include "w1" %}|{% include "w2" %}`,
    w1: 'W1{% include "c1" %}',
    w2: 'W2{% include "w3" %}',
    w3: 'W3{% include "w4" %}',
    w4: 'W4{% include "c1" %}',
    post: 'O{% include "c3" %}{% include "w2" %}',
    index: 'I{% include "c1" %}{% include "w1" %}',
    tag: 'T{% include "c2" %}',
    tags: 'S{% include "c1" %}',
  },
  files,
}));
const pageChain = {};
for (let i = 1; i <= 12; i++) pageChain[`d${i}`] = `(${i}:{{ page.title }}${i < 12 ? `{% include "d${i + 1}" %}` : ''})`;
check('template/depth of a page subtree', site({
  templates: {
    ...pageChain,
    page: 'P{% include "d1" %}|{% include "x1" %}',
    x1: 'X1{% include "x2" %}',
    x2: 'X2{% include "x3" %}',
    x3: 'X3{% include "d1" %}',
    post: 'O{% include "d1" %}',
    index: 'I{% for p in posts %}{% include "card" %}{% endfor %}',
    card: 'C{{ p.title }}{% include "d1" %}',
    tag: 'T{% for p in tag.posts %}{% include "card" %}{% endfor %}',
    tags: 'S',
  },
  files,
}));
// A partial memoised by one loop variable, rendered from scopes that bind it to different things, and from none.
check('template/one partial, many scopes', site({
  templates: {
    page: 'PG{% include "both" %}|{% include "only-p" %}|{% for p in recent %}{% include "only-p" %}{% endfor %}',
    both: '[both {{ page.title }}/{{ p.title }}]',
    'only-p': '[p={{ p.title }}:{{ p.url }}]',
    post: 'PO{% include "only-p" %}{% for p in recent %}{% include "both" %}{% include "only-p" %}{% endfor %}',
    index: 'IX{% for p in posts %}{% include "only-p" %}{% include "its-tags" %}{% endfor %}|{% for p in recent %}{% include "only-p" %}{% endfor %}',
    'its-tags': '{% for p in p.tags %}<{{ p.name }}/{{ p.slug }}>{% endfor %}',
    tag: 'TG{% for p in tag.posts %}{% include "only-p" %}{% include "its-tags" %}{% endfor %}',
    tags: 'TS{% for t in tags %}{% include "only-t" %}{% endfor %}{% include "only-t" %}',
    'only-t': '[t={{ t.name }}={{ t.count }}]',
  },
  files,
}));

// A partial whose nodes read one name that a for binds in one template and a page's own values hold in another,
// rendered where it is bound, where it is the page's, and where it is nothing at all (an index, a tag and the tags
// page see no page). It includes itself, so it is also rendered at every depth up to the limit.
check('template/a bound name that is also a page value', site({
  templates: {
    page: '{% for page in recent %}{{ page.title }}{% endfor %}|{% include "deep" %}',
    post: '{% include "deep" %}|{% for page in recent %}[{{ page.url }}]{% endfor %}',
    index: `I{% include "deep" %}|{% for posts in tags %}{{ posts.slug }}{% endfor %}`,
    tag: 'G{% include "deep" %}|{% for tag in recent %}{{ tag.title }}{% endfor %}',
    tags: 'S{% include "deep" %}',
    deep: '{% if page.summary %}s{% else %}n{% endif %}{{ page.reading_minutes }}{% for t in page.tags %}{{ t.slug }}{% endfor %}{% for x in page.toc %}{% for y in tags %}{{ x.id }}{{ y.slug }}{% endfor %}{% endfor %}{% include "deep" %}',
  },
  files,
}));

// A partial that holds a run of nodes every page shares and then a run that reads one name, rendered where the name
// is a page's own and where it is nothing: what the second run is keyed by must be the name the run reads, whatever
// folding the first run of it went on to read.
check('template/a shared run before a keyed one', site({
  templates: {
    page: '{% include "mixed" %}',
    post: '{% include "mixed" %}',
    index: 'I{% include "mixed" %}',
    tag: 'G{% include "mixed" %}',
    tags: 'S{% include "mixed" %}',
    mixed: '{% for page in recent %}{{ page.title }}/{{ page.url }}{% endfor %}{% for t in tags %}{% if t.count %}{{ t.slug }}{% else %}-{% endif %}{% endfor %}{% if page %}\n{% for p in recent %}\n{{ p.title }}\n{% endfor %}\n{% endif %}\n',
  },
  files,
}));

// A for that binds one of the names every page of a build shares: inside it, a partial reading that name reads the
// element, so nothing of it can be rendered once and shared.
check('template/a for that binds what a build shares', site({
  templates: {
    page: '{% for tags in recent %}{% include "tag-bits" %}|{% endfor %}{% include "tag-bits" %}',
    'tag-bits': '[{% for t in tags %}{{ t.slug }},{% endfor %}]',
    post: '{% for recent in tags %}{% include "recent-bits" %}{% endfor %}{% include "recent-bits" %}',
    'recent-bits': '({% for p in recent %}{{ p.title }};{% endfor %})',
    index: '{% for site in tags %}{{ site.title }}/{{ site.slug }}{% endfor %}{{ site.title }}',
    tag: '{% include "tag-bits" %}{% include "recent-bits" %}',
    tags: '{% include "tag-bits" %}{% include "recent-bits" %}',
  },
  files,
}));

// The build: what is written, what is left out, and what the report names.
const MIN = { page: 'PAGE {{ page.title }} {{ page.url }}', post: 'POST {{ page.title }}', index: 'IDX {{ pager.number }}/{{ pager.total }} {{ pager.newer_url }} {{ pager.older_url }}', tag: 'TAG {{ tag.slug }} {{ tag.count }}', tags: 'TAGS {% for t in tags %}{{ t.slug }},{% endfor %}' };
const basic = [src('a.md', 'title: A'), src('posts/x.md', 'title: X\ndate: 2024-01-02\ntags: [One, two]'), src('posts/y.md', 'title: Y\ndate: 2024-01-03\ntags: [One]')];
check('build/no templates', site({ templates: {}, files: basic }));
check('build/no index template', site({ templates: { page: 'p', post: 'o', tag: 't', tags: 's' }, files: basic }));
check('build/no tag template', site({ templates: { page: 'p', post: 'o', index: 'i', tags: 's' }, files: basic }));
check('build/no tags template', site({ templates: { page: 'p', post: 'o', index: 'i', tag: 't' }, files: basic }));
check('build/no posts', site({ templates: MIN, files: [src('a.md', 'title: A'), src('b.md', 'title: B')] }));
check('build/no files', site({ templates: MIN }));
check('build/the generator\'s own directories', site({ templates: MIN, files: [src('tags/a.md', 'title: A'), src('page/b.md', 'title: B'), src('posts/c.md', 'title: C\ndate: 2024-01-01'), src('pages/d.md', 'title: D'), src('tagsx/e.md', 'title: E')] }));
check('build/a post with no date', site({ templates: MIN, files: [src('posts/a.md', 'title: A'), src('posts/b.md', 'title: B\ndate: 2024-01-01')] }));
check('build/slugs the generator reserves', site({ templates: MIN, files: [src('a.md', 'title: Posts'), src('b.md', 'title: Tags'), src('c.md', 'title: Page'), src('d.md', 'title: posts')] }));
check('build/slug collisions', site({ templates: MIN, files: [src('a.md', 'title: Same Title'), src('b.md', 'title: SAME TITLE'), src('c.md', 'title: same-title'), src('d.md', 'slug: same-title\ntitle: Other'), src('e.md', 'slug: same-title-2\ntitle: Other2')] }));
check('build/slugs by directory', site({ templates: MIN, files: [src('x.md', 'title: Dup'), src('docs/x.md', 'title: Dup'), src('docs/y.md', 'title: Dup'), src('posts/p.md', 'title: Dup\ndate: 2024-01-01'), src('posts/2024/q.md', 'title: Dup\ndate: 2024-01-01')] }));
check('build/slugs outside ASCII', site({ templates: MIN, files: [src('a.md', 'title: Café Zürich'), src('b.md', 'title: 東京 Москва'), src('c.md', 'title: ﬁnal Ｗｉｄｅ œuvre Straße'), src('d.md', 'title: "!!! ???"'), src('e.md', `title: ${'Long Title Words '.repeat(6)}`), src('f.md', `title: ${'ab '.repeat(40)}`)] }));
check('build/dates and their order', site({ templates: MIN, files: [src('posts/a.md', 'title: A\ndate: 2024-01-01'), src('posts/b.md', 'title: B\ndate: 2024-01-01'), src('posts/c.md', 'title: C\ndate: 2023-12-31'), src('posts/d.md', 'title: D\ndate: 2099-12-31'), src('posts/e.md', 'title: E\ndate: 1970-01-01')] }));
check('build/tags and their order', site({ templates: MIN, files: [src('posts/a.md', 'title: A\ndate: 2024-01-01\ntags: [b, a, c]'), src('posts/b.md', 'title: B\ndate: 2024-01-02\ntags: [c, c, C]'), src('posts/c.md', 'title: C\ndate: 2024-01-03\ntags: [A, a]'), src('x.md', 'title: X\ntags: [a, zz]')] }));
check('build/static files', site({ templates: MIN, files: [src('a.md', 'title: A'), { path: 'robots.txt', content: 'hi' }, { path: 'assets/x.css', content: 'body{}' }, { path: 'a/index.html', content: 'SHADOW' }, { path: 'build-report.txt', content: 'SHADOW2' }, { path: 'index.html', content: 'SHADOW3' }] }));
check('build/what is not a source', site({ templates: MIN, files: [{ path: 'x.MD', content: '---\ntitle: A\n---\nb' }, { path: 'y.md', content: '---\ntitle: B\n---\nb' }, { path: 'z.markdown', content: 'x' }, { path: '.md', content: '---\ntitle: C\n---\nb' }] }));
check('build/base url trailing slashes', site({ templates: MIN, files: basic, site: { base_url: 'https://x.example/b///' } }));
check('build/base url empty', site({ templates: MIN, files: basic, site: { base_url: '' } }));
check('build/base url one slash', site({ templates: MIN, files: basic, site: { base_url: '/' } }));
check('build/one post a page', site({ templates: MIN, files: [src('posts/a.md', 'title: A\ndate: 2024-01-01'), src('posts/b.md', 'title: B\ndate: 2024-01-02'), src('posts/c.md', 'title: C\ndate: 2024-01-03')], site: { per_page: 1 } }));
check('build/every post on one page', site({ templates: MIN, files: basic, site: { per_page: 100 } }));
check('build/no recent posts', site({ templates: MIN, files: basic, site: { recent: 0 } }));
check('build/more recent than there are', site({ templates: MIN, files: basic, site: { recent: 100 } }));
check('build/the order files arrive in', site({ templates: MIN, files: [src('z.md', 'title: Z'), src('a.md', 'title: A'), src('posts/b.md', 'title: B\ndate: 2024-01-01'), { path: 'A.md', content: '---\ntitle: Upper\n---\nx' }, src('docs/c.md', 'title: C')] }));
check('build/one path twice', site({ templates: MIN, files: [src('a.md', 'title: First'), src('a.md', 'title: Second'), { path: 's.txt', content: '1' }, { path: 's.txt', content: '2' }] }));
check('build/drafts', site({ templates: MIN, files: [src('a.md', 'title: A\ndraft: true'), src('b.md', 'title: B\ndraft: false'), src('posts/c.md', 'title: C\ndate: 2024-01-01\ndraft: true\ntags: [t]')] }));
check('build/links', site({
  templates: { ...MIN, page: 'PAGE {{{ page.content }}}', post: 'POST {{{ page.content }}}' },
  files: [
    src('a.md', 'title: A', '[x](b.md) [y](docs/c.md) [z](../up.md) [w](./b.md) [s](s.txt) [n](nope.md) [f](b.md#frag) [e](#frag) [abs](/x) [sch](https://h/x) [dot](.) [empty](#) [sl](docs/) [par](docs/../b.md)'),
    src('b.md', 'title: B', 'b'),
    src('docs/c.md', 'title: C', '[up](../a.md) [sib](c.md) [deep](../../x.md) [st](../s.txt) [d](../a.md#f)'),
    src('posts/p.md', 'title: P\ndate: 2024-01-01', '[a](../a.md) [self](p.md) [draft](../d.md)'),
    src('d.md', 'title: D\ndraft: true', 'd'),
    { path: 's.txt', content: 'static' },
  ],
}));

console.log(`${pass} identical, ${fail} not`);
process.exit(fail === 0 ? 0 : 1);
