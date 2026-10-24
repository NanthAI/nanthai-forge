// SPDX-License-Identifier: Apache-2.0
import { createContext, useContext } from 'react';
import type { HostedFreshness } from '../../../src/hosted-freshness';
import { asOf, hostedFreshness } from '../../../src/hosted-freshness';
export const GenerationFreshness = createContext<HostedFreshness | null>(null);
export function useGenerationFreshness() {
  const value = useContext(GenerationFreshness);
  return { ...hostedFreshness(value), asOf: asOf(value), value };
}
