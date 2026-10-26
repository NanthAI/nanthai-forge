// SPDX-License-Identifier: Apache-2.0
/** Compare retained-pixel rendering against a full clear at desktop/mobile geometry. */
export async function checkHeroPixels(page) {
  return page.evaluate(async () => {
    const { createRiver, aliveDefaults } = await import('/src/landing/alive-world.ts');
    const { drawRiver } = await import('/src/landing/alive-draw.ts');
    const colors = {
      trunk: '#6f7a8a',
      agent: '#8a94a4',
      person: '#2fb8a9',
      you: '#ff6b3d',
      passed: '#5fd39a',
      conflict: '#c79bff',
    };
    for (const [width, height] of [
      [1500, 700],
      [390, 430],
    ]) {
      const left = width > 720 ? width * 0.34 : 0,
        top = width > 720 ? 0 : height * 0.55;
      const canvases = [document.createElement('canvas'), document.createElement('canvas')];
      const contexts = canvases.map(canvas => {
        canvas.width = Math.round((width - left) * 2);
        canvas.height = Math.round((height - top) * 2);
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.setTransform(2, 0, 0, 2, -left * 2, -top * 2);
        return context;
      });
      const world = createRiver(width, height, colors);
      for (let frame = 0; frame < 45 * 60; frame++) {
        world.step(1 / 60);
        if (frame % 60 !== 0) continue;
        contexts[1].clearRect(0, 0, width, height);
        contexts.forEach(context => drawRiver(context, world, colors, aliveDefaults));
        const [a, b] = contexts.map(
          context =>
            new Uint32Array(
              context.getImageData(0, 0, context.canvas.width, context.canvas.height).data.buffer,
            ),
        );
        for (let pixel = 0; pixel < a.length; pixel++)
          if (a[pixel] !== b[pixel]) return { passed: false, width, at: frame / 60, pixel };
      }
    }
    return { passed: true, secondsPerGeometry: 45, dpr: 2, widths: [1500, 390] };
  });
}
