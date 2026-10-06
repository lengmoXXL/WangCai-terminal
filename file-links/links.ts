import { computeLink } from 'xterm-link-provider';
import type { IBufferCellPosition, IBufferRange, Terminal } from '@xterm/xterm';
import type { FileClick } from '@wangcai/sdk';

type FileLocation = Pick<FileClick, 'path' | 'line' | 'column'>;

// The line and column shapes an editor, a compiler and a stack trace print, taken from VS Code's
// terminal link parsing (MIT, Copyright (c) Microsoft Corporation), see
// src/vs/workbench/contrib/terminalContrib/links/browser/terminalLinkParsing.ts. A quote stands in
// for a bracket, and every shape may end the line. The clauses number their groups, so the first
// one that matched holds the line and column.
function suffixClause() {
  let row = 0;
  let column = 0;
  let rowEnd = 0;
  let columnEnd = 0;
  const r = () => `(?<row${row++}>\\d+)`;
  const c = () => `(?<column${column++}>\\d+)`;
  const re = () => `(?<rowEnd${rowEnd++}>\\d+)`;
  const ce = () => `(?<columnEnd${columnEnd++}>\\d+)`;
  return [
    // a.ts:12, a.ts:12:3, a.ts:12-14.16, a.ts.12, a.ts#12, a.ts 12, "a.ts",12
    `(?::|#| |['"],|, )${r()}([:.]${c()}(?:-(?:${re()}\\.)?${ce()})?)?`,
    // "a.ts", line 12, column 3 / "a.ts" on line 12 / "a.ts" lines 12-14, characters 3-5
    `['"]?(?:,? |: ?| on )lines? ${r()}(?:-${re()})?(?:,? (?:col(?:umn)?|characters?) ${c()}(?:-${ce()})?)?`,
    // a.ts(12), a.ts(12,3), a.ts(12:3), a.ts: (12)
    `:? ?[[(]${r()}(?:(?:, ?|:)${c()})?[)\\]]`,
  ]
    .join('|')
    // VS Code allows a non-breaking space wherever the clauses above allow a space.
    .replace(/ /g, `[${'\u00A0'} ]`);
}

// A path character: a letter, a mark or a digit of any alphabet, and the punctuation a path
// holds. Nothing else, so a space, a bracket or a separator closes a part of the path, and the
// punctuation printed around one stays outside it. A candidate wider than the path is one the
// filesystem can only reject whole, so a path printed inside a sentence would lose its link.
const character = '[\\p{L}\\p{M}\\p{N}._~+@%$-]';
const separator = String.raw`[\\/]`;
const dotOrSeparator = String.raw`[.\\/]`;
const rest = `(?:${character}|${separator})*`;
const drive = String.raw`(?:file:\/\/\/?|[A-Za-z]:)?`;
const build = String.raw`[A-Z][A-Z\d_-]+|Makefile|Dockerfile|Justfile|Gemfile`;
// A path that a line and column follows: it holds a dot or a separator, or it is quoted.
const named = `(?:["'][^"']+["']|${drive}(?!-)(?:${character}*(?:${dotOrSeparator}${rest})|(?:${build})))`;
// A path on its own: it holds a separator, or it is a quoted name with a dot in it, or a name a
// build tool prints on its own.
const alone = `(?:${drive}(?!-)(?:${character}*${separator}+)+${character}+|${build}|"[^"]*${dotOrSeparator}[^"]*"|'[^']*${dotOrSeparator}[^']*')`;

const source = `(?<![\\w\\-./\\\\~:])(?<link>(?:(?<path>${named})(?:${suffixClause()})|(?<alone>${alone})))`;
// What a line of output is scanned for, and what a single piece of text is read as.
const scan = new RegExp(source, 'gu');
const parse = new RegExp(`^${source}`, 'u');
// A name that looks like a file even though nothing around it marks it as one: it holds a dot, as
// `sample.ts` printed on its own does. Whether it exists decides if it becomes a link.
const word = new RegExp(String.raw`(?<![\w.\\/~:-])[\p{L}\p{N}._-]*\.[\p{L}\p{N}._-]+`, 'gu');

/** What the text points at, or nothing when it is not a location. */
export function fileLocation(text: string): FileLocation | undefined {
  if (text.startsWith('file://')) {
    // A URL escapes the spaces a plain path cannot hold, so it is read as a path of its own.
    try {
      const pathname = decodeURIComponent(new URL(text).pathname);
      const suffix = /:(\d+)(?::(\d+))?$/.exec(pathname);
      return {
        path: suffix ? pathname.slice(0, -suffix[0].length) : pathname,
        line: suffix ? Number(suffix[1]) : undefined,
        column: suffix?.[2] ? Number(suffix[2]) : undefined,
      };
    } catch { return; }
  }
  const groups = parse.exec(text)?.groups;
  if (!groups) return;
  return {
    path: (groups.path ?? groups.alone).replace(/^["']|["']$/g, ''),
    line: firstGroup(groups, 'row'),
    column: firstGroup(groups, 'column'),
  };
}

function firstGroup(groups: Record<string, string | undefined>, kind: string) {
  // One clause matches at most, so at most one index of a kind is set; the indices a pattern never
  // declared are missing from the groups object, which is what ends the scan.
  for (let i = 0; `${kind}${i}` in groups; i++) {
    const value = groups[`${kind}${i}`];
    if (value) return Number(value);
  }
  return undefined;
}

/** The most paths one line may hand to the plugin, as VS Code limits them as well. */
const maxPaths = 10;
/** How long a line keeps the answer it was given, as VS Code keeps the links of a line as well. */
const cacheTtl = 10_000;
/** The longest path worth resolving. */
const maxPathLength = 1024;

interface FileLinks {
  /** Which of these paths exist, and the absolute path each one resolves to. */
  resolve(paths: string[]): Promise<Record<string, string>>;
  /** Open what was clicked. */
  activate(path: string, line?: number, column?: number): void;
}

export function registerFileLinks(term: Terminal, files: FileLinks) {
  // An OSC 8 link hands over its target as text, which is read the same way a printed one is.
  term.options.linkHandler = {
    allowNonHttpProtocols: true,
    activate: (_, text) => {
      const location = fileLocation(text);
      if (location) files.activate(location.path, location.line, location.column);
    },
  };

  // What a line was told about its paths, and the look that is on its way. xterm asks for a line
  // again whenever it changes or the pointer returns to it, and answering that from here is what
  // keeps the underline of a line still.
  const known = new Map<string, Record<string, string>>();
  const pending = new Map<string, Promise<Record<string, string>>>();
  let knownUntil = 0;
  const ask = (text: string, paths: string[]) => {
    const onTheWay = pending.get(text);
    if (onTheWay) return onTheWay;
    const look = files.resolve(paths)
      .then((resolved) => {
        known.set(text, resolved);
        return resolved;
      })
      // A failed look keeps whatever the line already knew, so a hiccup does not blink a link.
      .catch((): Record<string, string> => known.get(text) ?? ({}))
      .finally(() => pending.delete(text));
    pending.set(text, look);
    return look;
  };

  return term.registerLinkProvider({
    provideLinks(y, callback) {
      const found = candidates(term, y);
      if (!found.length) return callback([]);
      const text = rowText(term, y);
      if (Date.now() > knownUntil) {
        known.clear();
        knownUntil = Date.now() + cacheTtl;
      }
      const remembered = known.get(text);
      const answer = (resolved: Record<string, string>) => {
        // The line may have been rewritten while the answer was on its way.
        if (rowText(term, y) !== text) return callback([]);
        callback(found
          .filter(candidate => resolved[candidate.path])
          .map(candidate => ({
            range: candidate.range,
            text: candidate.text,
            activate: () => files.activate(resolved[candidate.path], candidate.line, candidate.column),
          })));
      };
      if (remembered) return answer(remembered);
      const paths = [...new Set(found.map(candidate => candidate.path))]
        .filter(path => path.length <= maxPathLength)
        .slice(0, maxPaths);
      void ask(text, paths).then(answer);
    },
  });
}

// What one row holds, which is what a line is remembered by. Joining a wrapped line is what
// computeLink does, so a row on its own is enough to tell two lines apart.
function rowText(term: Terminal, y: number) {
  return term.buffer.active.getLine(y - 1)?.translateToString(true) ?? '';
}

// Every path the line holds, and every name in it that looks like a file. The plugin answers which
// of them exist, which is what keeps a word that happens to hold a dot from becoming a link. Two
// readings of one name can share cells and disagree in width — the build-name rule reads `INSTALL`
// inside `INSTALL.md` — so the wider reading is the one the line printed, and a path leads where two
// readings are equally wide. The paths come first, and their order is what breaks that tie.
function candidates(term: Terminal, y: number) {
  const found = [
    ...computeLink(y, scan, term).map(({ range, text }) => {
      const location = fileLocation(text);
      return { range, text, path: location?.path ?? text, line: location?.line, column: location?.column };
    }),
    // The word regex captures nothing, so the link is its whole match.
    ...computeLink(y, word, term, 0).map(({ range, text }) => ({ range, text, path: text, line: undefined, column: undefined })),
  ];
  return found.filter((candidate, at) => !found.some((other, index) =>
    holds(other.range, candidate.range) && (!holds(candidate.range, other.range) || index < at)));
}

// Whether a point sits at or before another, so ranges can be compared cell by cell.
function upTo(point: IBufferCellPosition, end: IBufferCellPosition) {
  return point.y < end.y || (point.y === end.y && point.x <= end.x);
}

// Whether one range covers another whole, which is what makes it the wider reading of those cells.
function holds(outer: IBufferRange, inner: IBufferRange) {
  return upTo(outer.start, inner.start) && upTo(inner.end, outer.end);
}
