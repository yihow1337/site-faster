// site-faster: a faster drop-in for make.fun's own makefun-site 1.0.0.
//
// run(input) returns, byte for byte, the output tree that makefun-site 1.0.0's build(input) returns: a JSON object of
// every output path and that file's text. Every rule here is makefun-site's own (its README, and its code wherever the
// two differ): the front matter, the Markdown subset, the template dialect, the slug rule and the build report.
//
// Where the work is shaped differently from the reference:
//   * a source is read in one pass: no line array of tokens, no token array of blocks; each block renders as it is
//     read, and the inline pass appends runs of plain text with one slice instead of escaping character by character;
//   * every template is parsed once and then folded: a subtree that reads only site, tags and recent (the values every
//     page of a build shares) renders once per build, and a subtree that reads one loop variable alone is memoised per
//     value, so a post's card renders once however many index and tag pages list it;
//   * link targets resolve once per source, slugs and long dates are memoised, and Unicode normalisation is skipped
//     for text that is all ASCII (where NFKD is the identity and no mark can appear).
//
// It reads no clock, no environment and no file, and holds no state between calls: one input, one answer.

// ---------------------------------------------------------------- text

// The HTML escape table, in makefun-site's order: & < > " '. The tables that drive every scan here are one entry a
// code unit, so a scan is one load and one test a character: a branch on ranges costs more than the table does, and a
// mispredicted one far more.
const ESC_CODE = new Uint8Array(65536);
ESC_CODE[38] = 1;
ESC_CODE[60] = 2;
ESC_CODE[62] = 3;
ESC_CODE[34] = 4;
ESC_CODE[39] = 5;
const ESC_TEXT = ['', '&amp;', '&lt;', '&gt;', '&quot;', '&#39;'];
const ESC_FIND = /[&<>"']/;

/** The length a text is worth escaping in whole passes over it for, rather than character by character. */
const ESC_BULK = 64;

/**
 * `text` with & < > " and ' escaped, and nothing else. A long text is escaped one character at a time only for the
 * first pass that finds nothing to do: the rest is five tests and a pass a character that is there, every one of them
 * a built-in's own loop. The two orders agree because & is replaced first, and nothing an entity holds is replaced
 * after it. The first pass is the regexp engine's, not a loop over the table: a call into it was measured against a
 * scan of even the shortest text esc is given, and it wins.
 */
function esc(s) {
  const at = s.search(ESC_FIND);
  if (at < 0) return s;
  const n = s.length;
  if (n >= ESC_BULK) {
    let out = s;
    if (out.includes('&')) out = out.replaceAll('&', '&amp;');
    if (out.includes('<')) out = out.replaceAll('<', '&lt;');
    if (out.includes('>')) out = out.replaceAll('>', '&gt;');
    if (out.includes('"')) out = out.replaceAll('"', '&quot;');
    if (out.includes("'")) out = out.replaceAll("'", '&#39;');
    return out;
  }
  let out = s.slice(0, at) + ESC_TEXT[ESC_CODE[s.charCodeAt(at)]];
  let last = at + 1;
  for (let i = last; i < n; i++) {
    const k = ESC_CODE[s.charCodeAt(i)];
    if (k === 0) continue;
    if (i > last) out += s.slice(last, i);
    out += ESC_TEXT[k];
    last = i + 1;
  }
  return last < n ? out + s.slice(last) : out;
}

const NON_ASCII = /[^\0-\x7f]/;
const MARKS = /\p{M}/gu;
const SLUG_CACHE = new Map();

// a-z, A-Z and 0-9: every other code unit is a gap a slug writes one "-" for.
const ALNUM = new Uint8Array(65536);
for (let c = 48; c <= 57; c++) ALNUM[c] = 1;
for (let c = 65; c <= 90; c++) ALNUM[c] = 1;
for (let c = 97; c <= 122; c++) ALNUM[c] = 1;

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of characters other than a-z and 0-9 one
 * "-", none at either end, at most 64 characters (a "-" left at the cut dropped), "untitled" when nothing is left.
 */
function slugify(text) {
  const hit = SLUG_CACHE.get(text);
  if (hit !== undefined) return hit;
  const plain = NON_ASCII.test(text) ? text.normalize('NFKD').replace(MARKS, '') : text;
  // The runs of a-z, A-Z and 0-9, joined by one "-": a run is one slice, and lowering the joined runs at the end is
  // the same mapping as lowering A-Z a character at a time, since nothing else is left in it.
  const n = plain.length;
  let out = '';
  let i = 0;
  while (i < n) {
    while (i < n && ALNUM[plain.charCodeAt(i)] === 0) i++;
    if (i >= n) break;
    let j = i + 1;
    while (j < n && ALNUM[plain.charCodeAt(j)] === 1) j++;
    const run = plain.slice(i, j);
    out = out === '' ? run : `${out}-${run}`;
    i = j;
  }
  out = out.toLowerCase();
  if (out.length > 64) {
    out = out.slice(0, 64);
    let e = out.length;
    while (e > 0 && out.charCodeAt(e - 1) === 45) e--;
    if (e !== out.length) out = out.slice(0, e);
  }
  if (out === '') out = 'untitled';
  SLUG_CACHE.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  if (!taken.has(slug)) {
    taken.add(slug);
    return slug;
  }
  let out;
  for (let n = 2; ; n++) {
    out = `${slug}-${n}`;
    if (!taken.has(out)) break;
  }
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DATE_CACHE = new Map();

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
function longDate(date) {
  const hit = DATE_CACHE.get(date);
  if (hit !== undefined) return hit;
  const parts = date.split('-');
  const out = `${Number(parts[2])} ${MONTHS[Number(parts[1]) - 1]} ${parts[0]}`;
  DATE_CACHE.set(date, out);
  return out;
}

// Every code unit that is not one of JavaScript's \s characters, one entry each.
const WORDY = new Uint8Array(65536).fill(1);
for (const c of [9, 10, 11, 12, 13, 32, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]) WORDY[c] = 0;
for (let c = 0x2000; c <= 0x200a; c++) WORDY[c] = 0;

/** The words of a body: its runs of characters other than whitespace, counted without a branch a character. */
function wordsOf(text) {
  let words = 0;
  let prev = 0;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const wordy = WORDY[text.charCodeAt(i)];
    words += wordy & (1 - prev);
    prev = wordy;
  }
  return words;
}

// ---------------------------------------------------------------- front matter

// What a source's front matter read: fmErr is null when it read, else the reason the source is refused.
let fmErr = null;
let fmTitle;
let fmDate;
let fmTags;
let fmDraft;
let fmLayout;
let fmSlug;
let fmSummary;
let fmBody;

const KEY_TITLE = 1;
const KEY_DATE = 2;
const KEY_TAGS = 4;
const KEY_DRAFT = 8;
const KEY_LAYOUT = 16;
const KEY_SLUG = 32;
const KEY_SUMMARY = 64;

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function stringOf(raw, key) {
  const n = raw.length;
  if (raw.charCodeAt(0) === 34) {
    if (n < 2 || raw.charCodeAt(n - 1) !== 34) {
      fmErr = `key "${key}": a quoted string is not closed`;
      return null;
    }
    let out = '';
    let last = 1;
    for (let i = 1; i < n - 1; i++) {
      const c = raw.charCodeAt(i);
      if (c === 92) {
        const next = raw.charCodeAt(i + 1);
        if ((next !== 34 && next !== 92) || i + 1 === n - 1) {
          fmErr = `key "${key}": a quoted string holds an escape other than \\" or \\\\`;
          return null;
        }
        out += raw.slice(last, i) + raw[i + 1];
        last = i + 2;
        i++;
      } else if (c === 34) {
        fmErr = `key "${key}": a quoted string holds a stray quote`;
        return null;
      }
    }
    return last < n - 1 ? out + raw.slice(last, n - 1) : out;
  }
  if (raw.charCodeAt(0) === 91) {
    fmErr = `key "${key}": a bare string opens on [`;
    return null;
  }
  return raw;
}

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** Whether `raw` is YYYY-MM-DD, a real day from 1970-01-01 to 2099-12-31. */
function isDate(raw) {
  if (raw.length !== 10 || raw.charCodeAt(4) !== 45 || raw.charCodeAt(7) !== 45) return false;
  for (let i = 0; i < 10; i++) {
    if (i === 4 || i === 7) continue;
    const c = raw.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  const y = (raw.charCodeAt(0) - 48) * 1000 + (raw.charCodeAt(1) - 48) * 100 + (raw.charCodeAt(2) - 48) * 10 + (raw.charCodeAt(3) - 48);
  const mo = (raw.charCodeAt(5) - 48) * 10 + (raw.charCodeAt(6) - 48);
  const d = (raw.charCodeAt(8) - 48) * 10 + (raw.charCodeAt(9) - 48);
  return y >= 1970 && y <= 2099 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysIn(y, mo);
}

/** `[a, b, c]`: each name trimmed, none empty or holding " [ or ]. */
function tagsOf(raw) {
  const n = raw.length;
  if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(n - 1) !== 93 || n < 2) {
    fmErr = 'key "tags": not a list [a, b]';
    return null;
  }
  const inner = raw.slice(1, n - 1);
  if (inner.trim() === '') return EMPTY;
  const parts = inner.split(',');
  for (let i = 0; i < parts.length; i++) {
    const t = parts[i].trim();
    if (t === '' || t.includes('"') || t.includes('[') || t.includes(']')) {
      fmErr = 'key "tags": an empty tag, or one holding " [ or ]';
      return null;
    }
    parts[i] = t;
  }
  return parts;
}

/** Whether `raw` is a template name (a-z, 0-9 and -). */
function isName(raw) {
  const n = raw.length;
  if (n === 0) return false;
  for (let i = 0; i < n; i++) {
    const c = raw.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return false;
  }
  return true;
}

/** Whether `raw` is a slug (a-z and 0-9, single - between), at most 64 characters. */
function isSlug(raw) {
  const n = raw.length;
  if (n === 0 || n > 64) return false;
  let prevDash = true;
  for (let i = 0; i < n; i++) {
    const c = raw.charCodeAt(i);
    if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
    else if (c === 45) {
      if (prevDash) return false;
      prevDash = true;
    } else return false;
  }
  return !prevDash;
}

/**
 * A source's front matter and body, read into the fm* values above: fmErr holds the first reason the source is
 * refused, or null when it reads. `text` has "\n" line ends.
 */
function parseFrontMatter(text) {
  fmErr = null;
  fmTitle = undefined;
  fmDate = undefined;
  fmTags = EMPTY;
  fmDraft = false;
  fmLayout = undefined;
  fmSlug = undefined;
  fmSummary = undefined;
  fmBody = '';
  const n = text.length;
  let end = text.indexOf('\n');
  if (end === -1) end = n;
  if (end !== 3 || text.charCodeAt(0) !== 45 || text.charCodeAt(1) !== 45 || text.charCodeAt(2) !== 45) {
    fmErr = 'no front matter';
    return;
  }
  // The front matter runs to the next line that is exactly "---": with none, nothing between it is read at all.
  const first = end + 1;
  let close = -1;
  let closeEnd = -1;
  for (let i = first; i <= n; ) {
    let e = text.indexOf('\n', i);
    if (e === -1) e = n;
    if (e - i === 3 && text.charCodeAt(i) === 45 && text.charCodeAt(i + 1) === 45 && text.charCodeAt(i + 2) === 45) {
      close = i;
      closeEnd = e;
      break;
    }
    i = e + 1;
  }
  if (close === -1) {
    fmErr = 'the front matter is not closed';
    return;
  }
  let given = 0;
  let i = first;
  let line = 2;
  for (; i < close; line++) {
    let e = text.indexOf('\n', i);
    if (e === -1 || e > close) e = close;
    // A blank line (spaces and tabs only) or a comment (opening on #) carries nothing.
    let p = i;
    while (p < e) {
      const c = text.charCodeAt(p);
      if (c !== 32 && c !== 9) break;
      p++;
    }
    if (p === e || text.charCodeAt(i) === 35) {
      i = e + 1;
      continue;
    }
    // key: value, a key of a-z and _, one space after the colon, trailing spaces and tabs dropped.
    const colon = text.indexOf(':', i);
    if (colon <= i || colon >= e) {
      fmErr = `line ${line} is not "key: value"`;
      return;
    }
    for (let q = i; q < colon; q++) {
      const c = text.charCodeAt(q);
      if (!((c >= 97 && c <= 122) || c === 95)) {
        fmErr = `line ${line} is not "key: value"`;
        return;
      }
    }
    let raw;
    if (colon + 1 === e) raw = '';
    else if (text.charCodeAt(colon + 1) === 32) {
      let q = e;
      while (q > colon + 2) {
        const c = text.charCodeAt(q - 1);
        if (c !== 32 && c !== 9) break;
        q--;
      }
      raw = text.slice(colon + 2, q);
    } else {
      fmErr = `line ${line} is not "key: value"`;
      return;
    }
    const key = text.slice(i, colon);
    let bit;
    switch (key) {
      case 'title':
        bit = KEY_TITLE;
        break;
      case 'date':
        bit = KEY_DATE;
        break;
      case 'tags':
        bit = KEY_TAGS;
        break;
      case 'draft':
        bit = KEY_DRAFT;
        break;
      case 'layout':
        bit = KEY_LAYOUT;
        break;
      case 'slug':
        bit = KEY_SLUG;
        break;
      case 'summary':
        bit = KEY_SUMMARY;
        break;
      default:
        fmErr = `unknown key "${key}"`;
        return;
    }
    if ((given & bit) !== 0) {
      fmErr = `key "${key}" is given twice`;
      return;
    }
    if (raw === '') {
      fmErr = `key "${key}" has no value`;
      return;
    }
    given |= bit;
    switch (bit) {
      case KEY_TITLE:
        fmTitle = stringOf(raw, 'title');
        if (fmErr !== null) return;
        break;
      case KEY_SUMMARY:
        fmSummary = stringOf(raw, 'summary');
        if (fmErr !== null) return;
        break;
      case KEY_DATE:
        if (!isDate(raw)) {
          fmErr = 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)';
          return;
        }
        fmDate = raw;
        break;
      case KEY_TAGS:
        fmTags = tagsOf(raw);
        if (fmErr !== null) return;
        break;
      case KEY_DRAFT:
        if (raw === 'true') fmDraft = true;
        else if (raw !== 'false') {
          fmErr = 'key "draft": true or false';
          return;
        }
        break;
      case KEY_LAYOUT:
        if (!isName(raw)) {
          fmErr = 'key "layout": not a template name';
          return;
        }
        fmLayout = raw;
        break;
      default:
        if (!isSlug(raw)) {
          fmErr = 'key "slug": not a slug';
          return;
        }
        fmSlug = raw;
        break;
    }
    i = e + 1;
  }
  if ((given & KEY_TITLE) === 0) fmErr = 'no title';
  else fmBody = closeEnd < n ? text.slice(closeEnd + 1) : '';
}

const EMPTY = [];

// ---------------------------------------------------------------- inline Markdown

// What opens something inline: 1 an escaped character, 2 a backslash, 3 a code span, 4 strong or emphasis, 5 a link.
const INL = new Uint8Array(65536);
INL[38] = 1;
INL[60] = 1;
INL[62] = 1;
INL[34] = 1;
INL[39] = 1;
INL[92] = 2;
INL[96] = 3;
INL[42] = 4;
INL[91] = 5;

// The scan that finds the next of those characters. A call into the regexp engine was measured against a loop over
// the table and a run of plain text costs about a fifth as much here: the engine reads a character where a loop reads
// it, tests it against the table and branches on it, and inline text holds one about every fortieth character.
const INL_FIND = /[&<>"'\\`*[]/g;

// The characters a backslash escapes: \ ` * _ [ ] ( ) # + - . ! >
const ESCAPABLE = new Uint8Array(65536);
for (const c of [92, 96, 42, 95, 91, 93, 40, 41, 35, 43, 45, 46, 33, 62]) ESCAPABLE[c] = 1;

const CHAR1 = [];
for (let c = 0; c < 128; c++) CHAR1.push(String.fromCharCode(c));

// The range trimBounds read: [a, b) with the spaces and tabs at either end dropped.
let trA = 0;
let trB = 0;

/** [a, b) with the spaces and tabs at either end dropped, into trA and trB. */
function trimBounds(s, a, b) {
  while (a < b) {
    const c = s.charCodeAt(a);
    if (c !== 32 && c !== 9) break;
    a++;
  }
  while (b > a) {
    const c = s.charCodeAt(b - 1);
    if (c !== 32 && c !== 9) break;
    b--;
  }
  trA = a;
  trB = b;
}

/** `s`'s characters from `a` to `b`, spaces and tabs at either end dropped. */
function trimRange(s, a, b) {
  trimBounds(s, a, b);
  return trA === 0 && trB === s.length ? s : s.slice(trA, trB);
}

/** The first index in [from, to) where `s` holds "**" outside a backslash escape, or -1. */
function findStrong(s, from, to) {
  for (let j = from; j <= to - 2; j++) {
    const c = s.charCodeAt(j);
    if (c === 92) {
      if (j + 1 < to) {
        const nx = s.charCodeAt(j + 1);
        if (ESCAPABLE[nx] === 1) j++;
      }
      continue;
    }
    if (c === 42 && s.charCodeAt(j + 1) === 42) return j;
  }
  return -1;
}

/** The first single * in [from, to) (one whose run is not **), outside an escape, or -1. */
function findEm(s, from, to) {
  for (let j = from; j < to; j++) {
    const c = s.charCodeAt(j);
    if (c === 92) {
      if (j + 1 < to) {
        const nx = s.charCodeAt(j + 1);
        if (ESCAPABLE[nx] === 1) j++;
      }
      continue;
    }
    if (c !== 42) continue;
    if (j + 1 < to && s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** The first index in [from, to) where `s` holds "]" outside a backslash escape, or -1. */
function findClose(s, from, to) {
  for (let j = from; j < to; j++) {
    const c = s.charCodeAt(j);
    if (c === 92) {
      if (j + 1 < to) {
        const nx = s.charCodeAt(j + 1);
        if (ESCAPABLE[nx] === 1) j++;
      }
      continue;
    }
    if (c === 93) return j;
  }
  return -1;
}

/** `s`'s characters from `a` to `b` rendered inline. */
function inlineRange(s, a, b) {
  let out = '';
  let last = a;
  let i = a;
  for (;;) {
    // The next character that opens something, found by the engine rather than a character at a time. A hit past the
    // end of the range ends the scan: it belongs to whatever this range is a part of, not to this one.
    INL_FIND.lastIndex = i;
    if (!INL_FIND.test(s)) break;
    i = INL_FIND.lastIndex - 1;
    if (i >= b) break;
    const c = s.charCodeAt(i);
    const kind = INL[c];
    if (i > last) out += s.slice(last, i);
    if (kind === 1) {
      out += ESC_TEXT[ESC_CODE[c]];
      i++;
    } else if (kind === 4) {
      if (i + 1 < b && s.charCodeAt(i + 1) === 42) {
        const j = findStrong(s, i + 2, b);
        if (j > i + 2) {
          out += '<strong>';
          out += inlineRange(s, i + 2, j);
          out += '</strong>';
          i = j + 2;
        } else {
          out += '**';
          i += 2;
        }
      } else {
        const j = findEm(s, i + 1, b);
        if (j > i + 1) {
          out += '<em>';
          out += inlineRange(s, i + 1, j);
          out += '</em>';
          i = j + 1;
        } else {
          out += '*';
          i++;
        }
      }
    } else if (kind === 3) {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1 && j < b) {
        out += '<code>';
        out += esc(s.slice(i + 1, j));
        out += '</code>';
        i = j + 1;
      } else {
        out += '`';
        i++;
      }
    } else if (kind === 5) {
      const k = findClose(s, i + 1, b);
      let m = -1;
      if (k !== -1 && k + 1 < b && s.charCodeAt(k + 1) === 40) {
        m = s.indexOf(')', k + 2);
        if (m >= b) m = -1;
      }
      let plain = true;
      if (m > k + 2) {
        plain = false;
        for (let q = k + 2; q < m; q++) {
          if (WORDY[s.charCodeAt(q)] === 0) {
            plain = true;
            break;
          }
        }
      }
      if (plain) {
        out += '[';
        i++;
      } else {
        out += '<a href="';
        out += esc(linkHref(s.slice(k + 2, m)));
        out += '">';
        out += inlineRange(s, i + 1, k);
        out += '</a>';
        i = m + 1;
      }
    } else {
      const nx = i + 1 < b ? s.charCodeAt(i + 1) : -1;
      if (nx >= 0 && ESCAPABLE[nx] === 1) {
        out += nx === 62 ? '&gt;' : CHAR1[nx];
        i += 2;
      } else {
        out += '\\';
        i++;
      }
    }
    last = i;
  }
  if (last >= b) return out;
  if (last === a) return a === 0 && b === s.length ? s : s.slice(a, b);
  return out + s.slice(last, b);
}

// ---------------------------------------------------------------- links

// The source whose body is being rendered: its directory (split), its path, and the targets it has resolved.
let lkParts = EMPTY;
let lkPath = '';
let lkCache = null;
// The build the links resolve against.
let bySource = null;
let staticPaths = null;
let broken = null;
let base = '';

/** `rel` (a link's path, "/"-separated) from the source's directory, or null when it climbs out of the root. */
function resolvePath(rel) {
  const parts = lkParts.length === 0 ? [] : lkParts.slice();
  let from = 0;
  for (;;) {
    let at = rel.indexOf('/', from);
    const end = at === -1 ? rel.length : at;
    if (end > from) {
      const seg = rel.slice(from, end);
      if (seg === '..') {
        if (parts.length === 0) return null;
        parts.pop();
      } else if (seg !== '.') parts.push(seg);
    }
    if (at === -1) break;
    from = at + 1;
  }
  return parts.length === 1 ? parts[0] : parts.join('/');
}

/** A link target's href: a scheme, "/" or "#" as written, else the page or static file the path names. */
function resolveLink(target) {
  const c0 = target.charCodeAt(0);
  if (c0 === 47 || c0 === 35) return target;
  if ((c0 >= 97 && c0 <= 122) || (c0 >= 65 && c0 <= 90)) {
    const n = target.length;
    let p = 1;
    while (p < n) {
      const c = target.charCodeAt(p);
      if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 43 || c === 46 || c === 45) p++;
      else break;
    }
    if (p < n && target.charCodeAt(p) === 58) return target;
  }
  const hash = target.indexOf('#');
  const rel = hash === -1 ? target : target.slice(0, hash);
  if (rel !== '') {
    const path = resolvePath(rel);
    if (path !== null) {
      const page = bySource.get(path);
      if (page !== undefined) return hash === -1 ? page.url : page.url + target.slice(hash);
      if (staticPaths.has(path)) return hash === -1 ? `${base}/${path}` : `${base}/${path}${target.slice(hash)}`;
    }
  }
  broken.add(`broken-link ${lkPath} -> ${target}`);
  return target;
}

/** The href of `target`, resolved once per source. */
function linkHref(target) {
  const hit = lkCache.get(target);
  if (hit !== undefined) return hit;
  const href = resolveLink(target);
  lkCache.set(target, href);
  return href;
}

// ---------------------------------------------------------------- block Markdown

// Every line test reads the source itself over the range [a, b) of one line: no line ever becomes a string of its own,
// and a block whose lines are already trimmed and run together is one slice of the source.

/** Whether `s` holds only spaces and tabs from `a` to `b`. */
function allSpaceTab(s, a, b) {
  for (let i = a; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Where a fence-open line's language ends (its start with none), or -1 when the line is not one. */
function fenceOpen(s, a, b) {
  if (b - a < 3 || s.charCodeAt(a + 1) !== 96 || s.charCodeAt(a + 2) !== 96) return -1;
  let p = a + 3;
  while (p < b) {
    const c = s.charCodeAt(p);
    if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) p++;
    else break;
  }
  const langEnd = p;
  while (p < b) {
    const c = s.charCodeAt(p);
    if (c !== 32 && c !== 9) return -1;
    p++;
  }
  return langEnd;
}

/** Whether the line [a, b) closes a fence: three backticks, then spaces or tabs only. */
function fenceClose(s, a, b) {
  if (b - a < 3 || s.charCodeAt(a) !== 96 || s.charCodeAt(a + 1) !== 96 || s.charCodeAt(a + 2) !== 96) return false;
  return allSpaceTab(s, a + 3, b);
}

// A heading line's level and the range of its text.
let hdLevel = 0;
let hdFrom = 0;
let hdTo = 0;

/** Whether the line [a, b) is a heading (1 to 6 #, a space or tab, then text): its level and text range above. */
function heading(s, a, b) {
  let p = a + 1;
  while (p < b && s.charCodeAt(p) === 35) p++;
  const level = p - a;
  if (level > 6 || p >= b) return false;
  const c = s.charCodeAt(p);
  if (c !== 32 && c !== 9) return false;
  p++;
  while (p < b) {
    const c2 = s.charCodeAt(p);
    if (c2 !== 32 && c2 !== 9) break;
    p++;
  }
  let q = b;
  while (q > p) {
    const c2 = s.charCodeAt(q - 1);
    if (c2 !== 32 && c2 !== 9) break;
    q--;
  }
  if (q <= p) return false;
  hdLevel = level;
  hdFrom = p;
  hdTo = q;
  return true;
}

/** Whether the line [a, b) ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsPara(s, a, b) {
  if (b === a) return true;
  const c0 = s.charCodeAt(a);
  if (c0 === 32 || c0 === 9) return allSpaceTab(s, a + 1, b);
  if (c0 === 96) return fenceOpen(s, a, b) >= 0;
  if (c0 === 35) return heading(s, a, b);
  if (c0 === 45 || c0 === 42) return b - a >= 3 && s.charCodeAt(a + 1) === c0 && s.charCodeAt(a + 2) === c0 && allSpaceTab(s, a + 3, b);
  return false;
}

/** Where a bullet item's text starts (a line "- " or "* "), or -1. */
function bulletStart(s, a, b) {
  if (b - a < 2) return -1;
  const c0 = s.charCodeAt(a);
  return (c0 === 45 || c0 === 42) && s.charCodeAt(a + 1) === 32 ? a + 2 : -1;
}

/** Where an ordered item's text starts (digits, then ". "), or -1. */
function orderedStart(s, a, b) {
  let p = a;
  while (p < b) {
    const c = s.charCodeAt(p);
    if (c < 48 || c > 57) break;
    p++;
  }
  const digits = p - a;
  if (digits === 0 || digits > 9 || p + 1 >= b) return -1;
  return s.charCodeAt(p) === 46 && s.charCodeAt(p + 1) === 32 ? p + 2 : -1;
}

/** Whether the line [a, b) continues an item: two or more spaces, then a non-space. */
function continued(s, a, b) {
  if (b - a < 3 || s.charCodeAt(a) !== 32 || s.charCodeAt(a + 1) !== 32) return false;
  let p = a + 2;
  while (p < b && s.charCodeAt(p) === 32) p++;
  return p < b && WORDY[s.charCodeAt(p)] === 1;
}

/** Whether the line [a, b) is already trimmed: no space or tab at either end. */
function trimmed(s, a, b) {
  const first = s.charCodeAt(a);
  if (first === 32 || first === 9) return false;
  const last = s.charCodeAt(b - 1);
  return last !== 32 && last !== 9;
}

// What a body rendered: its HTML, its table of contents and its first paragraph.
let mdHtml = '';
let mdToc = EMPTY;
let mdExcerpt = '';

/** An item's inline HTML, from a range of the source or from the string a continued item was built as. */
function itemHtml(src, a, b, built) {
  return built === null ? inlineRange(src, a, b) : inlineRange(built, 0, built.length);
}

/** `src` rendered: every block in order, each followed by "\n". */
function renderMarkdown(src) {
  const n = src.length;
  let html = '';
  let toc = null;
  let excerpt = null;
  let ids = null;
  let i = 0;
  while (i <= n) {
    let e = src.indexOf('\n', i);
    if (e === -1) e = n;
    if (e === i) {
      i = e + 1;
      continue;
    }
    const c0 = src.charCodeAt(i);
    if (c0 === 32 || c0 === 9) {
      if (allSpaceTab(src, i + 1, e)) {
        i = e + 1;
        continue;
      }
    } else if (c0 === 96) {
      const langEnd = fenceOpen(src, i, e);
      if (langEnd >= 0) {
        // The body runs to a line of three backticks, or to the end; every line escaped, each ending in "\n".
        const body = e + 1;
        let bodyEnd = -1;
        let k = body;
        while (k <= n) {
          let ke = src.indexOf('\n', k);
          if (ke === -1) ke = n;
          if (fenceClose(src, k, ke)) {
            k = ke + 1;
            break;
          }
          bodyEnd = ke;
          k = ke + 1;
        }
        html += langEnd === i + 3 ? '<pre><code>' : `<pre><code class="language-${esc(src.slice(i + 3, langEnd))}">`;
        if (bodyEnd >= 0) {
          html += esc(src.slice(body, bodyEnd));
          html += '\n';
        }
        html += '</code></pre>\n';
        i = k;
        continue;
      }
    } else if (c0 === 35) {
      if (heading(src, i, e)) {
        const level = hdLevel;
        if (ids === null) ids = new Set();
        const id = uniqueSlug(slugify(src.slice(hdFrom, hdTo)), ids);
        const inner = inlineRange(src, hdFrom, hdTo);
        html += `<h${level} id="${id}">${inner}</h${level}>\n`;
        if (level === 2 || level === 3) {
          if (toc === null) toc = [];
          toc.push({ level, id, html: inner });
        }
        i = e + 1;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (e - i >= 3 && src.charCodeAt(i + 1) === c0 && src.charCodeAt(i + 2) === c0 && allSpaceTab(src, i + 3, e)) {
        html += '<hr>\n';
        i = e + 1;
        continue;
      }
      const first = bulletStart(src, i, e);
      if (first >= 0) {
        i = renderList(src, n, first, e, false, 1);
        html += mdBlock;
        continue;
      }
    } else if (c0 === 62) {
      let text = '';
      let any = false;
      let k = i;
      let ke = e;
      for (;;) {
        const from = src.charCodeAt(k + 1) === 32 ? k + 2 : k + 1;
        const t = trimRange(src, from, ke);
        if (t !== '') {
          if (any) text += '\n';
          else any = true;
          text += t;
        }
        k = ke + 1;
        if (k > n || src.charCodeAt(k) !== 62) break;
        ke = src.indexOf('\n', k);
        if (ke === -1) ke = n;
      }
      html += any ? `<blockquote>\n<p>${inlineRange(text, 0, text.length)}</p>\n</blockquote>\n` : '<blockquote>\n</blockquote>\n';
      i = k;
      continue;
    } else if (c0 >= 48 && c0 <= 57) {
      const first = orderedStart(src, i, e);
      if (first >= 0) {
        i = renderList(src, n, first, e, true, Number(src.slice(i, first - 2)));
        html += mdBlock;
        continue;
      }
    }
    // A paragraph: this line and the lines after it, each trimmed and joined by "\n".
    let last = e;
    let plain = trimmed(src, i, e);
    let k = e + 1;
    while (k <= n) {
      let ke = src.indexOf('\n', k);
      if (ke === -1) ke = n;
      if (endsPara(src, k, ke)) break;
      last = ke;
      if (plain && !trimmed(src, k, ke)) plain = false;
      k = ke + 1;
    }
    let inner;
    if (plain) inner = inlineRange(src, i, last);
    else {
      let text = trimRange(src, i, e);
      let q = e + 1;
      while (q <= last) {
        let qe = src.indexOf('\n', q);
        if (qe === -1) qe = n;
        text += `\n${trimRange(src, q, qe)}`;
        q = qe + 1;
      }
      inner = inlineRange(text, 0, text.length);
    }
    if (excerpt === null) excerpt = inner;
    html += `<p>${inner}</p>\n`;
    i = last + 1;
  }
  mdHtml = html;
  mdToc = toc === null ? EMPTY : toc;
  mdExcerpt = excerpt === null ? '' : excerpt;
}

// The block renderList wrote, and the line the list ended at.
let mdBlock = '';

/**
 * A list from its first item's text [first, e): each following line of the same kind another item, a line of two or
 * more spaces then a non-space continuing one. Returns the start of the line that ended it.
 */
function renderList(src, n, first, e, ordered, start) {
  let items = '';
  trimBounds(src, first, e);
  let curA = trA;
  let curB = trB;
  let built = null;
  let k = e + 1;
  while (k <= n) {
    let ke = src.indexOf('\n', k);
    if (ke === -1) ke = n;
    const at = ordered ? orderedStart(src, k, ke) : bulletStart(src, k, ke);
    if (at >= 0) {
      items += `<li>${itemHtml(src, curA, curB, built)}</li>\n`;
      trimBounds(src, at, ke);
      curA = trA;
      curB = trB;
      built = null;
    } else if (continued(src, k, ke)) {
      if (built === null) built = trimRange(src, curA, curB);
      built += `\n${trimRange(src, k, ke)}`;
    } else break;
    k = ke + 1;
  }
  const item = `<li>${itemHtml(src, curA, curB, built)}</li>\n`;
  mdBlock = ordered
    ? `${start === 1 ? '<ol>' : `<ol start="${start}">`}\n${items}${item}</ol>\n`
    : `<ul>\n${items}${item}</ul>\n`;
  return k;
}

// ---------------------------------------------------------------- templates: parsing

const OP_TEXT = 0;
const OP_VAR = 1;
const OP_RAW = 2;
const OP_IF = 3;
const OP_FOR = 4;
const OP_INC = 5;
const OP_CONST = 6;
const OP_MEMO = 7;

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

/** The values every template sees, in the order the scope array holds them. */
const TOP_NAMES = ['site', 'tags', 'recent', 'page', 'posts', 'pager', 'tag'];
/** The values that are the same for every page of one build. */
const SHARED_NAMES = new Set(['site', 'tags', 'recent']);

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

// Every name a template reads or binds, each with an id of its own, so a scope walk compares numbers. idTop holds
// each name's place among the values every template sees (-1 for none), idShared whether it is one a build shares.
const nameIds = new Map();
const idTop = [];
const idShared = [];

function nameId(name) {
  let id = nameIds.get(name);
  if (id === undefined) {
    id = nameIds.size;
    nameIds.set(name, id);
    idTop.push(TOP_NAMES.indexOf(name));
    idShared.push(SHARED_NAMES.has(name));
  }
  return id;
}

const LOOP_ID = nameId('loop');

/** One node of a template, every kind in one shape. */
function node(k) {
  return { k, s: '', p: null, id: -1, t: -1, nid: -1, not: false, a: null, b: null, cache: null };
}

/** A template that does not parse, thrown as a plain object (its message is what the report names). */
function fail(msg) {
  throw { tpl: msg };
}

/** The path `text` names, read into `nd`. */
function setPath(nd, name, text) {
  if (!PATH_RE.test(text)) fail(`template "${name}": ${JSON.stringify(text)} is not a path`);
  const names = text.split('.');
  nd.id = nameId(names[0]);
  nd.t = idTop[nd.id];
  nd.p = names.length === 1 ? null : names.slice(1);
  return nd;
}

/** Whether `src` holds only spaces and tabs from `a` to `b`. */
function onlySpaceTab(src, a, b) {
  for (let i = a; i < b; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `src` parsed into its tree of nodes; it does not parse when fail() throws. */
function parseTemplate(name, src) {
  const root = [];
  const stack = [{ kind: 'root', body: root, node: null }];
  let body = root;
  let text = '';
  let i = 0;
  const n = src.length;
  const pushText = () => {
    if (text !== '') {
      const nd = node(OP_TEXT);
      nd.s = text;
      body.push(nd);
      text = '';
    }
  };
  while (i < n) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === n - 1) {
      text += src.slice(i);
      break;
    }
    const next = src.charCodeAt(open + 1);
    if (next !== 123 && next !== 37) {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === 123) {
      const raw = src.charCodeAt(open + 2) === 123;
      const width = raw ? 3 : 2;
      const close = src.indexOf(raw ? '}}}' : '}}', open + width);
      if (close === -1) fail(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      pushText();
      body.push(setPath(node(raw ? OP_RAW : OP_VAR), name, src.slice(open + width, close).trim()));
      i = close + width;
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) fail(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? n : nl;
    const standalone = onlySpaceTab(src, lineStart, open) && onlySpaceTab(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    pushText();
    i = standalone ? (nl === -1 ? n : nl + 1) : end;
    const tag = src.slice(open + 2, close).trim();
    const top = stack[stack.length - 1];
    let m = FOR_RE.exec(tag);
    if (m !== null) {
      const nd = setPath(node(OP_FOR), name, m[2]);
      // A scope reads loop before the element it binds, so a for that binds the name "loop" binds nothing a path can
      // name: the reference's own vars object writes loop last, and its element is never found.
      const bound = nameId(m[1]);
      nd.nid = bound === LOOP_ID ? -1 : bound;
      forVarIds.add(nd.nid);
      nd.a = [];
      body.push(nd);
      stack.push({ kind: 'for', body: nd.a, node: nd });
      body = nd.a;
      continue;
    }
    m = IF_RE.exec(tag);
    if (m !== null) {
      const nd = setPath(node(OP_IF), name, m[2]);
      nd.not = m[1] !== undefined;
      nd.a = [];
      body.push(nd);
      stack.push({ kind: 'if', body: nd.a, node: nd });
      body = nd.a;
      continue;
    }
    if (tag === 'else') {
      if (top.kind !== 'if' || top.node.b !== null) fail(`template "${name}": an else outside an if`);
      top.node.b = [];
      top.body = top.node.b;
      body = top.node.b;
      continue;
    }
    if (tag === 'endfor' || tag === 'endif') {
      const want = tag === 'endfor' ? 'for' : 'if';
      if (top.kind !== want) fail(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
      stack.pop();
      body = stack[stack.length - 1].body;
      continue;
    }
    m = INCLUDE_RE.exec(tag);
    if (m !== null) {
      const nd = node(OP_INC);
      nd.s = m[1];
      body.push(nd);
      continue;
    }
    fail(`template "${name}": {% ${tag} %} is not a tag`);
  }
  pushText();
  if (stack.length > 1) fail(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root;
}

// ---------------------------------------------------------------- templates: folding

// The templates of one build (name -> { nodes, ops, free, busy }), the names any for binds, and whether the names a
// subtree reads could not be read off (a cycle of includes), which leaves it unfolded.
let tmpl = null;
let forVarIds = null;
let cycleHit = false;
let incOps = null;

/** The names `nodes` read from outside themselves, as ids. */
function addFree(nodes, set) {
  for (let i = 0; i < nodes.length; i++) {
    const nd = nodes[i];
    const k = nd.k;
    if (k === OP_VAR || k === OP_RAW) set.add(nd.id);
    else if (k === OP_IF) {
      set.add(nd.id);
      addFree(nd.a, set);
      if (nd.b !== null) addFree(nd.b, set);
    } else if (k === OP_FOR) {
      set.add(nd.id);
      const inner = new Set();
      addFree(nd.a, inner);
      inner.delete(nd.nid);
      inner.delete(LOOP_ID);
      for (const x of inner) set.add(x);
    } else if (k === OP_INC) {
      const t = tmpl.get(nd.s);
      if (t !== undefined) {
        const f = freeOfTemplate(t);
        if (f === null) cycleHit = true;
        else for (const x of f) set.add(x);
      }
    }
  }
}

/** The names a template reads, or null where a cycle of includes leaves them unknown. */
function freeOfTemplate(t) {
  if (t.free !== undefined) return t.free;
  if (t.busy) {
    cycleHit = true;
    return null;
  }
  t.busy = true;
  const outer = cycleHit;
  cycleHit = false;
  const set = new Set();
  addFree(t.nodes, set);
  const hit = cycleHit;
  cycleHit = outer || hit;
  t.busy = false;
  t.free = hit ? null : set;
  return t.free;
}

// What a node's render depends on, as classify() answers it: these two, or the id of the one loop variable it reads.
const CLS_CONST = -1;
const CLS_PLAIN = -2;
const ONE = [null];

/**
 * What one node's render depends on: CLS_CONST when it reads only what every page of a build shares, the id of a name
 * when it reads one loop variable besides (its render is then the same for the same value), else CLS_PLAIN. The answer
 * is the return value, never a field, so folding a run cannot write over the answer for the node after it.
 */
function classify(nd) {
  if (nd.k === OP_TEXT) return CLS_CONST;
  ONE[0] = nd;
  cycleHit = false;
  const set = new Set();
  addFree(ONE, set);
  if (cycleHit) return CLS_PLAIN;
  let only = -1;
  for (const id of set) {
    // A name every page of a build shares, unless some for binds it: a template may bind "tags" or "site" itself, and
    // then what the name reads is the element, not the build's own value.
    if (idShared[id] && !forVarIds.has(id)) continue;
    // A name nothing ever binds and no page's values hold: it reads undefined wherever it is read.
    if (id !== LOOP_ID && idTop[id] < 0 && !forVarIds.has(id)) continue;
    if (only >= 0) return CLS_PLAIN;
    only = id;
  }
  if (only < 0) return CLS_CONST;
  return only !== LOOP_ID && forVarIds.has(only) ? only : CLS_PLAIN;
}

/** One node with its bodies folded. */
function foldNode(nd) {
  const k = nd.k;
  if (k === OP_IF) {
    const out = node(OP_IF);
    out.p = nd.p;
    out.id = nd.id;
    out.t = nd.t;
    out.not = nd.not;
    out.a = foldNodes(nd.a);
    out.b = nd.b === null ? null : foldNodes(nd.b);
    return out;
  }
  if (k === OP_FOR) {
    const out = node(OP_FOR);
    out.p = nd.p;
    out.id = nd.id;
    out.t = nd.t;
    out.nid = nd.nid;
    out.a = foldNodes(nd.a);
    return out;
  }
  if (k === OP_INC) {
    const out = node(OP_INC);
    out.s = nd.s;
    incOps.push(out);
    return out;
  }
  return nd;
}

/** `run`'s nodes folded, with no wrapper of their own. */
function foldRun(run) {
  const ops = [];
  for (let i = 0; i < run.length; i++) ops.push(foldNode(run[i]));
  return ops;
}

/**
 * `nodes` as the ops a render walks: each run of nodes that reads only what a build shares becomes one op computed
 * once, and each run that reads one loop variable one op memoised by its value.
 */
function foldNodes(nodes) {
  const ops = [];
  let runKind = -1;
  let runId = -1;
  let run = null;
  for (let i = 0; i <= nodes.length; i++) {
    const nd = i < nodes.length ? nodes[i] : null;
    const cls = nd === null ? CLS_PLAIN : classify(nd);
    if (nd !== null) {
      if (cls === CLS_CONST && runKind === 0) {
        run.push(nd);
        continue;
      }
      if (cls >= 0 && runKind === 1 && runId === cls) {
        run.push(nd);
        continue;
      }
    }
    if (run !== null) {
      if (runKind === 0) {
        let text = '';
        let allText = true;
        for (let j = 0; j < run.length; j++) {
          if (run[j].k === OP_TEXT) text += run[j].s;
          else {
            allText = false;
            break;
          }
        }
        if (allText) {
          const op = node(OP_TEXT);
          op.s = text;
          ops.push(op);
        } else {
          const op = node(OP_CONST);
          op.a = foldRun(run);
          op.cache = new Array(INCLUDE_DEPTH + 1);
          ops.push(op);
        }
      } else if (run.length === 1 && (run[0].k === OP_VAR || run[0].k === OP_RAW)) ops.push(run[0]);
      else {
        const op = node(OP_MEMO);
        op.nid = runId;
        // The name may be one a page's own values hold too (a template is free to bind "page" in a for), so the key
        // is read the way any path's first name is: the innermost scope that binds it, else the page's values.
        op.t = idTop[runId];
        op.a = foldRun(run);
        op.cache = new Array(INCLUDE_DEPTH + 1);
        ops.push(op);
      }
      run = null;
      runKind = -1;
    }
    if (nd === null) break;
    if (cls === CLS_PLAIN) ops.push(foldNode(nd));
    else {
      run = [nd];
      runKind = cls === CLS_CONST ? 0 : 1;
      runId = cls;
    }
  }
  return ops;
}

// ---------------------------------------------------------------- templates: rendering

/**
 * The page being written, grown by every op in order: V8's own rope of it, flattened once where it is read. Three
 * other shapes were measured against it on this build and every one costs more: an array of the ops' texts joined per
 * page, the page written as UTF-8 into one scratch buffer and read back from it with utf8Slice, and the whole answer
 * written as the bytes of its JSON with each file's text read back out of it. Holding a page as a rope of the pieces
 * already in hand and letting one flatten copy them is the least a page's text can cost.
 */
let OUT = '';

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items by ", ". */
function textOf(v) {
  const t = typeof v;
  if (t === 'string') return v;
  if (t === 'number') return String(v);
  if (t === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let out = '';
    for (let i = 0; i < v.length; i++) {
      if (i > 0) out += ', ';
      out += textOf(v[i]);
    }
    return out;
  }
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** The value of a path's first name in the scope chain: the innermost scope that binds it, else the page's values. */
function lookupFirst(scope, id, top) {
  let s = scope;
  while (s.k === 1) {
    if (s.nid === id) return s.v;
    if (id === LOOP_ID) return s.l;
    s = s.p;
  }
  return top < 0 ? undefined : s.v[top];
}

/** The value at `op`'s path, or undefined: each name after the first an own property of the value so far. */
function lookupPath(scope, op) {
  let v = lookupFirst(scope, op.id, op.t);
  const tail = op.p;
  if (tail === null) return v;
  for (let i = 0; i < tail.length; i++) {
    const key = tail[i];
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, key)) return undefined;
    v = v[key];
  }
  return v;
}

/** `ops` rendered into its own string, the page's own left as it was. */
function capture(ops, scope, depth) {
  const held = OUT;
  OUT = '';
  renderOps(ops, scope, depth);
  const made = OUT;
  OUT = held;
  return made;
}

/** `ops` rendered in `scope`, appended to the page. */
function renderOps(ops, scope, depth) {
  const n = ops.length;
  for (let i = 0; i < n; i++) {
    const op = ops[i];
    const k = op.k;
    if (k === OP_TEXT) OUT += op.s;
    else if (k === OP_CONST) {
      const cache = op.cache;
      const held = cache[depth];
      if (held === undefined) {
        const made = capture(op.a, scope, depth);
        cache[depth] = made;
        OUT += made;
      } else OUT += held;
    } else if (k === OP_VAR) OUT += esc(textOf(lookupPath(scope, op)));
    else if (k === OP_RAW) OUT += textOf(lookupPath(scope, op));
    else if (k === OP_IF) {
      const branch = truthy(lookupPath(scope, op)) !== op.not ? op.a : op.b;
      if (branch !== null) renderOps(branch, scope, depth);
    } else if (k === OP_FOR) {
      const xs = lookupPath(scope, op);
      if (Array.isArray(xs)) {
        const len = xs.length;
        const nid = op.nid;
        const body = op.a;
        // A scope and a loop made for each element, not one pair written again: neither outlives the call it is made
        // for, and one made here and left here is the cheaper of the two (measured both ways on this build).
        for (let j = 0; j < len; j++) {
          renderOps(body, { k: 1, nid, v: xs[j], l: { index: j + 1, first: j === 0, last: j === len - 1, length: len }, p: scope }, depth);
        }
      }
    } else if (k === OP_MEMO) {
      let map = op.cache[depth];
      if (map === undefined) {
        map = new Map();
        op.cache[depth] = map;
      }
      const key = lookupFirst(scope, op.nid, op.t);
      const held = map.get(key);
      if (held === undefined) {
        const made = capture(op.a, scope, depth);
        map.set(key, made);
        OUT += made;
      } else OUT += held;
    } else if (op.a !== null && depth < INCLUDE_DEPTH) renderOps(op.a, scope, depth + 1);
  }
}

/** One page: its ops rendered from the top, as the tree holds its text. */
function renderPage(ops, scope) {
  OUT = '';
  renderOps(ops, scope, 0);
  const made = OUT;
  OUT = '';
  return made;
}

// ---------------------------------------------------------------- the build

/** The report file every build writes. */
const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
const RESERVED = ['posts', 'tags', 'page'];

const byPath = (x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0);

/** A page's link record as templates read it. */
function linkOf(s) {
  if (s === null) return null;
  const date = s.date;
  return { title: s.title, url: s.url, date: date === undefined ? '' : date, date_long: date === undefined ? '' : longDate(date) };
}

/** A source's tags as a card shows them. */
function tagCards(refs) {
  const n = refs.length;
  if (n === 0) return EMPTY;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const t = refs[i];
    out[i] = { name: t.name, slug: t.slug, url: t.url };
  }
  return out;
}

/** A post's card, as lists show it. */
function cardOf(s) {
  const date = s.date;
  const words = s.words;
  return {
    title: s.title,
    url: s.url,
    date: date === undefined ? '' : date,
    date_long: date === undefined ? '' : longDate(date),
    summary: s.summary === undefined ? '' : s.summary,
    excerpt: s.excerpt,
    reading_minutes: words <= 200 ? 1 : Math.ceil(words / 200),
    tags: tagCards(s.tagRefs),
  };
}

/** A page as its layout reads it. */
function pageOf(s) {
  const c = s.card !== null ? s.card : cardOf(s);
  return {
    title: c.title,
    url: c.url,
    date: c.date,
    date_long: c.date_long,
    summary: c.summary,
    excerpt: c.excerpt,
    reading_minutes: c.reading_minutes,
    tags: c.tags,
    slug: s.slug,
    content: s.html,
    toc: s.toc,
    newer: linkOf(s.newer),
    older: linkOf(s.older),
    is_post: s.post,
  };
}

/** One site's output tree: path -> text, as makefun-site 1.0.0's build(input) returns it. */
export function run(input) {
  const inSite = input.site;
  const baseUrl = inSite.base_url;
  let cut = baseUrl.length;
  while (cut > 0 && baseUrl.charCodeAt(cut - 1) === 47) cut--;
  base = cut === baseUrl.length ? baseUrl : baseUrl.slice(0, cut);

  // 1. Every template parsed, in code-unit order of its name; one that does not parse is reported and left out.
  const report = [];
  tmpl = new Map();
  forVarIds = new Set();
  incOps = [];
  const sources = input.templates;
  const names = Object.keys(sources).sort();
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    try {
      tmpl.set(name, { nodes: parseTemplate(name, sources[name]), ops: null, free: undefined, busy: false });
    } catch (err) {
      if (err === null || typeof err !== 'object' || typeof err.tpl !== 'string') throw err;
      report.push(err.tpl);
    }
  }
  for (const t of tmpl.values()) t.ops = foldNodes(t.nodes);
  for (let i = 0; i < incOps.length; i++) {
    const t = tmpl.get(incOps[i].s);
    incOps[i].a = t === undefined ? null : t.ops;
  }

  // 2. The files in code-unit order; a .md file is a source, its line ends made "\n", and any other one is static.
  const files = input.files.slice().sort(byPath);
  const pages = [];
  const statics = [];
  bySource = new Map();
  broken = new Set();
  const takenIn = new Map();
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const path = f.path;
    if (!path.endsWith('.md')) {
      statics.push(f);
      continue;
    }
    let text = f.content;
    if (text.indexOf('\r') !== -1) text = text.replace(/\r\n?/g, '\n');
    // 3. The front matter, and every check a source is dropped by, in order.
    parseFrontMatter(text);
    if (fmErr !== null) {
      report.push(`refused ${path}: ${fmErr}`);
      continue;
    }
    const post = path.startsWith('posts/');
    if (path.startsWith('tags/')) {
      report.push(`refused ${path}: tags/ is the generator's own`);
      continue;
    }
    if (path.startsWith('page/')) {
      report.push(`refused ${path}: page/ is the generator's own`);
      continue;
    }
    if (post && fmDate === undefined) {
      report.push(`refused ${path}: a post needs a date`);
      continue;
    }
    const layout = fmLayout === undefined ? (post ? 'post' : 'page') : fmLayout;
    if (!tmpl.has(layout)) {
      report.push(`refused ${path}: layout "${layout}" is no template that parses`);
      continue;
    }
    if (fmDraft) {
      report.push(`draft ${path}`);
      continue;
    }
    // 4. The permalink: the slug made unique in its directory, in source order.
    const at = path.lastIndexOf('/');
    const sdir = at === -1 ? '' : path.slice(0, at);
    const dir = post ? 'posts' : sdir;
    let taken = takenIn.get(dir);
    if (taken === undefined) {
      taken = new Set(dir === '' ? RESERVED : EMPTY);
      takenIn.set(dir, taken);
    }
    const slug = uniqueSlug(fmSlug === undefined ? slugify(fmTitle) : fmSlug, taken);
    const outDir = dir === '' ? slug : `${dir}/${slug}`;
    const s = {
      path,
      sdir,
      body: fmBody,
      title: fmTitle,
      date: fmDate,
      tags: fmTags,
      summary: fmSummary,
      layout,
      post,
      slug,
      outDir,
      url: `${base}/${outDir}/`,
      html: '',
      toc: EMPTY,
      excerpt: '',
      words: 0,
      newer: null,
      older: null,
      tagRefs: EMPTY,
      card: null,
    };
    pages.push(s);
    bySource.set(path, s);
  }
  staticPaths = new Set();
  for (let i = 0; i < statics.length; i++) staticPaths.add(statics[i].path);

  // 5. Every body's Markdown, its links resolved to the pages and static files they name.
  const dirParts = new Map();
  lkCache = new Map();
  for (let i = 0; i < pages.length; i++) {
    const s = pages[i];
    const sdir = s.sdir;
    let parts = dirParts.get(sdir);
    if (parts === undefined) {
      parts = sdir === '' ? EMPTY : sdir.split('/');
      dirParts.set(sdir, parts);
    }
    lkParts = parts;
    lkPath = s.path;
    lkCache.clear();
    renderMarkdown(s.body);
    s.html = mdHtml;
    s.toc = mdToc;
    s.excerpt = mdExcerpt;
    s.words = wordsOf(s.body);
  }

  // 6. The posts, newest date first and then by slug; each post's newer and older neighbours.
  const posts = [];
  for (let i = 0; i < pages.length; i++) if (pages[i].post) posts.push(pages[i]);
  posts.sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : x.slug < y.slug ? -1 : x.slug > y.slug ? 1 : 0));
  const nPosts = posts.length;
  for (let i = 0; i < nPosts; i++) {
    posts[i].newer = i === 0 ? null : posts[i - 1];
    posts[i].older = i === nPosts - 1 ? null : posts[i + 1];
  }

  // 7. The tags: each post's, each slug once, grouped by slug and ordered by count and then slug.
  const bySlug = new Map();
  for (let i = 0; i < nPosts; i++) {
    const p = posts[i];
    const own = p.tags;
    if (own.length === 0) continue;
    const refs = [];
    const seen = [];
    for (let j = 0; j < own.length; j++) {
      const name = own[j];
      const slug = slugify(name);
      if (seen.indexOf(slug) !== -1) continue;
      seen.push(slug);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      refs.push(tag);
    }
    p.tagRefs = refs;
  }
  // A page's tags link to the posts' tag of the same slug, and to nothing (url "") where no post has it.
  for (let i = 0; i < pages.length; i++) {
    const s = pages[i];
    if (s.post) continue;
    const own = s.tags;
    if (own.length === 0) continue;
    const refs = [];
    const seen = [];
    for (let j = 0; j < own.length; j++) {
      const name = own[j];
      const slug = slugify(name);
      if (seen.indexOf(slug) !== -1) continue;
      seen.push(slug);
      const tag = bySlug.get(slug);
      refs.push(tag === undefined ? { name, slug, url: '', posts: EMPTY } : tag);
    }
    s.tagRefs = refs;
  }
  const tagList = [...bySlug.values()];
  tagList.sort((x, y) => y.posts.length - x.posts.length || (x.slug < y.slug ? -1 : x.slug > y.slug ? 1 : 0));
  const nTags = tagList.length;

  // 8. Every page through its layout, the index pages, the tag pages and the tags page through theirs.
  // The tree is an ordinary object, makefun-site's own `{}`: it keeps a shape V8's JSON writer has a fast path for,
  // where a dictionary from the start costs that path every page it writes, and it answers a path named __proto__ as
  // makefun-site does, by assigning nothing.
  const output = {};
  const allTags = new Array(nTags);
  for (let i = 0; i < nTags; i++) {
    const t = tagList[i];
    allTags[i] = { name: t.name, slug: t.slug, url: t.url, count: t.posts.length };
  }
  for (let i = 0; i < nPosts; i++) posts[i].card = cardOf(posts[i]);
  const head = posts.slice(0, inSite.recent);
  const recent = new Array(head.length);
  for (let i = 0; i < head.length; i++) recent[i] = head[i].card;
  const vars = [{ title: inSite.title, base_url: base }, allTags, recent, undefined, undefined, undefined, undefined];
  const scope = { k: 0, nid: -1, v: vars, l: null, p: null };
  for (let i = 0; i < pages.length; i++) {
    const s = pages[i];
    vars[3] = pageOf(s);
    output[`${s.outDir}/index.html`] = renderPage(tmpl.get(s.layout).ops, scope);
  }
  vars[3] = undefined;
  const indexT = tmpl.get('index');
  if (indexT !== undefined) {
    const per = inSite.per_page;
    const total = Math.max(1, Math.ceil(nPosts / per));
    for (let k = 1; k <= total; k++) {
      const from = (k - 1) * per;
      const to = k * per < nPosts ? k * per : nPosts;
      const slice = [];
      for (let i = from; i < to; i++) slice.push(posts[i].card);
      vars[4] = slice;
      vars[5] = {
        number: k,
        total,
        url: k === 1 ? `${base}/` : `${base}/page/${k}/`,
        newer_url: k === 1 ? '' : k === 2 ? `${base}/` : `${base}/page/${k - 1}/`,
        older_url: k === total ? '' : `${base}/page/${k + 1}/`,
      };
      output[k === 1 ? 'index.html' : `page/${k}/index.html`] = renderPage(indexT.ops, scope);
    }
    vars[4] = undefined;
    vars[5] = undefined;
  }
  const tagT = tmpl.get('tag');
  if (tagT !== undefined) {
    for (let i = 0; i < nTags; i++) {
      const t = tagList[i];
      const tagPosts = new Array(t.posts.length);
      for (let j = 0; j < tagPosts.length; j++) tagPosts[j] = t.posts[j].card;
      vars[6] = { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: tagPosts };
      output[`tags/${t.slug}/index.html`] = renderPage(tagT.ops, scope);
    }
    vars[6] = undefined;
  }
  const tagsT = tmpl.get('tags');
  if (tagsT !== undefined) output['tags/index.html'] = renderPage(tagsT.ops, scope);
  for (let i = 0; i < statics.length; i++) {
    const f = statics[i];
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 9. The report: every line reported above and each broken link, sorted, then the counts.
  for (const line of broken) report.push(line);
  report.sort();
  report.push(`built ${pages.length - nPosts} pages, ${nPosts} posts, ${nTags} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${report.join('\n')}\n`;
  tmpl = null;
  bySource = null;
  broken = null;
  staticPaths = null;
  lkCache = null;
  incOps = null;
  forVarIds = null;
  return output;
}

