// SPDX-License-Identifier: Apache-2.0
import { OverlapAnswers, type OverlapActions } from './OverlapAnswers';
import { FixNoticeAnswers, type FixNoticeActions } from './FixNoticeAnswers';
import { queueHref } from './queue-model';
import { settingsHref } from '../settings/SettingsLayout';
import { useState } from 'react';
import { hostedHref } from './hosted-links';
import { DelegateSubject } from './DelegateSheet';
import { Button, ButtonLink } from '../ui/primitives';
import type { DecisionItem } from './attention';
import { decisionBrief } from './brief';
import type { useAnswers } from './coordination';
import { CopyPrompt } from './CopyPrompt';
import { ReplyBox } from './ReplyBox';

type Ack = Pick<ReturnType<typeof useAnswers>, 'acknowledge' | 'reply' | 'busy' | 'retrying'> &
  FixNoticeActions &
  OverlapActions;

/**
 * The answers for one hosted decision. Questions with offered choices answer in one click; the
 * recommended answer comes first and a quiet way out comes last.
 */
export function HostedAnswers({
  item,
  ack,
  laneHref,
  viewHref,
  notNow,
  canStartFix = false,
  owner = false,
}: {
  canStartFix?: boolean;
  owner?: boolean;
  item: DecisionItem;
  ack: Ack;
  laneHref: (laneId: string) => string;
  viewHref?: (viewId: string) => string;
  notNow: () => void;
}) {
  const [acknowledging, setAcknowledging] = useState(false);
  if (item.kind === 'overlap' && item.laneId)
    return (
      <OverlapAnswers
        key={item.noticeIds?.join('|')}
        item={item}
        ack={ack}
        laneHref={laneHref}
        notNow={notNow}
      />
    );
  if ((item.kind === 'revert' || item.kind === 'needs-fix') && item.intentId)
    return (
      <FixNoticeAnswers
        intentId={item.intentId}
        ack={ack}
        laneHref={laneHref}
        canStart={canStartFix}
        owner={owner}
      />
    );
  if (item.queue?.state === 'failed')
    return (
      <>
        {item.queue.link && (
          <ButtonLink size="sm" href={queueHref(item.queue.link)}>
            Open run
          </ButtonLink>
        )}
        {item.queue.repairIntentId && (
          <ButtonLink
            size="sm"
            variant="ghost"
            href={queueHref({
              kind: 'repair-intent',
              id: item.queue.repairIntentId,
              label: 'Repair in Lane',
            })}
          >
            Repair in Lane
          </ButtonLink>
        )}
      </>
    );
  if (item.githubMirror)
    return (
      <ButtonLink size="sm" variant="rec" href={settingsHref('github')}>
        Open GitHub mirror
      </ButtonLink>
    );
  if (item.runId && item.viewId)
    return (
      <ButtonLink
        size="sm"
        variant="rec"
        href={viewHref?.(item.viewId) ?? hostedHref({ projectTab: 'intent', reviewView: item.viewId })}
      >
        Open failing run
      </ButtonLink>
    );
  const openLane = item.laneId && (
    <ButtonLink size="sm" variant="ghost" href={laneHref(item.laneId)}>
      Open Lane
    </ButtonLink>
  );
  const brief = decisionBrief(item);
  if (item.kind === 'review')
    return (
      <>
        {item.laneId && (
          <ButtonLink
            size="sm"
            variant="rec"
            href={
              item.viewId
                ? (viewHref?.(item.viewId) ?? hostedHref({ projectTab: 'intent', reviewView: item.viewId }))
                : laneHref(item.laneId)
            }
          >
            Review &amp; accept
          </ButtonLink>
        )}
        <Button size="sm" variant="ghost" onClick={notNow}>
          Not now
        </Button>
      </>
    );
  if ((item.kind === 'conflict' || item.kind === 'failed') && brief)
    return (
      <>
        <CopyPrompt
          request={brief}
          variant="rec"
          label={item.owner ? `Hand to ${item.owner}` : 'Hand to an agent'}
          {...(item.continues ? { continues: item.continues } : {})}
          {...(item.subject ? { context: <DelegateSubject subject={item.subject} /> } : {})}
        />
        {openLane}
      </>
    );
  const id = item.messageId;
  if (!id) return openLane || null;
  const messageIds = [
    id,
    ...(item.earlier ?? []).flatMap(earlier => (earlier.messageId ? [earlier.messageId] : [])),
  ];
  const busy = acknowledging || messageIds.includes(ack.busy ?? '');
  const acknowledgeAll = async () => {
    setAcknowledging(true);
    try {
      await acknowledgeMessages(messageIds, ack.acknowledge);
    } finally {
      setAcknowledging(false);
    }
  };
  const reply = item.replyTo && (
    <ReplyBox
      to={item.quote?.from ?? 'the sender'}
      primary={item.choices?.length ? 'ghost' : item.question ? 'rec' : false}
      busy={busy}
      send={text => ack.reply(id, item.replyTo!, text, item.laneId)}
    />
  );
  if (item.kind === 'handoff')
    return (
      <>
        <Button
          size="sm"
          variant="rec"
          disabled={busy}
          onClick={() => void ack.acknowledge(id, 'Taking this handoff.')}
        >
          {ack.retrying(id) ? 'Retry' : 'Take it'}
        </Button>
        {brief && <CopyPrompt request={brief} variant="secondary" label="Hand to an agent" />}
        {openLane}
      </>
    );
  if (item.choices?.length)
    return (
      <>
        {item.choices.map((choice, index) => (
          <Button
            key={choice}
            size="sm"
            variant={index === 0 ? 'rec' : 'secondary'}
            disabled={busy}
            onClick={() => void ack.acknowledge(id, choice, choice)}
          >
            {choice}
          </Button>
        ))}
        {reply}
        {Boolean(item.earlier?.length) && (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void acknowledgeAll()}>
            Acknowledge all
          </Button>
        )}
        {openLane}
      </>
    );
  const acknowledge = (
    <Button
      size="sm"
      variant={item.question ? 'secondary' : 'rec'}
      disabled={busy}
      onClick={() => void acknowledgeAll()}
    >
      {ack.retrying(id) ? 'Retry' : item.earlier?.length ? 'Acknowledge all' : 'Acknowledge'}
    </Button>
  );
  return item.question ? (
    <>
      {reply}
      {acknowledge}
      {openLane}
    </>
  ) : (
    <>
      {acknowledge}
      {reply}
      {openLane}
    </>
  );
}

/** Keep acknowledgement order and stop on a failed receipt so retry preserves the remaining messages. */
export async function acknowledgeMessages(ids: readonly string[], acknowledge: Ack['acknowledge']) {
  for (const id of ids) if (!(await acknowledge(id, 'Read.'))) return false;
  return true;
}
