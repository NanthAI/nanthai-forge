// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// One line of code as the highlighter returned it: a span for each coloured run (the design system's code roles,
// ds/review.css), plain text for the rest. Until the highlighter answers, or when it never does, the line is its text.
import type { SourceToken } from './source-highlight';

export function Tokens({ tokens, text }: { tokens: readonly SourceToken[] | undefined; text: string }) {
  if (!tokens) return <>{text}</>;
  return (
    <>
      {tokens.map((token, i) =>
        token.className ? (
          <span key={i} className={token.className}>
            {token.text}
          </span>
        ) : (
          token.text
        ),
      )}
    </>
  );
}
