// SPDX-License-Identifier: Apache-2.0
/** Approved Forge Overlap mark. Brand rights: assets/NOTICE.md. */
export function ForgeMark({ arrive = false }: { arrive?: boolean }) {
  return (
    <svg
      className={['fx-mark', arrive && 'fx-mark-arrive'].filter(Boolean).join(' ')}
      viewBox="0 0 64 64"
      width="22"
      height="22"
      aria-hidden="true"
    >
      <g className="fx-mark-stem">
        <path d="M8 6L20 6L20 58L14 58L8 52Z" fill="currentColor" />
      </g>
      <g className="fx-mark-top">
        <path d="M8 6L58 6L52 18L8 18Z" fill="#ff6b3d" />
        <path className="fx-mark-cross-top" d="M8 6L20 6L20 18L8 18Z" fill="#ffb347" />
      </g>
      <g className="fx-orbit">
        <g className="fx-mark-lower">
          <path d="M8 28L48 28L42 40L8 40Z" fill="#ff6b3d" />
          <path className="fx-mark-cross-lower" d="M8 28L20 28L20 40L8 40Z" fill="#23cbff" />
        </g>
      </g>
    </svg>
  );
}
