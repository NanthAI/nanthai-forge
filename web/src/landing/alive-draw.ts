// SPDX-License-Identifier: Apache-2.0
import type { Colors, River, Thread, AliveOptions } from './alive-world';
type Bounds = { x: number; y: number; width: number; height: number };
const previousPaint = new WeakMap<CanvasRenderingContext2D, Bounds>();

export function drawRiver(ctx: CanvasRenderingContext2D, world: River, C: Colors, P: AliveOptions) {
  const { W, trunkY, threads, effects, trunkMarks, time } = world;
  function alphaFor(at: number, t: Thread) {
    const age = time - at;
    const a = age > P.trailSeconds - 3 ? Math.max(0, (P.trailSeconds - age) / 3) : 1;
    return a * t.fade;
  }

  const matrix = ctx.getTransform();
  const left = -matrix.e / matrix.a,
    top = -matrix.f / matrix.d;
  const right = left + ctx.canvas.width / matrix.a,
    bottom = top + ctx.canvas.height / matrix.d;
  let minX = right,
    maxX = left,
    minY = bottom,
    maxY = top;
  function include(x: number, y: number, radius = 4) {
    if (x + radius < left || x - radius > right || y + radius < top || y - radius > bottom) return;
    minX = Math.min(minX, x - radius);
    maxX = Math.max(maxX, x + radius);
    minY = Math.min(minY, y - radius);
    maxY = Math.max(maxY, y + radius);
  }
  // Keep untouched transparent pixels out of the renderer's dirty region.
  // The static spine is cleared separately so its halo never accumulates.
  ctx.clearRect(0, trunkY - 5, W, 10);
  const previous = previousPaint.get(ctx);
  if (previous) ctx.clearRect(previous.x, previous.y, previous.width, previous.height);
  ctx.globalAlpha = P.opacity;
  // trunk
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // trunk: a soft halo under a 3px line so main reads as the spine of the scene
  ctx.globalAlpha = P.opacity * 0.18;
  ctx.strokeStyle = C.trunk;
  ctx.lineWidth = 9;
  ctx.beginPath();
  ctx.moveTo(-10, trunkY);
  ctx.lineTo(W + 10, trunkY);
  ctx.stroke();
  ctx.globalAlpha = P.opacity * 0.9;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(-10, trunkY);
  ctx.lineTo(W + 10, trunkY);
  ctx.stroke();
  for (const m of trunkMarks) {
    const a = Math.max(0, 1 - (time - m.at) / 24);
    include(m.x, trunkY);
    ctx.globalAlpha = P.opacity * a * 0.9;
    ctx.fillStyle = m.color;
    ctx.beginPath();
    ctx.arc(m.x, trunkY, 2.2, 0, 6.283);
    ctx.fill();
  }
  // Omit geometry in the fully masked part of the hero. The world still advances.
  // threads
  for (const t of threads) {
    if (t.trail.length < 2 || t.x < left - 8) continue;
    const col = t.kind === 'you' ? C.you : t.kind === 'person' ? C.person : C.agent;
    const flicker = t.touched && time - t.touchAt < 0.6 && Math.floor((time - t.touchAt) * 18) % 2 === 0;
    const strokeCol = flicker ? C.conflict : col;
    // Each trail is chronological, so equal fade bands are contiguous. Batch the
    // full-opacity path and sixteen fade bands instead of thousands of strokes.
    ctx.lineWidth = t.kind === 'agent' ? 0.8 : t.kind === 'you' ? 2 : 1.5;
    ctx.strokeStyle = strokeCol;
    const opacity = t.kind === 'agent' ? 0.28 : t.kind === 'you' ? 0.95 : 0.6;
    let band = -1;
    // A sample every four simulation steps is at most ~4 CSS pixels apart;
    // it retains the curve while avoiding subpixel line commands.
    for (let i = 1; i < t.trail.length; i += 4) {
      const previous = t.trail[Math.max(0, i - 1)]!,
        point = t.trail[Math.min(i + 3, t.trail.length - 1)]!;
      if (point.x < left - 8 || (point.y < top - 8 && previous.y < top - 8)) continue;
      include(previous.x, previous.y);
      include(point.x, point.y);
      const nextBand = Math.round(alphaFor(point.at, t) * 16);
      if (nextBand !== band) {
        if (band >= 0) ctx.stroke();
        band = nextBand;
        ctx.globalAlpha = (P.opacity * opacity * band) / 16;
        ctx.beginPath();
        ctx.moveTo(previous.x, previous.y);
      }
      ctx.lineTo(point.x, point.y);
    }
    if (band >= 0) ctx.stroke();
    if (t.kind === 'agent') {
      ctx.fillStyle = strokeCol;
      band = -1;
      for (let i = 0; i < t.trail.length; i += 4) {
        const point = t.trail[i]!;
        if (point.x < left - 8 || point.y < top - 8) continue;
        const nextBand = Math.round(alphaFor(point.at, t) * 16);
        if (nextBand !== band) {
          if (band >= 0) ctx.fill();
          band = nextBand;
          ctx.globalAlpha = (P.opacity * 0.75 * band) / 16;
          ctx.beginPath();
        }
        ctx.moveTo(point.x + 1.1, point.y);
        ctx.arc(point.x, point.y, 1.1, 0, 6.283);
      }
      if (band >= 0) ctx.fill();
    }
    // save nodes: squares for agents, circles for people / you
    for (const n of t.nodes) {
      include(n.x, n.y);
      ctx.globalAlpha = P.opacity * 0.9 * alphaFor(n.at, t);
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.2;
      ctx.fillStyle = col;
      if (t.kind === 'agent') {
        ctx.strokeRect(n.x - 2.5, n.y - 2.5, 5, 5);
      } else {
        ctx.beginPath();
        ctx.arc(n.x, n.y, 2.6, 0, 6.283);
        ctx.fill();
      }
    }
    // head
    if (!t.done) {
      include(t.x, t.y);
      ctx.globalAlpha = P.opacity * t.fade;
      ctx.fillStyle = strokeCol;
      ctx.beginPath();
      ctx.arc(t.x, t.y, t.kind === 'agent' ? 1.6 : 2.2, 0, 6.283);
      ctx.fill();
    }
  }
  // effects
  for (const e of effects) {
    include(e.x, e.y, e.kind === 'land' ? 60 : 30);
    const age = time - e.at;
    if (e.kind === 'pulse') {
      const k = Math.min(1, age / 0.9);
      if (k >= 1) continue;
      ctx.globalAlpha = P.opacity * 0.55 * (1 - k);
      ctx.strokeStyle = e.color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(e.x, e.y, 2 + 16 * k, 0, 6.283);
      ctx.stroke();
    } else if (e.kind === 'land') {
      const k = Math.min(1, age / 1.4);
      const g = ctx.createRadialGradient(e.x, e.y, 0, e.x, e.y, 30);
      g.addColorStop(0, e.color);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.globalAlpha = P.opacity * 0.55 * (1 - k);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(e.x, e.y, 30, 0, 6.283);
      ctx.fill();
      ctx.globalAlpha = P.opacity * (1 - k);
      ctx.strokeStyle = e.color;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(e.x - 14 - 40 * k, trunkY);
      ctx.lineTo(e.x + 14 + 40 * k, trunkY);
      ctx.stroke();
    } else if (e.kind === 'conflict') {
      const k = Math.min(1, age / 1.0);
      if (k >= 1) continue;
      ctx.globalAlpha = P.opacity * 0.8 * (1 - k);
      ctx.strokeStyle = e.color;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(e.x, e.y, 3 + 10 * k, 0, 6.283);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(e.x, e.y, 3 + 20 * k, 0, 6.283);
      ctx.stroke();
    } else if (e.kind === 'hand') {
      const k = Math.min(1, age / 1.2);
      if (k >= 1) continue;
      ctx.globalAlpha = P.opacity * 0.7 * (1 - k);
      ctx.strokeStyle = e.color;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(e.x, e.y, 3 + 14 * k, 0, 6.283);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
  if (maxX >= minX && maxY >= minY) {
    const x = Math.max(left, Math.floor(minX)),
      y = Math.max(top, Math.floor(minY));
    previousPaint.set(ctx, {
      x,
      y,
      width: Math.min(right, Math.ceil(maxX)) - x,
      height: Math.min(bottom, Math.ceil(maxY)) - y,
    });
  } else previousPaint.delete(ctx);
}
