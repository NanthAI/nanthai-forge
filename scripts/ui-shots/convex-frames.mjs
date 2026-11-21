// SPDX-License-Identifier: Apache-2.0

const decoders = new WeakMap();

function parse(payload) {
  try {
    return JSON.parse(String(payload));
  } catch {
    return null;
  }
}

/** Share one decoder per socket. Large Convex transitions arrive as ordered JSON fragments. */
export function convexFrames(socket, { sent, received }) {
  if (!decoders.has(socket)) {
    const subscribers = [];
    let transition;
    decoders.set(socket, subscribers);
    socket.on('framesent', ({ payload }) => {
      const message = parse(payload);
      if (message) for (const subscriber of subscribers) subscriber.sent(message);
    });
    socket.on('framereceived', ({ payload }) => {
      let message = parse(payload);
      if (message?.type === 'TransitionChunk') {
        const { chunk, partNumber, totalParts, transitionId } = message;
        if (partNumber === 0) transition = { totalParts, transitionId, parts: [] };
        if (
          !transition ||
          totalParts !== transition.totalParts ||
          transitionId !== transition.transitionId ||
          partNumber !== transition.parts.length ||
          partNumber >= totalParts ||
          typeof chunk !== 'string'
        ) {
          transition = undefined;
          return;
        }
        transition.parts.push(chunk);
        if (transition.parts.length < totalParts) return;
        message = parse(transition.parts.join(''));
      }
      transition = undefined;
      if (message) for (const subscriber of subscribers) subscriber.received(message);
    });
  }
  decoders.get(socket).push({ sent, received });
}
