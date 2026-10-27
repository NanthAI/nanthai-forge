// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef } from 'react';
import { aliveDefaults, createRiver, type AliveOptions, type Colors } from './alive-world';
import { drawRiver } from './alive-draw';

declare global {
  interface Window {
    FORGE_ALIVE?: Partial<AliveOptions> & { colors?: Partial<Colors> };
  }
}

/** Decorative film only; repository exploration keeps its separate, interactive graph. */
export function AliveHero() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d', { desynchronized: true });
    if (!canvas || !ctx) return;
    const options = { ...aliveDefaults, ...window.FORGE_ALIVE };
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    const stillAt = new URLSearchParams(location.search).get('t');
    const still = stillAt !== null && Number.isFinite(Number(stillAt));
    const colors = {} as Colors;
    let world: ReturnType<typeof createRiver>;
    let raf = 0,
      timer = 0,
      last = 0,
      acc = 0,
      running = false,
      onscreen = false;
    const step = 1 / 60;
    function paint() {
      if (world) drawRiver(ctx!, world, colors, options);
    }
    function readColors() {
      const root = document.documentElement;
      const css = getComputedStyle(root);
      const light = root.dataset.theme !== 'dark';
      Object.assign(
        colors,
        {
          trunk: light ? '#7b8696' : '#6f7a8a',
          agent: light ? '#7b8696' : '#8a94a4',
          person: light ? '#1b8f84' : '#2fb8a9',
          you: css.getPropertyValue('--fx-brand').trim(),
          passed: css.getPropertyValue('--fx-passed').trim(),
          conflict: css.getPropertyValue('--fx-conflict').trim(),
        },
        options.colors,
      );
      paint();
    }
    function schedule() {
      // Sleep between painted frames instead of waking on every display refresh.
      timer = window.setTimeout(
        () => {
          raf = requestAnimationFrame(frame);
        },
        Math.max(0, 1000 / options.fps - (performance.now() - last) - 1),
      );
    }
    function frame(now: number) {
      if (!running) return;
      if (now - last < 1000 / options.fps - 1) {
        schedule();
        return;
      }
      acc += Math.min(0.1, (now - last) / 1000);
      last = now;
      while (acc >= step) {
        world.step(step);
        acc -= step;
      }
      paint();
      schedule();
    }
    function stop() {
      running = false;
      cancelAnimationFrame(raf);
      clearTimeout(timer);
    }
    function update() {
      const should = onscreen && !document.hidden && !motion.matches && !still;
      if (!should) stop();
      else if (!running) {
        running = true;
        last = performance.now();
        schedule();
      }
    }
    function resize() {
      const bounds = canvas!.getBoundingClientRect();
      const hero = canvas!.parentElement!.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.round(bounds.width * dpr),
        height = Math.round(bounds.height * dpr);
      if (world && canvas!.width === width && canvas!.height === height) return;
      canvas!.width = width;
      canvas!.height = height;
      ctx!.setTransform(dpr, 0, 0, dpr, -(bounds.left - hero.left) * dpr, -(bounds.top - hero.top) * dpr);
      world = createRiver(hero.width, hero.height, colors, options);
      const pre = still ? Math.max(0, Number(stillAt)) : 14;
      for (let i = 0; i < pre * 60; i++) world.step(step);
      paint();
    }
    readColors();
    resize();
    const theme = new MutationObserver(readColors);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const size = new ResizeObserver(resize);
    size.observe(canvas);
    const viewport = new IntersectionObserver(
      entries => {
        onscreen = (entries[0]?.intersectionRatio ?? 0) >= 0.05;
        update();
      },
      { threshold: [0, 0.05] },
    );
    viewport.observe(canvas);
    document.addEventListener('visibilitychange', update);
    motion.addEventListener('change', update);
    window.addEventListener('resize', resize);
    return () => {
      stop();
      theme.disconnect();
      size.disconnect();
      viewport.disconnect();
      document.removeEventListener('visibilitychange', update);
      motion.removeEventListener('change', update);
      window.removeEventListener('resize', resize);
    };
  }, []);
  return <canvas ref={ref} className="fx-alive" aria-hidden="true" />;
}
