// SPDX-License-Identifier: Apache-2.0
import { nativeChannels } from './native-work.js';
import { channelStatus } from './work-channel.js';
import type { WorkStore } from './work-store.js';

/** The Channel head an agent would observe now; null for a new Channel. */
export function currentChannelHead(store: WorkStore, name: string): string | null {
  const tx = store.readRecords(),
    data = tx ? { ...tx.data(), channelMoves: tx.all('channelMoves', name, 'channel') } : store.load();
  const channels = store.native ? nativeChannels(data) : channelStatus(store, data);
  return channels.find(item => item.name === name)?.head ?? null;
}
