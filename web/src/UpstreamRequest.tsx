import { ErrorToast } from './ui/Toast';
// SPDX-License-Identifier: Apache-2.0
import { DetailPanel } from './DetailPanel';
import { useState } from 'react';
import {
  forgeSupportAddress,
  forgeSupportPage,
  requestDraft,
  requestMailto,
  requestText,
  requestTypes,
} from './upstream-request';
import type { PublicRequestSource, RequestDraft } from './upstream-request';

export default function UpstreamRequest({
  source,
  label = source ? 'Report an upstream issue' : 'Contact Forge support',
}: {
  source?: PublicRequestSource;
  label?: string;
}) {
  const [draft, setDraft] = useState(() => requestDraft(source)),
    [feedback, setFeedback] = useState('');
  const update = (fields: Partial<RequestDraft>) => {
    setDraft(previous => ({ ...previous, ...fields }));
    setFeedback('');
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(requestText(draft));
      setFeedback('Draft copied.');
    } catch {
      setFeedback('Copy is unavailable here. Save the draft or open your email app.');
    }
  };
  const save = () => {
    const url = URL.createObjectURL(
        new Blob([JSON.stringify(draft, null, 2) + '\n'], { type: 'application/json' }),
      ),
      link = document.createElement('a');
    link.href = url;
    link.download = `forge-upstream-request-${draft.id}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    setFeedback('Draft saved; it has not been submitted.');
  };
  return (
    <DetailPanel className="upstream-request" title={<>{label}</>}>
      <p>
        Prepare a private message to <a href={`mailto:${forgeSupportAddress}`}>{forgeSupportAddress}</a>.
      </p>
      <form onSubmit={event => event.preventDefault()}>
        <label>
          Request type
          <select
            value={draft.type}
            onChange={event => update({ type: event.target.value as RequestDraft['type'] })}
          >
            {Object.entries(requestTypes).map(([value, text]) => (
              <option key={value} value={value}>
                {text}
              </option>
            ))}
          </select>
        </label>
        <label>
          Public repository URL (optional)
          <input
            value={draft.repository}
            onChange={event => update({ repository: event.target.value })}
            placeholder="https://github.com/owner/repository"
          />
        </label>
        <label>
          Indexed Git revision (optional)
          <input
            value={draft.revision}
            onChange={event => update({ revision: event.target.value })}
            placeholder="Exact commit, if known"
          />
        </label>
        <label>
          What should change?
          <textarea
            rows={5}
            value={draft.message}
            onChange={event => update({ message: event.target.value })}
          />
        </label>
        <div className="upstream-request-actions">
          <a href={requestMailto(draft)}>Open email draft</a>
          <button type="button" onClick={() => void copy()}>
            Copy draft
          </button>
          <button type="button" onClick={save}>
            Save draft
          </button>
        </div>
      </form>
      <p className="muted">
        Opening your email app does not send a message. Keep private source and credentials out of the draft;
        describe sensitive issues without attaching them.
      </p>
      <DetailPanel title={<>Request identity & response</>}>
        <p>
          Draft ID: <code>{draft.id}</code>. This ID only connects your message and the operator’s response.
          It does not establish ownership or delivery. An operator acknowledgment is your receipt.
        </p>
        <p>
          Correction, owner, opt-out and takedown requests are handled by the operator. Preparing a draft does
          not change stored source or access.{' '}
          <a href={forgeSupportPage} target="_blank" rel="noopener noreferrer">
            Company support
          </a>
        </p>
      </DetailPanel>
      {feedback && <ErrorToast error={feedback} />}
    </DetailPanel>
  );
}
