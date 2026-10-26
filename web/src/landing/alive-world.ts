// SPDX-License-Identifier: Apache-2.0
// The seeded river from the approved landing-alive Fable reference.
export const aliveDefaults = {
  seed: 7,
  density: 1,
  speed: 1.15,
  fps: 40,
  trailSeconds: 9,
  youEvery: 26,
  conflictChance: 0.25,
  acceptChance: 0.7,
  opacity: 1,
};
export type AliveOptions = typeof aliveDefaults;
export type Colors = {
  trunk: string;
  agent: string;
  person: string;
  you: string;
  passed: string;
  conflict: string;
};
type Kind = 'agent' | 'person' | 'you';
export type Sample = { x: number; y: number; at: number };
export type Mark = { x: number; at: number; color: string };
export type Effect = Sample & { kind: 'pulse' | 'land' | 'conflict' | 'hand'; color: string };
export type Thread = {
  kind: Kind;
  x: number;
  y: number;
  vy: number;
  yTarget: number;
  side: number;
  speed: number;
  phase: 'branch' | 'drift' | 'braid' | 'rejoin' | 'exit';
  pt: number;
  driftFor: number;
  nodeIn: number;
  wob1: number;
  wob2: number;
  trail: Sample[];
  nodes: Sample[];
  alive: boolean;
  done: boolean;
  fade: number;
  partner: Thread | null;
  braidT: number;
  braidFor: number;
  braidPhase: number;
  touched: boolean;
  touchAt: number;
  outcome: 'accept' | 'exit' | 'diverge';
  child: boolean;
  braidAt: number;
  willTouch: boolean;
  braidY: number;
  handoff: boolean;
};
export function createRiver(W: number, H: number, C: Colors, P = aliveDefaults) {
  const trunkY = Math.round(H * 0.58);
  let s = P.seed >>> 0 || 1;
  const rnd = () => {
    s += 0x6d2b79f5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rr = (a: number, b: number) => a + rnd() * (b - a);
  // ---------- world ----------
  const threads: Thread[] = [],
    effects: Effect[] = [],
    trunkMarks: Mark[] = [];
  let time = 0,
    nextYou = 8,
    nextSpawn = 0.5;
  const BASE_SPEED = 42;

  function targetCount() {
    return Math.round(Math.max(6, Math.min(12, W / 150)) * P.density);
  }

  function spawn(kind: Kind, x: number, y: number, opts: { side?: number; child?: boolean } = {}) {
    const side = opts.side ?? (rnd() < 0.5 ? -1 : 1);
    const t: Thread = {
      kind,
      x,
      y,
      vy: 0,
      yTarget: trunkY + side * rr(46, Math.min(170, H * 0.34)),
      side,
      speed: BASE_SPEED * P.speed * rr(0.85, 1.15),
      phase: 'branch',
      pt: 0,
      driftFor: rr(6, 14),
      nodeIn: rr(1.6, 3.2),
      wob1: rr(0, 6.28),
      wob2: rr(0, 6.28),
      trail: [],
      nodes: [],
      alive: true,
      done: false,
      fade: 1,
      partner: null,
      braidT: 0,
      braidFor: rr(4, 7),
      braidPhase: rnd() * 6.28,
      touched: false,
      touchAt: 0,
      outcome: rnd() < P.acceptChance ? 'accept' : 'exit',
      child: opts.child || false,
      braidAt: 0,
      willTouch: false,
      braidY: 0,
      handoff: false,
    };
    threads.push(t);
    return t;
  }

  function spawnFromTrunk() {
    const kind = rnd() < 0.78 ? 'agent' : 'person';
    const x = rr(-W * 0.05, W * 0.72);
    const t = spawn(kind, x, trunkY);
    // Pairs: a second thread branches close by and will braid with the first.
    if (rnd() < 0.45) {
      const u = spawn(rnd() < 0.8 ? 'agent' : 'person', x + rr(-24, 24), trunkY, { side: t.side });
      t.partner = u;
      u.partner = t;
      t.speed = u.speed = (t.speed + u.speed) / 2;
      t.braidAt = u.braidAt = rr(4, 8);
      const conflict = rnd() < P.conflictChance;
      t.willTouch = u.willTouch = conflict;
      t.outcome = u.outcome = rnd() < P.acceptChance ? 'accept' : 'diverge';
    }
  }

  function spawnYou() {
    const x = rr(W * 0.05, W * 0.55);
    const you = spawn('you', x, trunkY);
    you.driftFor = rr(3, 4.5);
    you.handoff = true;
    you.outcome = 'accept';
  }

  function step(dt: number) {
    time += dt;
    // spawning
    const active = threads.filter(t => !t.done && !t.child).length;
    nextSpawn -= dt;
    if (active < targetCount() && nextSpawn <= 0) {
      spawnFromTrunk();
      nextSpawn = rr(0.6, 1.8);
    }
    nextYou -= dt;
    if (nextYou <= 0) {
      spawnYou();
      nextYou = P.youEvery * rr(0.8, 1.2);
    }

    for (const t of threads) {
      if (t.done) {
        t.fade -= dt / 3;
        if (t.fade <= 0) t.alive = false;
        continue;
      }
      t.pt += dt;
      t.x += t.speed * dt;
      // phase machine
      if (t.phase === 'branch' && t.pt > 1.4) {
        t.phase = 'drift';
        t.pt = 0;
      } else if (t.phase === 'drift') {
        t.nodeIn -= dt;
        if (t.nodeIn <= 0) {
          t.nodeIn = rr(1.8, 3.6);
          t.nodes.push({ x: t.x, y: t.y, at: time });
          if (rnd() < 0.35) effects.push({ kind: 'pulse', x: t.x, y: t.y, at: time, color: C.passed });
        }
        if (t.handoff && t.pt > t.driftFor) {
          // the orange thread hands work to an agent, then returns to main and "watches"
          const kid = spawn('agent', t.x, t.y, { side: t.side, child: true });
          kid.yTarget = t.y + t.side * rr(30, 60);
          kid.driftFor = rr(7, 11);
          kid.outcome = 'accept';
          kid.speed = t.speed * 1.05;
          effects.push({ kind: 'hand', x: t.x, y: t.y, at: time, color: C.you });
          t.handoff = false;
          t.phase = 'rejoin';
          t.pt = 0;
          t.yTarget = trunkY;
        } else if (t.partner && t.braidAt && t.pt > t.braidAt && t.partner.phase === 'drift') {
          const mid = (t.y + t.partner.y) / 2;
          t.phase = t.partner.phase = 'braid';
          t.pt = t.partner.pt = 0;
          t.braidY = t.partner.braidY = mid;
          t.partner.braidPhase = t.braidPhase + Math.PI;
          t.partner.x = t.x; // align heads
        } else if (!t.partner && t.pt > t.driftFor) {
          t.phase = t.outcome === 'accept' ? 'rejoin' : 'exit';
          t.pt = 0;
          t.yTarget = trunkY;
        } else if (t.partner && !t.braidAt && t.pt > t.driftFor) {
          t.phase = 'exit';
        }
      } else if (t.phase === 'braid') {
        const amp = 7;
        const touching = t.willTouch && !t.touched && t.pt > t.braidFor * 0.45;
        if (touching) {
          t.touched = t.partner!.touched = true;
          t.touchAt = t.partner!.touchAt = time;
          effects.push({ kind: 'conflict', x: t.x, y: t.braidY, at: time, color: C.conflict });
        }
        const squeeze = t.touched ? Math.min(1, Math.max(0, (time - t.touchAt - 0.2) / 0.8)) : 1; // collapse then re-open
        const a = t.touched && time - t.touchAt < 1 ? amp * (1 - 0.95 * (1 - squeeze)) : amp;
        t.yTarget = t.braidY + Math.sin(t.pt * 2.2 + t.braidPhase) * a;
        if (t.pt > t.braidFor) {
          if (t.outcome === 'accept') {
            t.phase = 'rejoin';
            t.yTarget = trunkY;
          } else {
            t.phase = 'drift';
            t.driftFor = rr(3, 6);
            t.braidAt = 0;
            t.yTarget = t.braidY + (t.braidPhase > 3 ? 1 : -1) * rr(50, 110);
            t.partner = null;
          }
          t.pt = 0;
        }
      } else if (t.phase === 'rejoin') {
        if (Math.abs(t.y - trunkY) < 1.2 && t.pt > 1.2) {
          t.done = true;
          t.y = trunkY;
          effects.push({
            kind: 'land',
            x: t.x,
            y: trunkY,
            at: time,
            color: t.kind === 'you' ? C.you : C.passed,
          });
          trunkMarks.push({ x: t.x, at: time, color: t.kind === 'you' ? C.you : C.passed });
        }
      } else if (t.phase === 'exit') {
        /* keeps drifting off the right edge */
      }

      // motion: ease y towards target, add a slow wobble
      const wob = Math.sin(time * 0.6 + t.wob1) * 3 + Math.sin(time * 1.7 + t.wob2) * 1.2;
      const goal = t.phase === 'rejoin' ? t.yTarget : t.yTarget + wob;
      const k = t.phase === 'branch' ? 1.6 : t.phase === 'braid' ? 6 : t.phase === 'rejoin' ? 2.0 : 1.4;
      // ease towards the goal, but never steeper than ~40°: |dy| <= 0.85 * dx per step
      let dy = (goal - t.y) * Math.min(1, k * dt);
      const maxDy = t.phase === 'braid' ? 1e9 : t.speed * dt * 0.85;
      if (dy > maxDy) dy = maxDy;
      else if (dy < -maxDy) dy = -maxDy;
      // smooth the vertical velocity so corners round instead of kink
      t.vy += (dy - t.vy) * Math.min(1, (t.phase === 'braid' ? 12 : 3.2) * dt);
      t.y += t.vy;
      t.trail.push({ x: t.x, y: t.y, at: time });
      if (t.x > W + 40) t.done = true;
    }
    // prune
    for (const t of threads) {
      const cutoff = time - P.trailSeconds;
      while (t.trail.length && t.trail[0]!.at < cutoff) t.trail.shift();
      t.nodes = t.nodes.filter(n => n.at > cutoff);
      if (t.done && !t.trail.length) t.alive = false;
    }
    for (let i = threads.length - 1; i >= 0; i--) if (!threads[i]!.alive) threads.splice(i, 1);
    for (let i = effects.length - 1; i >= 0; i--) if (time - effects[i]!.at > 1.6) effects.splice(i, 1);
    for (let i = trunkMarks.length - 1; i >= 0; i--)
      if (time - trunkMarks[i]!.at > 24) trunkMarks.splice(i, 1);
  }

  return {
    step,
    threads,
    effects,
    trunkMarks,
    W,
    H,
    trunkY,
    get time() {
      return time;
    },
  };
}
export type River = ReturnType<typeof createRiver>;
