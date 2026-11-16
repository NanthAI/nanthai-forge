// SPDX-License-Identifier: Apache-2.0
// One polite live region per moving part: what moved and where it now is, in the words the screen shows.
import { useCallback, useState } from 'react';

/** [message, announce]: the same words twice in a row are still read (a zero-width space alternates). */
export function useAnnounce(): [string, (text: string) => void] {
  const [state, setState] = useState({ text: '', n: 0 });
  const announce = useCallback((text: string) => setState(prev => ({ text, n: prev.n + 1 })), []);
  return [state.text ? state.text + (state.n % 2 ? '' : '​') : '', announce];
}

export function Announcer({ message }: { message: string }) {
  return (
    <div className="sr" role="status" aria-live="polite" data-announce="">
      {message}
    </div>
  );
}
