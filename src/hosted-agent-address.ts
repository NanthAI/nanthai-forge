// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readSource } from './files.js';
import { canonicalRoot, clientCacheRoot } from './root-paths.js';
import { hostedAgentAddressSchema, type HostedAgentAddress } from './hosted-agent-contract.js';
import { hostedAgentRoot, readAgentJson } from './hosted-agent-journal.js';
import { checkoutPathExists } from './hosted-checkout-files.js';
import { readHostedLaneCheckout } from './hosted-lane-checkout-marker.js';
import { invariant } from './errors.js';

/** Address selection precedes construction of native WorkStore/owner services. */
export function hostedAgentAddress(
  root: string,
  selected: Record<string, unknown>,
): HostedAgentAddress | null {
  root = hostedAgentRoot(root);
  const explicit = selected.url !== undefined || selected.projectId !== undefined;
  const marker = checkoutPathExists(join(root, '.forge', 'hosted-lane.json'))
    ? readHostedLaneCheckout(root)
    : null;
  let address: HostedAgentAddress | null = null;
  if (explicit) {
    const parsed = hostedAgentAddressSchema.safeParse({
      url: selected.url,
      projectId: selected.projectId,
    });
    invariant(parsed.success, 'BAD_ARGUMENT', 'Hosted agent addressing requires both url and projectId.');
    address = parsed.data;
  } else if (marker) address = { url: marker.url, projectId: marker.selection.projectId };
  else {
    const path = join(clientCacheRoot(resolve(root)), 'agent', 'address.json');
    if (checkoutPathExists(path)) address = hostedAgentAddressSchema.parse(readAgentJson(path));
    else if (!checkoutPathExists(resolve(root))) {
      // A missing ROOT addressed earlier: its address lives in Forge's state folder (59f0e296).
      const index = addressedRootIndex(root);
      if (index && checkoutPathExists(index)) address = hostedAgentAddressSchema.parse(readAgentJson(index));
    }
  }
  const mainBytes = !marker ? readSource(root, '.forge/hosted-main.json', Number.MAX_SAFE_INTEGER) : null;
  if (address && mainBytes)
    invariant(
      JSON.parse(mainBytes.toString()).selection.projectId === address.projectId,
      'PROJECT_UNAVAILABLE',
      'The address differs from this hosted main checkout.',
    );
  if (address && marker)
    invariant(
      address.url === marker.url && address.projectId === marker.selection.projectId,
      'WORK_OPERATION_CHANGED',
      'The address differs from this hosted Lane checkout.',
    );
  return address;
}

/** Forge's own folder for address-only client state. Under the test runner without an explicit
 * XDG_STATE_HOME it is off (null), as for the board and turn state, so tests never write the
 * user's state folder. */
function addressedState() {
  if (process.env.NODE_TEST_CONTEXT && !process.env.XDG_STATE_HOME) return null;
  return join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'forge', 'addressed');
}
const digest = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 32);
/** Which address a missing ROOT was last given, so later calls without url + projectId resolve. */
function addressedRootIndex(root: string) {
  const state = addressedState();
  return state && join(state, 'roots', `${digest(canonicalRoot(root))}.json`);
}

/** An address-only call (explicit url + projectId) whose ROOT does not exist, such as a project
 * id typed as ROOT (Issue 59f0e296), keeps its client state (journals, board cursor, Lanes) in
 * Forge's own state folder, one per address, never as `ROOT.forge-client` under the caller's
 * directory; a small index there keeps the retained address for that ROOT. Commands whose job is
 * to create the checkout at ROOT (such as `open` without `handoff`, friction 789b7b21) keep ROOT
 * instead of calling this. An existing folder keeps binding the address beside it; so do a Lane
 * or checkout above a missing ROOT, and a missing ROOT that already has client state, so earlier
 * journals still resolve. Local only: at most one mkdir and one small write, no network. */
export function addressOnlyRoot(root: string, address: HostedAgentAddress) {
  const base = hostedAgentRoot(root),
    state = addressedState(),
    index = addressedRootIndex(root);
  if (
    !state ||
    !index ||
    checkoutPathExists(resolve(root)) ||
    checkoutPathExists(join(base, '.forge', 'hosted-lane.json')) ||
    checkoutPathExists(join(base, '.forge', 'hosted-main.json')) ||
    checkoutPathExists(clientCacheRoot(base))
  )
    return root;
  const addressed = join(state, digest(`${address.url}\0${address.projectId}`));
  mkdirSync(addressed, { recursive: true, mode: 0o700 });
  const body = JSON.stringify(address);
  if (!checkoutPathExists(index) || readAgentJsonText(index) !== body) {
    mkdirSync(join(state, 'roots'), { recursive: true, mode: 0o700 });
    writeFileSync(index, body, { mode: 0o600 });
  }
  return addressed;
}
function readAgentJsonText(path: string) {
  try {
    return JSON.stringify(hostedAgentAddressSchema.parse(readAgentJson(path)));
  } catch {
    return null;
  }
}
