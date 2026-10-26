// SPDX-License-Identifier: Apache-2.0
import { parser } from '@lezer/javascript';
import { attentionRank, toneLabel, type Tone } from './ui/status';

/** One open Lane touching files on the Code page, with its attention tone. */
export type TouchLane = {
  id: string;
  name: string;
  /** Who holds the Lane; the Lane name when nobody does. */
  holder: string;
  agent: boolean;
  /** What the Lane is for (its Intent outcome). */
  what: string;
  saves: number;
  tone: Tone;
  href: string;
  paths: readonly string[];
};
export type Touch = { tone: Tone; lanes: string[] };
type LaneInput = { id: string; head: string; assignment?: string };
type ViewInput = { id: string; inputs?: readonly { laneId: string; head?: string }[] };
type RunInput = { viewId: string; status: string; startedAt?: string };

/** The Lane's attention word from its latest Candidate check, else whether someone holds it. */
export function laneTone(lane: LaneInput, views: readonly ViewInput[], runs: readonly RunInput[]): Tone {
  const ids = new Set(
    views
      .filter(view =>
        view.inputs?.some(input => input.laneId === lane.id && (!input.head || input.head === lane.head)),
      )
      .map(view => view.id),
  );
  const run = runs
    .filter(run => ids.has(run.viewId))
    .sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''))
    .at(-1);
  if (run?.status === 'failed') return 'failed';
  if (run?.status === 'passed') return 'passed';
  if (run && ['queued', 'preparing', 'running'].includes(run.status)) return 'running';
  return lane.assignment?.trim() ? 'active' : 'stale';
}

const urgent = (a: Tone, b: Tone) => (attentionRank[a] <= attentionRank[b] ? a : b);

/** Tree dots: every touched file and each folder above it (`dir/`), coloured by the most urgent Lane. */
export function treeTouches(lanes: readonly TouchLane[]): Map<string, Touch> {
  const touches = new Map<string, Touch>();
  const add = (key: string, lane: TouchLane) => {
    const touch = touches.get(key);
    if (!touch) touches.set(key, { tone: lane.tone, lanes: [lane.name] });
    else if (!touch.lanes.includes(lane.name)) {
      touch.tone = urgent(touch.tone, lane.tone);
      touch.lanes.push(lane.name);
    }
  };
  for (const lane of lanes)
    for (const path of lane.paths) {
      add(path, lane);
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++) add(`${parts.slice(0, i).join('/')}/`, lane);
    }
  return touches;
}

export function touchTitle(touch: Touch): string {
  return `${touch.lanes.length === 1 ? 'Open Lane' : 'Open Lanes'}: ${touch.lanes.join(', ')} (${toneLabel[touch.tone]})`;
}

type Hunk = { afterStart: number; lines: readonly { kind: string }[] };
/** Added or changed lines on the Lane's side of each hunk, as inclusive ranges. */
export function changedLines(hunks: readonly Hunk[]): [number, number][] {
  const ranges: [number, number][] = [];
  for (const hunk of hunks) {
    let line = hunk.afterStart;
    for (const { kind } of hunk.lines) {
      if (kind === 'added') {
        const last = ranges.at(-1);
        if (last && last[1] >= line - 1) last[1] = line;
        else ranges.push([line, line]);
      }
      if (kind !== 'removed') line++;
    }
  }
  return ranges;
}

export function rangeLabel(ranges: readonly (readonly [number, number])[]): string {
  return ranges.map(([start, end]) => (start === end ? `L${start}` : `L${start}–${end}`)).join(', ');
}

export type CodeSymbol = {
  kind: 'fn' | 'class' | 'type' | 'const' | 'var' | 'enum';
  name: string;
  line: number;
};
const KINDS: Record<string, CodeSymbol['kind']> = {
  FunctionDeclaration: 'fn',
  ClassDeclaration: 'class',
  TypeAliasDeclaration: 'type',
  InterfaceDeclaration: 'type',
  EnumDeclaration: 'enum',
};

/** Top-level JS/TS declarations of one source page; other languages have none. */
export function fileSymbols(file: string, text: string, firstLine = 1): CodeSymbol[] {
  if (!/\.[cm]?[jt]sx?$/.test(file)) return [];
  const symbols: CodeSymbol[] = [];
  const lineAt = (offset: number) => firstLine + text.slice(0, offset).split('\n').length - 1;
  const top = parser.configure({ dialect: 'ts jsx' }).parse(text).topNode;
  for (let node = top.firstChild; node; node = node.nextSibling) {
    let declaration = node.name === 'ExportDeclaration' ? node.firstChild : node;
    while (declaration && declaration !== node && !declaration.name.endsWith('Declaration'))
      declaration = declaration.nextSibling;
    if (!declaration) continue;
    const kind = KINDS[declaration.name];
    if (kind) {
      const name = declaration.getChild('VariableDefinition') ?? declaration.getChild('TypeDefinition');
      if (name) symbols.push({ kind, name: text.slice(name.from, name.to), line: lineAt(name.from) });
    } else if (declaration.name === 'VariableDeclaration') {
      const constant = text.slice(declaration.from, declaration.to).startsWith('const');
      for (const name of declaration.getChildren('VariableDefinition')) {
        const value = name.nextSibling?.nextSibling;
        symbols.push({
          kind:
            value && ['ArrowFunction', 'FunctionExpression'].includes(value.name)
              ? 'fn'
              : constant
                ? 'const'
                : 'var',
          name: text.slice(name.from, name.to),
          line: lineAt(name.from),
        });
      }
    }
  }
  return symbols;
}
