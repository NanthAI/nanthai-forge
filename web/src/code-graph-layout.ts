// SPDX-License-Identifier: Apache-2.0
import type { PointNode } from './graph-model';

export function codeGraphLayout(nodes: readonly PointNode[], availableWidth: number, minimumHeight = 480) {
  const width = Math.max(280, availableWidth);
  const columns = Math.max(1, Math.min(3, Math.floor((width - 32) / 270)));
  const columnWidth = (width - 32) / columns;
  const cardWidth = columnWidth - 44;
  const groups = new Map<string, PointNode[]>();
  for (const node of nodes) {
    const folder = node.folder ?? (node.id.includes('/') ? node.id.split('/')[0]! : 'Root');
    groups.set(folder, [...(groups.get(folder) ?? []), node]);
  }
  const heights = Array.from({ length: columns }, () => 16);
  const positions = new Map<string, { x: number; y: number }>();
  const panels = [...groups].map(([folder, files], index) => {
    const column = index % columns;
    const x = 16 + column * columnWidth,
      y = heights[column]!,
      height = 42 + files.length * 58;
    heights[column] = y + height + 16;
    files.forEach((file, row) => positions.set(file.id, { x: x + 14, y: y + 32 + row * 58 }));
    return { folder, x, y, height, width: columnWidth - 16 };
  });
  return { width, height: Math.max(minimumHeight, ...heights), cardWidth, panels, positions };
}

export function codeGraphEdge(
  a: { x: number; y: number; width?: number },
  b: { x: number; y: number; width?: number },
  cardWidth: number,
) {
  if (a.x === b.x) {
    const right = a.x + (a.width ?? cardWidth),
      end = b.x + (b.width ?? cardWidth),
      bend = Math.max(right, end) + 10;
    return `M${right} ${a.y + 21} C${bend} ${a.y + 21}, ${bend} ${b.y + 21}, ${end} ${b.y + 21}`;
  }
  const forward = a.x < b.x;
  const start = a.x + (forward ? (a.width ?? cardWidth) : 0),
    end = b.x + (forward ? 0 : (b.width ?? cardWidth));
  const middle = (start + end) / 2;
  return `M${start} ${a.y + 21} C${middle} ${a.y + 21}, ${middle} ${b.y + 21}, ${end} ${b.y + 21}`;
}
