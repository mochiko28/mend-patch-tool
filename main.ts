// main.ts is mend, the CLI specified in SPEC.md (MIT).
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { lstatSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';
/** SPEC.md says "surrounding spaces removed" for these paths and anchors: spaces only, not tabs. */
const trimSpaces = (s: string): string => s.replace(/^ +| +$/g, '');

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

function invalidFilesystemPath(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENAMETOOLONG' || code === 'ERR_INVALID_ARG_VALUE';
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, FileContent | null>();
  private readonly originalDirectories = new Set<string>();
  private readonly createdDirectories = new Set<string>();
  private readonly invalidPaths = new Set<string>();
  readonly now = new Map<string, FileContent | null>();
  readonly moves: { from: string; to: string }[] = [];
  original(p: string): FileContent | null {
    if (!this.orig.has(p)) {
      let v: FileContent | null = null;
      try {
        const stat = statSync(p);
        if (stat.isFile()) v = new FileContent(readFileSync(p, 'utf8'));
        else if (stat.isDirectory()) this.originalDirectories.add(p);
      } catch (error) {
        if (invalidFilesystemPath(error)) this.invalidPaths.add(p);
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  content(p: string): FileContent | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }

  requireAbsent(p: string, movingFrom?: string): void {
    if (this.content(p) !== null || this.originalDirectories.has(p) || this.createdDirectories.has(p)) {
      throw new Fail('exists', p);
    }
    if (this.invalidPaths.has(p)) throw new Fail('unsafe', p);

    const names = [basename(p)];
    let parent = dirname(p);
    while (parent !== '.') {
      if (parent !== movingFrom && this.content(parent) !== null) throw new Fail('exists', parent);
      if (this.originalDirectories.has(parent)) break;
      names.push(basename(parent));
      parent = dirname(parent);
    }
    if (names.length === 1) return;

    // A missing directory can hide an invalid name from the full-path lookup.
    // Check those names in the nearest on-disk directory, on the same filesystem.
    for (const name of names) {
      try {
        lstatSync(join(parent, name), { throwIfNoEntry: false });
      } catch (error) {
        if (invalidFilesystemPath(error)) throw new Fail('unsafe', p);
      }
    }
  }

  write(p: string, content: FileContent): void {
    this.now.set(p, content);
    for (let parent = dirname(p); parent !== '.'; parent = dirname(parent)) {
      this.createdDirectories.add(parent);
    }
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

function parseError(index: number): never {
  throw new Exit2(`error: parse ${index + 1}`);
}

function checkPath(path: string): void {
  if (!safe(path)) throw new Fail('unsafe', path);
}

function existingContent(tree: Tree, path: string): FileContent {
  const content = tree.content(path);
  if (content === null) throw new Fail('missing', path);
  return content;
}

function saveEdit(tree: Tree, from: string, to: string, content: FileContent): void {
  tree.write(to, content);
  if (from !== to) {
    tree.now.set(from, null);
    tree.moves.push({ from, to });
  }
}

type LineIndex = Map<string, Set<number>>;
const jsonSuffixLength = 4;

interface FileLines {
  lines: readonly string[];
  br: string;
  finalBreak: boolean;
}

interface SplitFile extends FileLines {
  lines: string[];
  normalized?: [(string | undefined)[]?, (string | undefined)[]?];
  indexes?: LineIndex[];
}

function lineBreak(text: string): string {
  const nl = text.indexOf('\n');
  return nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
}

function splitFile(text: string, br = lineBreak(text)): FileLines {
  const finalBreak = text.endsWith(br);
  const lines = text === '' ? [] : text.split(br);
  if (finalBreak) lines.pop();
  return { lines, br, finalBreak };
}

function joinFile(lines: readonly string[], br = '\n', finalBreak = true): string {
  return lines.length === 0 ? '' : lines.join(br) + (finalBreak ? br : '');
}

interface JsonText {
  lf: string;
  crlf: boolean;
}

/** A tree value caches representations of the same content. Edits own their working arrays. */
class FileContent {
  private raw?: string;
  private parsed?: FileLines;
  private json?: JsonText;
  private suffixes?: LineIndex;

  constructor(content: string | FileLines | JsonText) {
    if (typeof content === 'string') this.raw = content;
    else if ('lines' in content) this.parsed = content;
    else this.json = content;
  }

  static fromLines(lines: readonly string[], br = '\n', finalBreak = true): FileContent {
    if (lines.length === 0) return new FileContent('');
    const first = lines[0]!;
    if (lines.length === 1 && !finalBreak) return new FileContent(first);
    // A line edit can expose a different first break or leave a separator at EOF.
    // Cache only the split that the next edit would get from the joined text.
    if (br === '\n' ? first.endsWith('\r') : first.includes('\n')) {
      return new FileContent(joinFile(lines, br, finalBreak));
    }
    if (!finalBreak && lines.at(-1) === '') {
      return new FileContent({ lines: lines.slice(0, -1), br, finalBreak: true });
    }
    return new FileContent({ lines, br, finalBreak });
  }

  static fromJson(lf: string, crlf: boolean): FileContent {
    // With no newline the next edit will detect LF, even after a CRLF edit.
    return crlf && lf.includes('\n') ? new FileContent({ lf, crlf }) : new FileContent(lf);
  }

  text(): string {
    if (this.raw === undefined) {
      if (this.parsed !== undefined) {
        const { lines, br, finalBreak } = this.parsed;
        this.raw = joinFile(lines, br, finalBreak);
      } else {
        this.raw = this.json!.lf.replaceAll('\n', '\r\n');
      }
    }
    return this.raw;
  }

  split(): FileLines {
    if (this.parsed === undefined) {
      this.parsed = this.raw !== undefined
        ? splitFile(this.raw)
        : { ...splitFile(this.json!.lf, '\n'), br: '\r\n' };
    }
    return this.parsed;
  }

  copyLines(indexMatches = false): SplitFile {
    const file = this.split();
    return { ...file, lines: file.lines.slice(), indexes: indexMatches ? [] : undefined };
  }

  jsonText(): JsonText {
    if (this.json === undefined) {
      const text = this.text();
      const crlf = lineBreak(text) === '\r\n';
      this.json = { lf: crlf ? text.replaceAll('\r\n', '\n') : text, crlf };
    }
    return this.json;
  }

  replaceJsonSuffix(path: string, oldSuffix: string, newSuffix: string): FileContent | undefined {
    if (this.suffixes === undefined) {
      if (this.json?.crlf) return undefined;
      const text = this.text();
      if (text.length < 65536 || text.includes('\r')) return undefined;
      const { lines, finalBreak } = this.split();
      const suffixes: LineIndex = new Map();
      const count = lines.length - (finalBreak ? 0 : 1);
      for (let i = 0; i < count; i += 1) {
        addLinePosition(suffixes, lines[i]!.slice(-jsonSuffixLength), i);
      }
      this.suffixes = suffixes;
    }
    const key = oldSuffix.slice(-jsonSuffixLength);
    const { lines, br, finalBreak } = this.split();
    let at: number | undefined;
    for (const i of this.suffixes.get(key) ?? []) {
      if (!lines[i]!.endsWith(oldSuffix)) continue;
      if (at !== undefined) throw new Fail('ambiguous', path);
      at = i;
    }
    if (at === undefined) throw new Fail('no-match', path);

    const line = lines[at]!;
    const written = line.slice(0, line.length - oldSuffix.length) + newSuffix;
    const updated = lines.slice();
    updated[at] = written;
    const result = FileContent.fromLines(updated, br, finalBreak);
    // The old value keeps its lines and can rebuild the index if needed.
    result.suffixes = this.suffixes;
    this.suffixes = undefined;
    moveLinePosition(result.suffixes, key, written.slice(-jsonSuffixLength), at);
    return result;
  }
}

const leadingIndent = (line: string): string => /^[ \t]*/.exec(line)![0];
const trimTrailing = (line: string): string => line.replace(/[ \t]+$/, '');
const trimIndent = (line: string): string => trimTrailing(line.slice(leadingIndent(line).length));
const lineNormalizers = [(line: string) => line, trimTrailing, trimIndent];

function addLinePosition(index: LineIndex, line: string, at: number): void {
  let positions = index.get(line);
  if (positions === undefined) {
    positions = new Set();
    index.set(line, positions);
  }
  positions.add(at);
}

function moveLinePosition(index: LineIndex, before: string, after: string, at: number): void {
  if (before === after) return;
  const positions = index.get(before)!;
  positions.delete(at);
  if (positions.size === 0) index.delete(before);
  addLinePosition(index, after, at);
}

function findMatches(
  file: SplitFile, old: string[], strict: boolean, start = 0, end = file.lines.length - old.length,
): { positions: number[]; tier: number } | null {
  if (start > end) return null;
  const { lines } = file;
  for (let tier = 0; tier < (strict ? 1 : lineNormalizers.length); tier += 1) {
    const normalize = lineNormalizers[tier]!;
    const cache = tier === 0 ? undefined : (file.normalized ??= []);
    const before = cache === undefined ? lines : (cache[tier - 1] ??= new Array<string | undefined>(lines.length));
    const wanted = tier === 0 ? old : old.map(normalize);
    const first = wanted[0];
    const positions: number[] = [];
    const matchesRest = (at: number): boolean => {
      for (let offset = 1; offset < wanted.length; offset += 1) {
        const i = at + offset;
        if (wanted[offset] !== (before[i] ?? (before[i] = normalize(lines[i]!)))) return false;
      }
      return true;
    };
    if (file.indexes !== undefined && first !== undefined) {
      let index = file.indexes[tier];
      if (index === undefined) {
        index = new Map();
        for (let i = 0; i < lines.length; i += 1) {
          addLinePosition(index, before[i] ?? (before[i] = normalize(lines[i]!)), i);
        }
        file.indexes[tier] = index;
      }
      for (const at of index.get(first) ?? []) {
        if (at >= start && at <= end && matchesRest(at)) positions.push(at);
      }
      positions.sort((a, b) => a - b);
    } else if (tier === 0 && first !== undefined && end === lines.length - wanted.length) {
      for (let at = lines.indexOf(first, start); at !== -1 && at <= end; at = lines.indexOf(first, at + 1)) {
        if (matchesRest(at)) positions.push(at);
      }
    } else {
      for (let at = start; at <= end; at += 1) {
        if (first !== undefined && first !== (before[at] ?? (before[at] = normalize(lines[at]!)))) continue;
        if (matchesRest(at)) positions.push(at);
      }
    }
    if (positions.length > 0) return { positions, tier };
  }
  return null;
}

interface ReplacementLine {
  text: string;
  context?: number;
  noNewline?: boolean;
}

interface LineChange {
  old: string[];
  replacement: ReplacementLine[];
}

function readLineChange(lines: string[], start: number, end: number): LineChange {
  const old: string[] = [];
  const replacement: ReplacementLine[] = [];
  for (let i = start; i < end; i += 1) {
    const line = lines[i]!;
    const text = line.slice(1);
    const noNewline = i + 1 < end && lines[i + 1]!.startsWith('\\');
    if (line.startsWith('-')) old.push(text);
    else if (line.startsWith('+')) replacement.push({ text, noNewline });
    else if (!line.startsWith('\\')) {
      replacement.push({ text, context: old.length, noNewline });
      old.push(text);
    }
  }
  return { old, replacement };
}

function replaceLines(file: SplitFile, change: LineChange, at: number, tier: number): void {
  const { lines, normalized } = file;
  const fileIndent = tier === 2 ? leadingIndent(lines[at]!) : '';
  const patchIndent = tier === 2 ? leadingIndent(change.old[0]!) : '';
  const written = change.replacement.map(({ text, context }) => {
    if (context !== undefined) return lines[at + context]!;
    if (tier === 2 && !blank(text) && text.startsWith(patchIndent)) {
      return fileIndent + text.slice(patchIndent.length);
    }
    return text;
  });
  if (file.indexes !== undefined) {
    for (let tier = 0; tier < file.indexes.length; tier += 1) {
      const index = file.indexes[tier]!;
      const normalize = lineNormalizers[tier]!;
      for (let offset = 0; offset < written.length; offset += 1) {
        const i = at + offset;
        if (lines[i] === written[offset]) continue;
        moveLinePosition(index, normalize(lines[i]!), normalize(written[offset]!), i);
      }
    }
  }
  // Limit spread arguments even when an edit inserts a very large block.
  const batchSize = 16384;
  lines.splice(at, change.old.length, ...written.slice(0, batchSize));
  for (let offset = batchSize; offset < written.length; offset += batchSize) {
    lines.splice(at + offset, 0, ...written.slice(offset, offset + batchSize));
  }
  if (normalized !== undefined) {
    for (const cache of normalized) {
      if (cache === undefined) continue;
      if (written.length === change.old.length) cache.fill(undefined, at, at + written.length);
      else cache.length = at;
    }
  }
}

function indexBatch(changes: LineChange[]): boolean {
  // Only build indexes when enough searches can reuse stable line positions.
  return changes.length >= 16 && changes.every((change) => change.old.length === change.replacement.length);
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const markers = lines.map((line) => line.trimEnd());
  let candidate: string | undefined;
  let previousPath: string | undefined;
  for (let i = 0; i < lines.length; i += 1) {
    if (markers[i] !== '<<<<<<< SEARCH') {
      const line = lines[i]!.trim();
      if (line !== '' && !line.startsWith('```')) candidate = line;
      continue;
    }
    const path = candidate ?? previousPath;
    const separator = markers.indexOf('=======', i + 1);
    const end = separator === -1 ? -1 : markers.indexOf('>>>>>>> REPLACE', separator + 1);
    if (path === undefined || end === -1) parseError(i);
    const old = lines.slice(i + 1, separator);
    const replacement = lines.slice(separator + 1, end);
    const change = { old, replacement: replacement.map((text) => ({ text })) };
    edits.push((tree) => {
      checkPath(path);
      if (old.length === 0) {
        tree.requireAbsent(path);
        tree.write(path, FileContent.fromLines(replacement));
        return;
      }
      const file = existingContent(tree, path).copyLines();
      const match = findMatches(file, old, strict);
      if (match === null) throw new Fail('no-match', path);
      if (match.positions.length > 1) throw new Fail('ambiguous', path);
      replaceLines(file, change, match.positions[0]!, match.tier);
      tree.now.set(path, FileContent.fromLines(file.lines, file.br, file.finalBreak));
    });
    previousPath = path;
    candidate = undefined;
    i = end;
  }
  return edits;
}

interface UnifiedHunk extends LineChange {
  start: number;
}

type DiffPaths = [string | null, string | null];

interface UnifiedSection {
  gitPaths?: DiffPaths;
  headerPaths?: DiffPaths;
  renameFrom?: string;
  renameTo?: string;
  create?: boolean;
  delete?: boolean;
  hunks: UnifiedHunk[];
}

function diffHeaderPath(line: string): string | null {
  const path = trimSpaces(line.slice(4).split('\t', 1)[0]!);
  return path === '/dev/null' ? null : path.replace(/^[ab]\//, '');
}

function isDiffHeaderPair(lines: string[], at: number): boolean {
  return lines[at]!.startsWith('--- ') && (lines[at + 1] ?? '').startsWith('+++ ');
}

function unifiedEdit(section: UnifiedSection, strict: boolean): Edit {
  const [from, to] = section.headerPaths ?? [
    section.renameFrom ?? section.gitPaths![0], section.renameTo ?? section.gitPaths![1],
  ];
  return (tree) => {
    if (from !== null) checkPath(from);
    if (to !== null) checkPath(to);
    if (from === null || section.create) {
      const path = to ?? '';
      checkPath(path);
      tree.requireAbsent(path);
      const additions = section.hunks.flatMap((hunk) => hunk.replacement.filter((line) => line.context === undefined));
      tree.write(path, FileContent.fromLines(additions.map((line) => line.text), '\n', !additions.at(-1)?.noNewline));
      return;
    }
    const before = existingContent(tree, from);
    if (to === null || section.delete) {
      tree.now.set(from, null);
      return;
    }
    if (from !== to) tree.requireAbsent(to, from);
    const file = before.copyLines(indexBatch(section.hunks));
    let delta = 0;
    for (const hunk of section.hunks) {
      const { old, replacement } = hunk;
      let at = Math.max(0, Math.min(file.lines.length, hunk.start + delta));
      let tier = 0;
      if (old.length > 0) {
        const target = Math.max(0, Math.min(file.lines.length, hunk.start - 1 + delta));
        if (old.every((line, offset) => file.lines[target + offset] === line)) {
          at = target;
        } else {
          const match = findMatches(file, old, strict);
          if (match === null) throw new Fail('no-match', from);
          at = match.positions[0]!;
          for (const position of match.positions) {
            if (Math.abs(position - target) < Math.abs(at - target)) at = position;
          }
          tier = match.tier;
        }
      }
      if (at + old.length === file.lines.length) file.finalBreak = !replacement.at(-1)?.noNewline;
      replaceLines(file, hunk, at, tier);
      delta += replacement.length - old.length;
    }
    saveEdit(tree, from, to, FileContent.fromLines(file.lines, file.br, file.finalBreak));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  let section: UnifiedSection | undefined;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (/^diff --git(?:\s|$)/.test(line)) {
      const paths = /^diff --git a\/(.+?) b\/(.+)$/s.exec(line);
      if (paths === null) parseError(i);
      section = { gitPaths: [paths[1]!, paths[2]!], hunks: [] };
      sections.push(section);
    } else if (isDiffHeaderPair(lines, i)) {
      const headerPaths: DiffPaths = [diffHeaderPath(line), diffHeaderPath(lines[i + 1]!)];
      if (section === undefined || section.headerPaths !== undefined || section.hunks.length > 0) {
        section = { headerPaths, hunks: [] };
        sections.push(section);
      } else section.headerPaths = headerPaths;
      i += 1;
    } else if (line.startsWith('@@')) {
      const header = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
      if (section === undefined || header === null) parseError(i);
      let end = i + 1;
      while (end < lines.length && (lines[end] === '' || /^[ +\\-]/.test(lines[end]!)) && !isDiffHeaderPair(lines, end)) {
        end += 1;
      }
      let bodyEnd = end;
      while (bodyEnd > i + 1 && lines[bodyEnd - 1] === '') bodyEnd -= 1;
      section.hunks.push({ start: Number(header[1]), ...readLineChange(lines, i + 1, bodyEnd) });
      i = end - 1;
    } else if (section !== undefined && section.hunks.length === 0) {
      if (line.startsWith('--- ')) parseError(i + 1);
      if (line.startsWith('rename from ')) section.renameFrom = line.slice('rename from '.length);
      if (line.startsWith('rename to ')) section.renameTo = line.slice('rename to '.length);
      if (line === 'new file mode' || line.startsWith('new file mode ')) section.create = true;
      if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) section.delete = true;
    }
  }
  return sections.map((item) => unifiedEdit(item, strict));
}

interface V4aChunk extends LineChange {
  anchor: string;
  eof: boolean;
}

function v4aUpdate(lines: string[], start: number, end: number, path: string, strict: boolean): Edit {
  const movePrefix = '*** Move to: ';
  const hasMove = start + 1 < end && lines[start + 1]!.startsWith(movePrefix);
  const to = hasMove ? trimSpaces(lines[start + 1]!.slice(movePrefix.length)) : path;
  const chunks: V4aChunk[] = [];
  let i = start + (hasMove ? 2 : 1);
  const isBody = (line: string): boolean => line === '' || /^[ +-]/.test(line);
  while (i < end) {
    let anchor = '';
    if (lines[i]!.startsWith('@@')) {
      anchor = trimSpaces(lines[i]!.slice(2));
      i += 1;
    } else if (chunks.length > 0 || !isBody(lines[i]!)) parseError(i);
    const bodyStart = i;
    while (i < end && isBody(lines[i]!)) i += 1;
    const eof = i < end && lines[i] === '*** End of File';
    chunks.push({ anchor, eof, ...readLineChange(lines, bodyStart, i) });
    if (eof) i += 1;
  }
  if (chunks.length === 0 && !hasMove) parseError(start);
  return (tree) => {
    checkPath(path);
    if (hasMove) checkPath(to);
    const file = existingContent(tree, path).copyLines(indexBatch(chunks));
    if (hasMove) tree.requireAbsent(to, path);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== '') {
        const match = findMatches(file, [chunk.anchor], strict, cursor);
        if (match === null) throw new Fail('no-match', path);
        cursor = match.positions[0]! + 1;
      }
      let at = chunk.eof ? file.lines.length : cursor;
      let tier = 0;
      if (chunk.old.length > 0) {
        const lastStart = file.lines.length - chunk.old.length;
        const match = findMatches(file, chunk.old, strict, chunk.eof ? Math.max(cursor, lastStart) : cursor, lastStart);
        if (match === null) throw new Fail('no-match', path);
        at = match.positions[0]!;
        tier = match.tier;
      }
      replaceLines(file, chunk, at, tier);
      cursor = at + chunk.replacement.length;
    }
    saveEdit(tree, path, to, FileContent.fromLines(file.lines, file.br, file.finalBreak));
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((line) => !blank(line));
  if (first < 0 || lines[first]!.trim() !== '*** Begin Patch') parseError(Math.max(0, first));
  const last = lines.findLastIndex((line) => !blank(line));
  if (lines[last]!.trim() !== '*** End Patch') parseError(lines.length);
  const sectionHeader = /^\*\*\* (Add|Delete|Update) File: /;
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    const header = sectionHeader.exec(lines[i]!);
    if (header === null) parseError(i);
    const path = trimSpaces(lines[i]!.slice(header[0].length));
    let next = i + 1;
    while (next < last && !sectionHeader.test(lines[next]!)) next += 1;
    let end = next;
    while (end > i + 1 && blank(lines[end - 1]!)) end -= 1;
    if (header[1] === 'Add') {
      const added: string[] = [];
      for (let j = i + 1; j < end; j += 1) {
        const line = lines[j]!;
        if (line !== '' && !line.startsWith('+')) parseError(j);
        added.push(line.slice(1));
      }
      edits.push((tree) => {
        checkPath(path);
        tree.requireAbsent(path);
        tree.write(path, FileContent.fromLines(added));
      });
    } else if (header[1] === 'Delete') {
      if (end > i + 1) parseError(i + 1);
      edits.push((tree) => {
        checkPath(path);
        existingContent(tree, path);
        tree.now.set(path, null);
      });
    } else edits.push(v4aUpdate(lines, i, end, path, strict));
    i = next;
  }
  return edits;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): FileContent => {
    checkPath(p);
    return existingContent(tree, p);
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      checkPath(p);
      tree.requireAbsent(p);
      tree.write(p, new FileContent(text));
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    // In LF text this search can only match a line suffix, and the edit keeps line positions.
    const replaceSuffix = oldStr.length > jsonSuffixLength && oldStr.indexOf('\n') === oldStr.length - 1
      && newStr.endsWith('\n') && newStr.indexOf('\n') === newStr.length - 1 && !newStr.includes('\r');
    return (tree) => {
      const content = exists(tree);
      const indexed = replaceSuffix ? content.replaceJsonSuffix(p, oldStr.slice(0, -1), newStr.slice(0, -1)) : undefined;
      if (indexed !== undefined) {
        tree.now.set(p, indexed);
        return;
      }
      const { lf: t, crlf } = content.jsonText();
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const old = lf(oldStr);
      const at = t.indexOf(old);
      if (at < 0) throw new Fail('no-match', p);
      if (t.indexOf(old, at + 1) >= 0) throw new Fail('ambiguous', p);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, FileContent.fromJson(out, crlf));
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const { lines, br, finalBreak } = exists(tree).split();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      const result = lines.slice(0, line).concat(add, lines.slice(line));
      tree.now.set(p, FileContent.fromLines(result, br, finalBreak));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    switch (kind) {
      case 'json': edits = jsonEdits(text, lines); break;
      case 'unified': edits = unifiedEdits(lines, strict); break;
      case 'search-replace': edits = searchReplaceEdits(lines, strict); break;
      case 'v4a': edits = v4aEdits(lines, strict); break;
      default: edits = [];
    }
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const renamedFrom = new Set<string>();
  const renamedTo = new Map<string, string>();
  for (const { from, to } of tree.moves) {
    if (renamedFrom.has(from) || renamedTo.has(to)) continue;
    if (tree.original(from) !== null && tree.content(from) === null && tree.original(to) === null && tree.content(to) !== null) {
      renamedFrom.add(from);
      renamedTo.set(to, from);
    }
  }
  const rows: string[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p)?.text() ?? null;
    const now = tree.content(p)?.text() ?? null;
    if (was === now) continue;
    const from = renamedTo.get(p);
    if (from !== undefined) rows.push(`R ${from} -> ${p}`);
    else if (!renamedFrom.has(p)) rows.push(`${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
