// SPDX-License-Identifier: Apache-2.0
import type { GlyphName } from './Glyph';

export type Concept = 'intent' | 'lane' | 'view' | 'check' | 'channel';

/** One plain sentence per Forge term, shown on first appearance, in tooltips and in empty states. */
export const concepts: Record<Concept, { label: string; plural: string; glyph: GlyphName; explain: string }> =
  {
    intent: {
      label: 'Intent',
      plural: 'Intents',
      glyph: 'intent',
      explain: 'The outcome you want.',
    },
    lane: {
      label: 'Lane',
      plural: 'Lanes',
      glyph: 'lane',
      explain: 'An isolated copy where one person or agent makes part of an Intent.',
    },
    view: {
      label: 'View',
      plural: 'Views',
      glyph: 'view',
      explain: 'An exact combination of Lanes, ready to check and accept.',
    },
    check: {
      label: 'Check',
      plural: 'Checks',
      glyph: 'check',
      explain: 'A recorded test run on one exact View.',
    },
    channel: {
      label: 'Channel',
      plural: 'Channels',
      glyph: 'channel',
      explain: 'Accepted source, such as main. Only Views whose check passed get in.',
    },
  };
