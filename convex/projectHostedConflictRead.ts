// SPDX-License-Identifier: Apache-2.0
'use node';
import type { ActionCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import type { ObjectView } from './projectObjectFind';
import { rawContent } from './projectObjectContent';
import { presignGet, r2Config, r2Key } from './r2';
import { readSignedPhysical } from './projectStateSourceReader';
import { stateRecipePins } from './projectStateSourceRecipe';
import { PhysicalManifestReader, readPhysicalPin } from '../src/physical-manifest';
import { physicalKey } from '../src/physical-manifest-binary';
import type { PhysicalPin, PhysicalEntry } from '../src/physical-manifest-codec';
import { packHeaders } from '../src/object-pack-range';
import { parseNativeState } from '../src/state/format';
import { TRIAL_FILE_BYTES, type TrialObject, type TrialPlan } from '../src/hosted-trial-plan';
import { TrialUnavailable } from '../src/hosted-trial-merge';
import { exchangeFetch } from '../src/exchange-request';
import { digest } from '../src/hash';
import { FORGE_CONFIG_FILE } from '../src/project-config';

/** Use the same verified raw/pack/nonce bindings as composition. Never treat a logical blob
 * digest as its physical R2 key: imported and saved files can live inside packs. */
export function trialReader(ctx: ActionCtx, projectId: Id<'hostedProjects'>, plan: TrialPlan) {
  const held = new Map<string, Buffer>();
  const objects = new Map(plan.objects.map(object => [object.digest, object]));
  const bindings = new Map<string, PhysicalEntry>();
  let bytes = 0;
  const physical = async (pin: PhysicalPin) => {
    const range = pin.pack && { offset: pin.pack.offset, total: pin.pack.size };
    const url = await presignGet(
      r2Config(),
      r2Key(projectId, physicalKey(pin.pack?.digest ?? pin.sha256, pin.pack?.nonce ?? pin.nonce)),
      packHeaders(range, pin.size),
    );
    const value = await readSignedPhysical(pin, url);
    bytes += value.length;
    return value;
  };
  const load = async (object: TrialObject) => {
    const value = await rawContent(ctx, object as unknown as ObjectView, {
      sha256: object.digest,
      size: object.size,
    });
    bytes += value.length;
    return value;
  };
  const states = new Map<string, Promise<Map<string, { blob: string; mode: string }>>>();
  const paths = new Set([...plan.tasks.map(task => task.path), FORGE_CONFIG_FILE]);
  const state = (object: TrialObject) => {
    let pending = states.get(object.digest);
    if (!pending) {
      pending = (async () => {
        const files = new Map(
          parseNativeState(await load(object))
            .files.filter(file => paths.has(file.path))
            .map(file => [file.path, { blob: file.blob, mode: file.mode }]),
        );
        const missing = [...files.values()].filter(
          file => !objects.has(file.blob) && !bindings.has(file.blob),
        );
        if (missing.length && object.statePhysical) {
          const manifest = await PhysicalManifestReader.open(object.digest, object.statePhysical, physical);
          const entries = await manifest.lookup(missing.map(file => file.blob));
          for (const entry of entries) if (entry) bindings.set(entry.sha256, entry);
        }
        return files;
      })();
      states.set(object.digest, pending);
    }
    return pending;
  };
  const blob = async (id: string) => {
    if (held.has(id)) return held.get(id)!;
    const object = objects.get(id),
      binding = bindings.get(id);
    if ((object?.size ?? binding?.size ?? 0) > TRIAL_FILE_BYTES) throw new TrialUnavailable(id);
    let value: Buffer;
    if (object) value = await load(object);
    else if (binding?.recipe) {
      const proof = await stateRecipePins(binding, physical);
      const parts: Buffer[] = [];
      for (const leaf of proof.leaves) parts.push(Buffer.from(await readPhysicalPin(leaf, physical)));
      value = Buffer.from(await readPhysicalPin(binding, async () => Buffer.concat(parts)));
    } else if (binding) value = Buffer.from(await physical(binding));
    else {
      // Legacy States without physical metadata keep their verified canonical-object read.
      const response = await exchangeFetch(
        'trial merge legacy blob',
        await presignGet(r2Config(), r2Key(projectId, id)),
        { headers: { 'accept-encoding': 'identity' } },
      );
      if (!response.ok) throw new TrialUnavailable(id);
      value = Buffer.from(await response.arrayBuffer());
      if (value.length > TRIAL_FILE_BYTES || digest(value) !== id) throw new TrialUnavailable(id);
      bytes += value.length;
    }
    held.set(id, value);
    return value;
  };
  return {
    state,
    blob,
    async prepare() {
      for (const source of plan.sources ?? []) {
        const base = await state(source.base),
          head = await state(source.head);
        for (const task of plan.tasks) {
          const side =
            source.laneId === plan.laneId ? task.mine : task.peers.find(p => p.laneId === source.laneId);
          if (side) {
            side.before = base.get(task.path) ?? null;
            side.after = head.get(task.path) ?? null;
          }
        }
      }
      const main = plan.main ? await state(plan.main.state) : undefined;
      if (main) for (const task of plan.tasks) task.main = main.get(task.path) ?? null;
      const ids = new Set(
        plan.tasks
          .flatMap(task => [
            task.mine.before,
            task.mine.after,
            task.main,
            ...task.peers.flatMap(peer => [peer.before, peer.after]),
          ])
          .flatMap(file => (file && file.mode !== 'symlink' && file.mode !== 'gitlink' ? [file.blob] : [])),
      );
      const selected = [...ids];
      for (let i = 0; i < selected.length; i += 8)
        await Promise.all(selected.slice(i, i + 8).map(id => blob(id).catch(() => undefined)));
      return main;
    },
    read(id: string) {
      const value = held.get(id);
      if (!value) throw new TrialUnavailable(id);
      return value;
    },
    get bytes() {
      return bytes;
    },
  };
}
