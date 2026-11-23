// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { ForgeMark } from './brand';

export function LoadingMark() {
  return (
    <span className="fx-loading-mark">
      <ForgeMark state="checks" size={64} />
    </span>
  );
}
