// SPDX-License-Identifier: Apache-2.0
import { Glyph } from './ui/Glyph';

export type CodeLane = {
  id: string;
  name: string;
  href: string;
  paths: { path: string; lines?: [number, number][] }[];
};
export function CodeChanges({ lanes, file }: { lanes: readonly CodeLane[]; file?: string }) {
  const visible = file ? lanes.filter(lane => lane.paths.some(path => path.path === file)) : lanes;
  if (!visible.length) return null;
  const title = file ? 'Changing this file' : 'Changing now';
  return (
    <div className={`code-changing ${file ? '' : 'code-changing-lanes'}`} aria-label={title}>
      <strong>{title}</strong>
      {visible.map(lane => (
        <a key={lane.id} href={lane.href}>
          <Glyph name="lane" size={13} />
          <span className="code-lane-name" title={lane.name}>
            {lane.name}
          </span>
          {file &&
            lane.paths
              .find(path => path.path === file)
              ?.lines?.map(([start, end]) => (
                <span key={start}>
                  L{start}–{end}
                </span>
              ))}
        </a>
      ))}
    </div>
  );
}
