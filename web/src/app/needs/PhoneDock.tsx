// SPDX-License-Identifier: Apache-2.0
import { Menu, useDockLayout, type DockLayout, type DockRegion } from '../../ds';
import { Announcer, useAnnounce } from '../../ds/behaviour/announce';

const DEFAULT: DockLayout = { top: ['needs', 'flow', 'fyi', 'loose'], a: [], b: [] };

/** A phone has one column. Keep its controls in normal Tab order and reuse the dock's move menu. */
export function PhoneDock({ label, regions }: { label: string; regions: readonly DockRegion[] }) {
  const [layout, save, reset] = useDockLayout('needs-me-phone', DEFAULT);
  const [message, announce] = useAnnounce();
  const byId = new Map(regions.map(region => [region.id, region]));
  const order = [...layout.top, ...layout.a, ...layout.b];
  return (
    <div className="dock" role="group" aria-label={label} data-dock="">
      {order.map((id, index) => {
        const region = byId.get(id)!;
        const move = (to: number) => {
          const next = order.filter(other => other !== id);
          next.splice(to, 0, id);
          save({ ...DEFAULT, top: next });
          announce(`Moved ${region.title}, position ${to + 1} of ${next.length}.`);
        };
        return (
          <div key={id}>
            {region.render(
              <Menu
                label={`Move ${region.title}`}
                className="grip"
                focusKey={`drag-${id}`}
                items={[
                  { id: 'up', label: 'Up one', disabled: index === 0, onAction: () => move(index - 1) },
                  {
                    id: 'down',
                    label: 'Down one',
                    disabled: index === order.length - 1,
                    onAction: () => move(index + 1),
                  },
                  { id: 'top', label: 'Move to top', disabled: index === 0, onAction: () => move(0) },
                  {
                    id: 'bottom',
                    label: 'Move to bottom',
                    disabled: index === order.length - 1,
                    onAction: () => move(order.length - 1),
                  },
                  'separator',
                  {
                    id: 'reset',
                    label: 'Reset layout',
                    onAction: () => {
                      reset();
                      announce('Layout reset.');
                    },
                  },
                ]}
              >
                <svg width="10" height="16" viewBox="0 0 10 16" aria-hidden="true" fill="currentColor">
                  {[3, 8, 13].map(y => (
                    <g key={y}>
                      <circle cx="2.5" cy={y} r="1.4" />
                      <circle cx="7.5" cy={y} r="1.4" />
                    </g>
                  ))}
                </svg>
              </Menu>,
            )}
          </div>
        );
      })}
      <Announcer message={message} />
    </div>
  );
}
