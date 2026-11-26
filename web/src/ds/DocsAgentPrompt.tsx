// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
export function DocsAgentPrompt({ twin, text }: { twin: string; text: string }) {
  return (
    <div className="docs-agent-prompt" data-docs-agent-prompt={twin}>
      <button className="btn sm" type="button" hidden>
        Give this to your agent
      </button>
      <details>
        <summary>View prompt</summary>
        <pre tabIndex={0}>
          <code>{text}</code>
        </pre>
      </details>
      <span className="docs-copy-status" role="status" />
    </div>
  );
}
