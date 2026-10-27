// SPDX-License-Identifier: Apache-2.0
import { createContext, useContext } from 'react';
import type { DecisionRecord } from '../../../src/decision-types';
import { hostedHref } from '../cockpit/hosted-links';
import { decisionDocumentHref, type DecisionIntent } from './model';
import type { DecisionLinks } from './OwnerDecisionRecord';
export const ownerDecisionLinks: DecisionLinks = {
  recordHref: id => hostedHref({ projectTab: 'decisions', decision: id }),
  intentHref: id => hostedHref({ projectTab: 'intent', intent: id }),
  documentHref: link =>
    decisionDocumentHref(link, path => {
      const [file, hash] = path.split('#');
      return (
        hostedHref({ projectTab: 'delivery', file: file! }) + (hash ? `#${encodeURIComponent(hash)}` : '')
      );
    }),
};
export const OwnerDecisionsContext = createContext<{
  records: readonly DecisionRecord[];
  intents: readonly DecisionIntent[];
  now: number;
  loading?: boolean;
  unavailable?: boolean;
  links: DecisionLinks;
}>({ records: [], intents: [], now: 0, links: ownerDecisionLinks });
export const useOwnerDecisions = () => useContext(OwnerDecisionsContext);
