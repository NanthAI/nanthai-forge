// SPDX-License-Identifier: Apache-2.0
import { useState, type Dispatch, type SetStateAction } from 'react';
// Drafts survive closing a sheet or changing routes within this browser page. No disk storage.
const drafts = new Map<string, string>();
export function useDraft(key: string): [string, Dispatch<SetStateAction<string>>] {
  const [current, update] = useState(() => ({ key, text: drafts.get(key) ?? '' }));
  const text = current.key === key ? current.text : (drafts.get(key) ?? '');
  const setText: Dispatch<SetStateAction<string>> = value => {
    const next = typeof value === 'function' ? value(drafts.get(key) ?? '') : value;
    if (next) drafts.set(key, next);
    else drafts.delete(key);
    update({ key, text: next });
  };
  return [text, setText];
}
