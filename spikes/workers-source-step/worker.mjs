// SPDX-License-Identifier: Apache-2.0
import { initialSourceStep, runSourceStep } from '../../dist/hosted-source-step.js';
import { cachedReads } from '../../dist/hosted-source-read-cache.js';
import { digest } from '../../dist/hash.js';

export default {
  async fetch(request, bindings) {
    const { input, descriptors, profile = false } = await request.json();
    const refs = new Map(descriptors.map(ref => [ref.object.sha256, ref]));
    const r2 = { get: 0, head: 0, put: 0, readBytes: 0, putBytes: 0 };
    // Only the separate diagnostic run pauses. Timed runs never invoke the debugger.
    const checkpoint = () => {
      if (profile) {
        debugger;
      }
    };
    const io = {
      async describeBatch(ids) {
        checkpoint();
        return ids.map(id => {
          const ref = refs.get(id);
          if (!ref) throw Error(`Missing synthetic descriptor ${id}`);
          return ref;
        });
      },
      stateGeneration: id => refs.get(id)?.generation,
      stateParents: id => refs.get(id)?.parents,
      async read(pin) {
        checkpoint();
        r2.get++;
        const object = await bindings.SOURCE.get(pin.sha256);
        if (!object) throw Error('Missing local R2 object');
        return (async function* () {
          for await (const chunk of object.body) {
            r2.readBytes += chunk.length;
            yield chunk;
          }
        })();
      },
      async upload(pin, stream) {
        checkpoint();
        const chunks = [];
        for await (const chunk of stream) chunks.push(Buffer.from(chunk));
        const bytes = Buffer.concat(chunks);
        if (bytes.length !== pin.size || digest(bytes) !== pin.sha256) throw Error('Output pin mismatch');
        r2.put++;
        r2.putBytes += bytes.length;
        await bindings.SOURCE.put(pin.sha256, bytes);
        refs.set(pin.sha256, { object: pin, recipe: null });
        checkpoint();
      },
    };
    const cached = cachedReads(io, { bytes: new Map(), held: 0 }, 8 * 1024 * 1024);
    let cursor = initialSourceStep(input),
      steps = 0;
    while (cursor.phase !== 'done') {
      if (++steps > 1000) throw Error('Non-finite synthetic source job');
      cursor = (await runSourceStep(cursor, cached)).cursor;
      checkpoint();
    }
    return Response.json({ output: cursor.output, head: cursor.head, steps, r2 });
  },
};
