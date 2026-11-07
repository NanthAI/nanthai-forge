// SPDX-License-Identifier: Apache-2.0
import { ForgeMark } from '../shell/brand';

export function LoadingMark() {
  return (
    <span className="fx-loading-mark">
      <ForgeMark state="checks" size={64} />
    </span>
  );
}
