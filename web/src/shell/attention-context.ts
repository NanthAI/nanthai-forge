// SPDX-License-Identifier: Apache-2.0
import { createContext, useContext } from 'react';
import type { hostedAttention } from './Attention';
export const AttentionContext = createContext<ReturnType<typeof hostedAttention> | null>(null);
export const useAttention = () => useContext(AttentionContext);
