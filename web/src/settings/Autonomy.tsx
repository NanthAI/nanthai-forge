import { InfoTip } from '../ui/signals';
import { ErrorToast } from '../ui/Toast';
// SPDX-License-Identifier: Apache-2.0
import { useRef, useState } from 'react';
import { policyPreset, type AutonomyPolicy, type PolicyWrite } from '../../../src/autonomy-policy';
import { Button, Panel, Segmented, Switch } from '../ui/primitives';
const presets = [
  { id: 'supervised', label: 'Supervised', detail: 'Agents propose. You accept.' },
  { id: 'trusted', label: 'Trusted', detail: 'Agents accept on a passing check.' },
  { id: 'autonomous', label: 'Autonomous', detail: 'Accept, complete and clean up.' },
  { id: 'custom', label: 'Custom', detail: 'Choose each setting below.' },
] as const;
export function Autonomy({
  policy,
  save,
  editable = true,
}: {
  policy: AutonomyPolicy;
  save: (command: PolicyWrite) => Promise<AutonomyPolicy>;
  editable?: boolean;
}) {
  const [draft, setDraft] = useState(policy),
    [base, setBase] = useState(policy);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [saved, setSaved] = useState(false);
  const pending = useRef<PolicyWrite | null>(null);
  // Live policy updates are adopted only while the form has no edits or unresolved operation.
  if (
    !pending.current &&
    JSON.stringify(draft) === JSON.stringify(base) &&
    JSON.stringify(policy) !== JSON.stringify(base)
  ) {
    setBase(policy);
    setDraft(policy);
  }
  const dirty = JSON.stringify(draft) !== JSON.stringify(base);
  const edit = (patch: Partial<AutonomyPolicy>) => {
    setSaved(false);
    setDraft({ ...draft, ...patch, preset: 'custom' });
  };
  async function submit() {
    pending.current ??=
      draft.preset === 'custom'
        ? { action: 'set-policy', operationId: crypto.randomUUID(), expectedPolicy: base, ...draft }
        : {
            action: 'set-policy',
            operationId: crypto.randomUUID(),
            expectedPolicy: base,
            preset: draft.preset,
          };
    setBusy(true);
    setError('');
    try {
      const next = await save(pending.current);
      pending.current = null;
      setBase(next);
      setDraft(next);
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!editable)
    return (
      <>
        <h1>Autonomy</h1>
        <p className="fx-muted">Only owners can change this</p>
        <Panel title="Policy">
          {[
            ['Preset', presets.find(item => item.id === policy.preset)?.label],
            ['Accept on a passing check', policy.acceptance.mode === 'review' ? 'Never' : 'Allowed agents'],
            ...(policy.acceptance.mode === 'auto-on-pass'
              ? [['Allowed agents', policy.acceptance.autoActors?.join(', ') || 'All agents']]
              : []),
            [
              'Reuse passing checks after disjoint main changes',
              policy.acceptance.disjointFastPath ? 'On' : 'Off',
            ],
            ['Protected paths', policy.acceptance.protectedPaths.join(', ') || 'None'],
            ['Update Lanes from main automatically', policy.laneUpdates === 'auto' ? 'On' : 'Off'],
            [
              'Complete Intents when all their Lanes are accepted',
              policy.lifecycle.completeOnAccept ? 'On' : 'Off',
            ],
            ['Clean up regenerable local copies', policy.lifecycle.cleanRegenerableCopies ? 'On' : 'Off'],
            ['While you were away summary', policy.notify.awaySummary ? 'On' : 'Off'],
          ].map(([label, value]) => (
            <div className="fx-setting" key={label}>
              <b>{label}</b>
              <span>{value}</span>
            </div>
          ))}
        </Panel>
      </>
    );
  return (
    <>
      <div className="fx-settings-title">
        <h1>Autonomy</h1>
        <details>
          <summary>Guardrails</summary>
          <p>
            Automatic acceptance requires a passing check on the exact View. Protected paths require a person.
            Recorded actions retain their provenance.
          </p>
        </details>
      </div>
      <fieldset disabled={!editable || busy || !!pending.current} className="fx-policy-fields">
        <legend className="fx-sr-only">Autonomy policy</legend>
        <div className="fx-policy-scale">
          <span>You decide</span>
          <span>Agents decide</span>
        </div>
        <div className="fx-presets" role="radiogroup" aria-label="Autonomy preset">
          {presets.map(preset => (
            <button
              type="button"
              role="radio"
              aria-checked={draft.preset === preset.id}
              tabIndex={draft.preset === preset.id ? 0 : -1}
              onKeyDown={event => {
                const step = ['ArrowRight', 'ArrowDown'].includes(event.key)
                  ? 1
                  : ['ArrowLeft', 'ArrowUp'].includes(event.key)
                    ? -1
                    : 0;
                if (!step) return;
                event.preventDefault();
                const radios = Array.from(
                  event.currentTarget.parentElement!.querySelectorAll<HTMLButtonElement>('[role=radio]'),
                );
                const next =
                  radios[(radios.indexOf(event.currentTarget) + step + radios.length) % radios.length]!;
                next.focus();
                next.click();
              }}
              key={preset.id}
              onClick={() => {
                setSaved(false);
                setDraft(preset.id === 'custom' ? { ...draft, preset: 'custom' } : policyPreset(preset.id));
              }}
            >
              <span className="fx-preset-dot" />
              <h2>{preset.label}</h2>
              <p>{preset.detail}</p>
            </button>
          ))}
        </div>
        <Panel title="What agents may do on their own">
          <div className="fx-setting">
            <b>Accept on a passing check</b>
            <Segmented
              label="Agent acceptance"
              value={draft.acceptance.mode}
              onChange={mode =>
                edit({
                  acceptance: { ...draft.acceptance, mode },
                  ...(mode === 'review'
                    ? { lifecycle: { ...draft.lifecycle, cleanRegenerableCopies: false } }
                    : {}),
                })
              }
              options={[
                { id: 'review', label: 'Never' },
                { id: 'auto-on-pass', label: 'Allowed agents' },
              ]}
            />
          </div>
          {draft.acceptance.mode === 'auto-on-pass' && (
            <div className="fx-setting">
              <b>
                Allowed agents{' '}
                <InfoTip inline label="Allowed agent identifiers">
                  Empty means all agents. Use the actor IDs recorded by Forge.
                </InfoTip>
              </b>
              <ListInput
                label="Allowed agents"
                values={draft.acceptance.autoActors ?? []}
                placeholder="Actor IDs, comma-separated"
                separator=","
                onChange={autoActors => edit({ acceptance: { ...draft.acceptance, autoActors } })}
              />
            </div>
          )}
          <div className="fx-setting">
            <b>Protected paths — always a person</b>
            <PathInput
              values={draft.acceptance.protectedPaths}
              onChange={protectedPaths => edit({ acceptance: { ...draft.acceptance, protectedPaths } })}
            />
          </div>
          <Toggle
            label="Reuse checks after disjoint main changes"
            checked={draft.acceptance.disjointFastPath ?? false}
            change={disjointFastPath => edit({ acceptance: { ...draft.acceptance, disjointFastPath } })}
          />
          <Toggle
            label="Update Lanes from main automatically"
            checked={draft.laneUpdates === 'auto'}
            change={checked => edit({ laneUpdates: checked ? 'auto' : 'ask' })}
          />
          <Toggle
            label="Complete Intents when all their Lanes are accepted"
            checked={draft.lifecycle.completeOnAccept}
            change={checked => edit({ lifecycle: { ...draft.lifecycle, completeOnAccept: checked } })}
          />
          <Toggle
            label="Clean up regenerable local copies"
            checked={draft.lifecycle.cleanRegenerableCopies}
            change={checked => edit({ lifecycle: { ...draft.lifecycle, cleanRegenerableCopies: checked } })}
          />
          <Toggle
            label="While you were away summary"
            checked={draft.notify.awaySummary}
            change={checked => edit({ notify: { awaySummary: checked } })}
          />
        </Panel>
      </fieldset>
      {error && <ErrorToast>{error}</ErrorToast>}
      <div className="fx-settings-save">
        <span role="status">{saved ? 'Autonomy saved.' : dirty ? 'Unsaved changes.' : ''}</span>
        <Button
          disabled={busy || (!pending.current && !dirty)}
          variant="ghost"
          onClick={() => {
            pending.current = null;
            setBase(policy);
            setDraft(policy);
            setError('');
          }}
        >
          Discard
        </Button>
        <Button
          variant="primary"
          disabled={!editable || busy || (!dirty && !pending.current)}
          onClick={() => void submit()}
        >
          {busy ? 'Saving…' : pending.current ? 'Retry save' : 'Save autonomy'}
        </Button>
      </div>
    </>
  );
}
function Toggle({
  label,
  checked,
  change,
}: {
  label: string;
  checked: boolean;
  change: (checked: boolean) => void;
}) {
  return <Switch label={label} checked={checked} onChange={change} />;
}

function ListInput({
  label,
  values,
  separator,
  placeholder,
  onChange,
}: {
  label: string;
  values: string[];
  separator: string;
  placeholder?: string;
  onChange: (values: string[]) => void;
}) {
  const parse = (value: string) =>
    value
      .split(separator)
      .map(value => value.trim())
      .filter(Boolean);
  const [text, setText] = useState(values.join(separator));
  if (JSON.stringify(parse(text)) !== JSON.stringify(values)) setText(values.join(separator));
  const change = (value: string) => {
    setText(value);
    onChange(parse(value));
  };
  return separator === '\n' ? (
    <textarea aria-label={label} rows={3} value={text} onChange={e => change(e.target.value)} />
  ) : (
    <input aria-label={label} placeholder={placeholder} value={text} onChange={e => change(e.target.value)} />
  );
}

function PathInput({ values, onChange }: { values: string[]; onChange: (values: string[]) => void }) {
  const [text, setText] = useState('');
  const add = () => {
    const paths = text
      .split(/[,\n]/)
      .map(value => value.trim())
      .filter(Boolean);
    if (paths.length) onChange([...new Set([...values, ...paths])]);
    setText('');
  };
  return (
    <div className="fx-paths">
      {values.map(value => (
        <span className="fx-path-chip" key={value}>
          <code>{value}</code>
          <button
            type="button"
            aria-label={`Remove ${value}`}
            onClick={() => onChange(values.filter(path => path !== value))}
          >
            ×
          </button>
        </span>
      ))}
      <textarea
        aria-label="Protected paths"
        rows={1}
        placeholder="e.g. convex/, .github/"
        value={text}
        onChange={event => {
          setText(event.target.value);
          event.target.style.height = 'auto';
          event.target.style.height = `${event.target.scrollHeight}px`;
        }}
        onBlur={add}
        onKeyDown={event => {
          if (event.key === 'Enter' || event.key === ',') {
            event.preventDefault();
            add();
          }
        }}
      />
    </div>
  );
}
