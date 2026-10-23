// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { WorkPlanning } from '../../web/src/WorkPlanning';
import type { PlanningItem, PlanningWrite } from '../../src/work-types';
const item: PlanningItem = {
  id: 'fixture-item',
  operationId: 'fixture-version',
  kind: 'issue',
  title: 'Fix the parser',
  body: 'Handle escaped strings in parser.ts.',
  status: 'open',
  intentIds: [],
  version: 1,
  at: '2026-10-05T10:00:00Z',
};
function Check() {
  const [items, setItems] = useState([item]);
  const [comments, setComments] = useState<
    { id: string; itemId: string; at: string; text: string; authorLabel?: string }[]
  >([]);
  const [message, setMessage] = useState('No command submitted');
  async function act(command: PlanningWrite) {
    if (command.action === 'comment-planning-item') {
      if (command.itemId !== item.id) throw new Error('Comment targeted another item');
      setComments(previous => [
        ...previous,
        {
          id: command.operationId,
          itemId: command.itemId,
          at: new Date().toISOString(),
          text: command.text,
          authorLabel: command.authorLabel,
        },
      ]);
      setMessage('PASS · comment attached to the selected item');
    } else if (command.action === 'put-planning-item') {
      if (command.itemId !== item.id || command.expectedVersion !== 1)
        throw new Error('Edit lost the selected item or version');
      setItems(previous => [
        ...previous,
        { ...item, title: command.title, body: command.body, version: 2, operationId: command.operationId },
      ]);
      setMessage('PASS · edit retained the selected item and expected version');
    }
  }
  return (
    <>
      <h1>Synthetic planning journey</h1>
      <p role="status">{message}</p>
      <WorkPlanning
        data={{
          revision: 1,
          intents: [],
          planningItems: items,
          planningComments: comments,
          hostedEvents: [],
        }}
        busy={false}
        act={act}
      />
    </>
  );
}
createRoot(document.getElementById('root')!).render(<Check />);
