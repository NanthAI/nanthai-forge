// SPDX-License-Identifier: Apache-2.0
// The owner-set limit on extra landings (Item 7f9a23e8): choices with where landings wait and the monthly maximum.
import { useState } from 'react';
import { Key, Region } from '../ds';
import { operationId, type StubActions } from './actions';
import { defaultExtraBlocks, extraBlock, plans, type PlanId } from './contract';
import { money, number } from './figures';
import { limitChoices, monthlyMaximum, type LimitChoice } from './preview';

const blocksWords = (b: LimitChoice) =>
  b === null ? 'No limit' : b === 0 ? 'Off' : `Up to ${b} ${b === 1 ? 'block' : 'blocks'}`;
type Props = {
  plan: PlanId;
  blocks: LimitChoice;
  setBlocks: (blocks: LimitChoice) => void;
  canEdit: boolean;
  actions: StubActions;
};
export function LimitControl({ plan: id, blocks, setBlocks, canEdit, actions }: Props) {
  const [limitNote, setLimitNote] = useState<{ text: string; undo: LimitChoice } | null>(null);
  const plan = plans[id];
  const hobby = id === 'hobby';
  const max = monthlyMaximum(id, blocks);
  const choose = (next: LimitChoice, undo: LimitChoice) => {
    const result = actions.setLimit({ operationId: operationId(), blocks: next });
    if (!result.ok) return setLimitNote({ text: result.message, undo });
    setBlocks(next);
    const m = monthlyMaximum(id, next);
    setLimitNote({
      text:
        next === null
          ? 'Sample: no limit on extra landings. Nothing was saved.'
          : next === 0
            ? `Sample: extra landings off; landings would wait at ${number(plan.includedLandings)}. Nothing was saved.`
            : `Sample: extra landings would stop at ${next} ${next === 1 ? 'block' : 'blocks'}, at most ${money((m.maxUsd ?? 0) - plan.monthlyUsd, 0)} a month. Nothing was saved.`,
      undo,
    });
  };
  return (
    <Region title="Limit on extra landings" hint="past the landings your plan includes">
      <div id="limit" />
      {hobby ? (
        <p className="quietline">
          Not on Hobby: at {number(plan.includedLandings)}, landings wait until the next month and nothing is
          charged. On Pro and Team you choose how many extra blocks may start.
        </p>
      ) : (
        <>
          <div role="radiogroup" aria-label="Limit on extra landings">
            {limitChoices.map(choice => {
              const m = monthlyMaximum(id, choice);
              return (
                <label className="row choice" key={String(choice)}>
                  <input
                    className="rd"
                    type="radio"
                    name="billing-limit"
                    checked={blocks === choice}
                    disabled={!canEdit}
                    onChange={() => choose(choice, blocks)}
                  />
                  <span>
                    <b>{blocksWords(choice)}</b>
                    <span className="sub">
                      {m.waitsAt === null
                        ? 'Blocks keep starting as work lands'
                        : `Landings wait at ${number(m.waitsAt)}`}
                      {choice === defaultExtraBlocks ? ' · the default for a new paid plan' : ''}
                    </span>
                  </span>
                  <span className="mono t2">
                    {choice === null
                      ? `${money(extraBlock.usd, 0)} per ${extraBlock.landings}`
                      : choice === 0
                        ? money(0, 0)
                        : `at most ${money(choice * extraBlock.usd, 0)}`}
                  </span>
                </label>
              );
            })}
          </div>
          <div className="pf">
            {max.maxUsd === null
              ? `With no limit, the most a month on ${plan.name} can cost is not known in advance.`
              : `The most a month on ${plan.name} can cost: ${money(max.maxUsd, 0)} before tax.`}
          </div>
          {limitNote ? (
            <p className="quietline" role="status">
              {limitNote.text}{' '}
              <Key
                size="sm"
                kind="ghost"
                onClick={() => {
                  setBlocks(limitNote.undo);
                  setLimitNote(null);
                }}
              >
                Undo
              </Key>
            </p>
          ) : null}
        </>
      )}
    </Region>
  );
}
