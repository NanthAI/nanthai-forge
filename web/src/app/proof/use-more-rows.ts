// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { useRef, useState } from 'react';

/** Keep the keyboard reader at the first revealed row when the last page removes the button. */
export function useMoreRows(initial: number) {
  const [shown, setShown] = useState(initial);
  const next = useRef<number | null>(null);
  function showMore(count: number) {
    next.current = shown;
    setShown(shown + count);
  }
  function focusNewRow(element: HTMLLIElement | null, index: number) {
    if (element && next.current === index) {
      next.current = null;
      element.focus();
    }
  }
  return { shown, showMore, focusNewRow };
}
