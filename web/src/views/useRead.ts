import { useReadRetry } from '../ui/read-retry';
// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from 'react';
import type { ReadRequest, ReadSource } from './model';
export function useViewRead(
  source: ReadSource,
  request: ReadRequest,
): { data?: Awaited<ReturnType<ReadSource>>; error?: string; retry: () => void } {
  const readAttempt = useReadRetry();
  const key = JSON.stringify(request);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{
    key: string;
    source: ReadSource;
    data?: Awaited<ReturnType<ReadSource>>;
    error?: string;
  }>();
  useEffect(() => {
    let active = true;
    source(JSON.parse(key)).then(
      data => {
        if (active) setState({ key, source, data });
      },
      error => {
        if (active) setState({ key, source, error: error.message });
      },
    );
    return () => {
      active = false;
    };
  }, [source, key, attempt, readAttempt]);
  return {
    ...(state?.key === key && state.source === source ? state : {}),
    retry: () => setAttempt(value => value + 1),
  };
}
