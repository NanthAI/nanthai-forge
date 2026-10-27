// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from 'react';
import { requestHighlight } from './highlight-client';
import type { SourceToken } from './source-highlight';
import type { Word } from './lane/diff-rows';
/** Only intersecting code lines are sent to the worker. Plain source is always rendered immediately. */
export function SyntaxLine({
  text,
  file,
  blob,
  range,
  plain,
  words,
}: {
  text: string;
  file: string;
  blob?: string;
  range: string;
  plain?: boolean;
  words?: Word[];
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [result, setResult] = useState<{ text: string; tokens: SourceToken[] } | null>(null);
  useEffect(() => {
    if (plain || !file || !ref.current || typeof IntersectionObserver === 'undefined') return;
    let current = true;
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      void requestHighlight(file, text, blob, range).then(lines => {
        if (current) setResult({ text, tokens: lines[0] ?? [] });
      });
    });
    observer.observe(ref.current);
    return () => {
      current = false;
      observer.disconnect();
    };
  }, [file, text, blob, range, plain]);
  const tokens = !plain && result?.text === text ? result.tokens : [{ text, className: '' }];
  const render = (start: number, end: number) => {
    let offset = 0;
    return tokens.map((token, index) => {
      const from = Math.max(0, start - offset),
        to = Math.min(token.text.length, end - offset);
      offset += token.text.length;
      if (to <= from) return null;
      return token.className ? (
        <span className={token.className} key={index}>
          {token.text.slice(from, to)}
        </span>
      ) : (
        token.text.slice(from, to)
      );
    });
  };
  let offset = 0;
  return (
    <span ref={ref}>
      {words
        ? words.map((word, index) => {
            const content = render(offset, offset + word.text.length);
            offset += word.text.length;
            return word.kind === 'same' ? (
              <span key={index}>{content}</span>
            ) : (
              <mark className={word.kind === 'removed' ? 'w d' : 'w'} key={index}>
                {content}
              </mark>
            );
          })
        : render(0, text.length)}
      {!text && ' '}
    </span>
  );
}
