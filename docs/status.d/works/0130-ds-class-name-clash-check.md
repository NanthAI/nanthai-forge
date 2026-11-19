- A page stylesheet cannot reuse a design-system class name for its own thing:
  `npm run check` names the file, line and class and the `web/src/ds` file that
  owns it, and `node scripts/check-ds-class-clash.mjs <folder>` runs the same
  check over a mock folder before a builder copies its names
  ([DESIGN.md](../../../DESIGN.md#using-the-system)).
