// SPDX-License-Identifier: Apache-2.0
/** The living Forge F (64 geometry). Poses and motion: ./mark.css and DESIGN.md "Brand mark states". Brand rights: assets/NOTICE.md. */
export type MarkState =
  | 'idle'
  | 'w1'
  | 'wN'
  | 'checks'
  | 'overlap'
  | 'waiting'
  | 'queued'
  | 'landing'
  | 'landed'
  | 'failed'
  | 'rolledback'
  | 'paused'
  | 'first'
  | 'streak'
  | 'many'
  | 'thousand';

export function ForgeMark({
  arrive = false,
  state,
  size = 22,
}: {
  /** Shorthand for the first-landing assembly (`data-state="first"`). */
  arrive?: boolean;
  state?: MarkState;
  size?: number;
}) {
  return (
    <svg
      className="fx-mark mk c64"
      viewBox="0 0 64 64"
      width={size}
      height={size}
      aria-hidden="true"
      data-state={state ?? (arrive ? 'first' : 'idle')}
    >
      <g className="whole">
        <path className="stem" d="M8 6H20V40.5H8Z" />
        <path className="stemB" d="M8 40H20V58H14L8 52Z" />
        <g className="armT">
          <rect className="arm aTi" x="8" y="6" width="26.6" height="12" />
          <path className="arm aTo" d="M34 6H58L52 18H34Z" />
        </g>
        <rect className="xT" x="8" y="6" width="12" height="12" />
        <g className="armL">
          <rect className="arm aLi" x="8" y="28" width="22.6" height="12" />
          <path className="arm aLo" d="M30 28H48L42 40H30Z" />
        </g>
        <rect className="xL" x="8" y="28" width="12" height="12" />
        <circle className="sp sp1" cx="54" cy="12" r="2.4" />
        <circle className="sp sp2" cx="44" cy="34" r="2.6" />
        <circle className="sp sp3" cx="50" cy="12" r="1.8" />
      </g>
    </svg>
  );
}
