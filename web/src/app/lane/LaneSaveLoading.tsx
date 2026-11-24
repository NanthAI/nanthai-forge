// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { Row } from '../../ds';

/** Reserve the same rows while the History chunk and the first page load. */
export function LaneSaveLoading() {
  return (
    <div className="sk-rows">
      <span className="sr" role="status">
        Loading saves
      </span>
      {[0, 1, 2, 3].map(row => (
        <Row key={row} className="lane-save-row" cols="minmax(0, 1fr)" aria-hidden="true">
          <div>
            <div className="sk" />
            <div className="sk" />
          </div>
        </Row>
      ))}
    </div>
  );
}
