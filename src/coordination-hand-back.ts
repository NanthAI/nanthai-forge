// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
export const HAND_TO_AGENT = 'Hand to an agent';
export const TAKE_IT = 'Take it';
export const TAKE_IT_YOURSELF = 'Take it yourself';
export const SET_IT_ASIDE = 'Set it aside';
export const DECLINE_HAND_BACK = 'Decline';

export function handBackChoices(sender: string, recipient: string) {
  return sender === recipient
    ? [HAND_TO_AGENT, TAKE_IT_YOURSELF, SET_IT_ASIDE]
    : [TAKE_IT, DECLINE_HAND_BACK];
}
