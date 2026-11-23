// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The public page's signature, Threads: main is one vertical line on the left, Lanes flow into it from the right as
// thin threads, and the trunk gains a layer below every landing. Hot orange is work in progress, a hollow amber head
// a held Lane, a dotted tie an overlap, green the moment of landing, ink is main.
// Loaded lazily by page.ts after first paint. No network, no storage. It draws through the page's one frame loop while
// the tab is visible, a signature section is on screen and motion is allowed. It never stops while visible: after 60 s
// without input it draws at 15 frames a second instead of 30. Reduced motion draws one representative still.
import { reducedMotion, runFrames, type FrameJob } from './frames';

type RGB = [number, number, number];
type State = 'active' | 'waiting' | 'conflict' | 'passed';
type Key = [time: number, pos: number, state: State, word: string];
type Box = [x0: number, y0: number, x1: number, y1: number, falloff: number];
interface Lane {
  title: string;
  k: Key[];
  y: number;
  born: number;
  x: number;
  p: number;
  st: State;
  word: string;
  landed: boolean;
  landT: number;
  f: number;
  hidden: boolean;
  hx: number;
  hy: number;
  front: number;
  tag?: HTMLElement;
  tagWord?: string | null;
  tagW: number;
  tagH: number;
  tr?: [number, number, number, number];
}

const RM = reducedMotion();
const root = document.documentElement;
const tok: Record<string, string> = {};
const C: Record<string, RGB> = {};
const TOKENS = ['text', 'text-3', 'bg', 'brand', 'waiting', 'passed', 'conflict', 'mark-warm'] as const;
const rgb = (hex: string): RGB => {
  const n = parseInt(hex.replace('#', ''), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const rgba = (c: RGB, a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a.toFixed(3)})`;
const mix = (a: RGB, b: RGB, u: number): RGB =>
  [0, 1, 2].map(i => Math.round(a[i]! + (b[i]! - a[i]!) * u)) as RGB;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const ease = (u: number) => ((u = clamp(u, 0, 1)), u * u * (3 - 2 * u));
const out = (u: number) => 1 - Math.pow(1 - clamp(u, 0, 1), 4);
const col = (k: (typeof TOKENS)[number]) => C[k] ?? [0, 0, 0];
function readTokens() {
  const cs = getComputedStyle(root);
  for (const k of TOKENS) {
    tok[k] = cs.getPropertyValue(`--${k}`).trim();
    C[k] = rgb(tok[k]);
  }
}

/* The hero loop, in seconds: the work runs from 0 to 14.2 (an overlap from 2.4 to 3.5, landings at 7.8, 11.2 and
   14.2); the landed state holds until HOLD, fades over OUT, stays empty for the rest of T, and the next pass fades in
   over IN. A key is [time, position 0 to 4, state, word]; state and word hold until the next key. The titles are
   illustrations, like the terminal on the page. */
const SCRIPT = {
  T: 21.6,
  HOLD: 20,
  OUT: 1.4,
  IN: 0.8,
  overlap: { a: 0, b: 1, from: 2.4, to: 3.5 },
  lanes: [
    {
      title: 'Fetch retry budget',
      k: [
        [0, 0.14, 'active', 'Editing'],
        [2.4, 1.3, 'conflict', 'Overlap'],
        [3.5, 1.36, 'active', 'Saved'],
        [4.1, 2.2, 'waiting', 'In queue'],
        [4.8, 3.1, 'active', 'Checking'],
        [7.3, 3.84, 'active', 'Checking'],
        [7.8, 4, 'passed', 'Landed'],
      ] as Key[],
    },
    {
      title: 'Cache headers',
      k: [
        [0, 0.1, 'active', 'Editing'],
        [2.4, 1.3, 'conflict', 'Overlap'],
        [3.5, 1.36, 'active', 'Saved'],
        [5.4, 2.36, 'waiting', 'Its turn next'],
        [8.2, 2.5, 'waiting', 'Its turn next'],
        [8.9, 3.1, 'active', 'Checking'],
        [10.7, 3.84, 'active', 'Checking'],
        [11.2, 4, 'passed', 'Landed'],
      ] as Key[],
    },
    {
      title: 'Import progress wording',
      k: [
        [0, 0.05, 'active', 'Editing'],
        [4.6, 1.0, 'active', 'Saved'],
        [7, 1.5, 'active', 'Saved'],
        [9.4, 2.3, 'waiting', 'Its turn next'],
        [11.5, 2.5, 'waiting', 'Its turn next'],
        [12.1, 3.1, 'active', 'Checking'],
        [13.7, 3.84, 'active', 'Checking'],
        [14.2, 4, 'passed', 'Landed'],
      ] as Key[],
    },
  ],
  caps: [
    [0, 'Three agents start work on the same codebase, each in its own Lane.'],
    [2.4, 'Every save is compared with the other Lanes. An overlap is reported now, before any check runs.'],
    [4.8, 'Forge checks the exact result on top of main, on your CI.'],
    [7.8, 'It passes and main moves. The next Lane is checked on top of it.'],
    [14.2, 'Three landed, each one checked on the main it joined.'],
  ] as [number, string][],
};
function ambientKeys(): Key[] {
  const r = Math.random,
    a = 2 + r() * 2.5,
    q = a + 0.8 + r() * 1.2,
    w = q + (r() < 0.6 ? 0.6 + r() * 1.8 : 0.1),
    c = w + 0.7,
    d = c + 1.4 + r() * 1.4;
  return [
    [0, 0, 'active', ''],
    [a, 1.2, 'active', ''],
    [q, 2.3, 'waiting', ''],
    [w, 2.45, 'waiting', ''],
    [c, 3.1, 'active', ''],
    [d, 3.84, 'active', ''],
    [d + 0.5, 4, 'passed', ''],
  ];
}
function laneAt(k: Key[], t: number) {
  let i = 0;
  while (i < k.length - 1 && t >= k[i + 1]![0]) i++;
  const a = k[i]!,
    b = k[i + 1];
  if (!b) return { p: a[1], st: a[2], word: a[3] };
  const u = ease((t - a[0]) / (b[0] - a[0]));
  return { p: a[1] + (b[1] - a[1]) * u, st: a[2], word: a[3] };
}
function diamond(c: CanvasRenderingContext2D, x: number, y: number, r: number) {
  c.beginPath();
  c.moveTo(x, y - r);
  c.lineTo(x + r, y);
  c.lineTo(x, y + r);
  c.lineTo(x - r, y);
  c.closePath();
}

/* One instance per signature section: the hero ("yard", scripted) and the close ("ambient", free running). */
class Sig {
  readonly cv: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly yardMode: boolean;
  readonly track: HTMLElement | null;
  readonly tagBox: HTMLElement | null;
  readonly cap: HTMLElement | null;
  inView = false;
  on = false;
  t = 0;
  prevLt = 0;
  fade = 1;
  ov = 0;
  capIx = -1;
  lanes: Lane[] = [];
  nodes: number[] = [];
  crisp: Box[] = [];
  W = 0;
  H = 0;
  mainX = 0;
  startX = 0;
  mainTop = 0;
  mainBot = 0;
  gap = 64;
  ys: number[] = [];
  stageW = 0;
  tagOff: [number, number, number] = [0, 0, 0];
  th = { L: 3, B: 4, r: 20, hr: 5 };
  dots: HTMLCanvasElement | null = null;

  constructor(
    readonly el: HTMLElement,
    cv: HTMLCanvasElement,
    ctx: CanvasRenderingContext2D,
  ) {
    this.cv = cv;
    this.ctx = ctx;
    this.yardMode = el.dataset.sig === 'yard';
    this.track = el.querySelector('[data-track]');
    this.tagBox = el.querySelector('.tags');
    this.cap = el.querySelector('[data-cap]');
  }

  layout() {
    let r = this.el.getBoundingClientRect();
    const W = (this.W = Math.round(r.width)),
      H = (this.H = Math.round(r.height)),
      dpr = Math.min(devicePixelRatio || 1, 2);
    this.cv.width = Math.round(W * dpr);
    this.cv.height = Math.round(H * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.cap) {
      /* reserve the tallest caption, so the yard never moves when the caption changes */
      const was = this.cap.textContent;
      let h = 0;
      this.cap.style.minHeight = '';
      for (const c of SCRIPT.caps) {
        this.cap.textContent = c[1];
        h = Math.max(h, Math.ceil(this.cap.getBoundingClientRect().height));
      }
      this.cap.textContent = was;
      this.cap.style.minHeight = `${h}px`;
      r = this.el.getBoundingClientRect();
    }
    this.crisp = [...this.el.querySelectorAll<HTMLElement>('[data-crisp]')].map(n => {
      const b = n.getBoundingClientRect();
      return [
        b.left - r.left,
        b.top - r.top,
        b.right - r.left,
        b.bottom - r.top,
        Number(n.dataset.crisp) || 70,
      ];
    });
    this.on = true;
    if (this.track && this.tagBox) {
      const b = this.track.getBoundingClientRect(),
        T = b.top - r.top;
      this.mainX = b.left - r.left;
      this.startX = b.right - r.left;
      this.mainTop = T - 28;
      this.mainBot = b.bottom - r.top + 6;
      this.gap = b.height * 0.3;
      this.ys = [0, 1, 2].map(i => T + b.height * (0.27 + i * 0.3));
      const tb = this.tagBox.getBoundingClientRect();
      this.tagOff = [tb.left - r.left, tb.top - r.top, tb.width];
    } else {
      /* the close: Lanes run on a stage beside the text, never behind it; without room for one, only the floor is drawn */
      let right = 0;
      for (const c of this.crisp) right = Math.max(right, c[2]);
      const x0 = Math.ceil(right) + 48;
      this.on = W - x0 >= 220;
      this.stageW = W - x0;
      this.mainX = x0;
      this.startX = W + 40;
      this.mainTop = 0;
      this.mainBot = H;
      this.gap = 64;
    }
    const phone = W < 600;
    this.th.L = phone ? 2 : 3;
    this.th.hr = phone ? 4 : 5;
    this.reset();
    this.th.r = clamp(this.gap * 0.42, 12, 30);
    if (this.yardMode) this.th.r = Math.min(this.th.r, this.mainBot - (this.nodes[2] ?? this.mainBot) - 6);
    this.buildDots(phone ? 20 : 24, dpr);
  }
  maskAt(x: number, y: number) {
    /* 1 in the open, 0 under and just around marked text, rising over that block's falloff distance */
    let m = 1;
    for (const c of this.crisp) {
      const dx = Math.max(c[0] - x, 0, x - c[2]),
        dy = Math.max(c[1] - y, 0, y - c[3]);
      m = Math.min(m, clamp((Math.hypot(dx, dy) - 10) / c[4], 0, 1));
    }
    return m;
  }
  /* The floor, a quiet grid of dots, is drawn once per layout into its own layer and copied each frame. */
  buildDots(pitch: number, dpr: number) {
    const layer = (this.dots ??= document.createElement('canvas'));
    layer.width = this.cv.width;
    layer.height = this.cv.height;
    const c = layer.getContext('2d');
    if (!c) return;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, this.W, this.H);
    c.fillStyle = tok['text-3'] ?? '#828d9d';
    for (let y = pitch / 2; y < this.H; y += pitch)
      for (let x = pitch / 2; x < this.W; x += pitch) {
        const m = this.maskAt(x, y);
        if (m <= 0.3) continue;
        c.globalAlpha = 0.16 * m;
        c.fillRect(x, y, 2, 2);
      }
  }
  open(x: number, y: number, pad: number) {
    for (const c of this.crisp)
      if (x > c[0] - pad && x < c[2] + pad && y > c[1] - pad && y < c[3] + pad) return false;
    for (const l of this.lanes) {
      const b = l.tr;
      if (b && x > b[0] - pad && x < b[0] + b[2] + pad && y > b[1] - pad && y < b[1] + b[3] + pad)
        return false;
    }
    return true;
  }
  reset() {
    this.t = 0;
    this.prevLt = 0;
    this.lanes = [];
    this.ov = 0;
    if (this.yardMode) {
      SCRIPT.lanes.forEach((d, i) => this.lanes.push(this.mk(d.title, d.k, this.ys[i] ?? 0, 0)));
      this.nodes = this.lanes.map(l => l.y).concat(this.mainBot);
      this.buildTags();
    } else if (this.on) {
      const n = this.stageW < 600 ? 2 : 4;
      for (let i = 0; i < n; i++) this.spawn(i * 2.6);
    }
  }
  mk(title: string, k: Key[], y: number, born: number): Lane {
    y = Math.round(y) + (this.W < 600 ? 0 : 0.5);
    return {
      title,
      k,
      y,
      born,
      x: this.startX,
      p: 0,
      st: 'active',
      word: '',
      landed: false,
      landT: 0,
      f: 1,
      hidden: false,
      hx: 0,
      hy: 0,
      front: 0,
      tagW: 0,
      tagH: 0,
    };
  }
  spawn(delay: number) {
    const taken = this.lanes.map(l => l.y);
    let y = 0,
      tries = 0;
    do {
      y = 56 + Math.random() * (this.H - 150);
      tries++;
    } while (tries < 24 && taken.some(v => Math.abs(v - y) < 62));
    this.lanes.push(this.mk('', ambientKeys(), y, this.t + delay));
  }
  buildTags() {
    if (!this.tagBox) return;
    this.tagBox.textContent = '';
    for (const l of this.lanes) {
      const d = document.createElement('div');
      d.className = 'tag';
      const b = document.createElement('b');
      b.textContent = l.title;
      d.append(b, document.createElement('span'));
      this.tagBox.append(d);
      l.tag = d;
      l.tagWord = null;
    }
  }
  xOf(p: number) {
    return this.startX + (this.mainX - this.startX) * (p / 4);
  }
  step(dt: number) {
    this.t += dt;
    const t = this.t,
      yard = this.yardMode;
    let lt = t,
      fade = 1;
    if (yard) {
      lt = t % SCRIPT.T;
      if (lt < this.prevLt)
        for (const l of this.lanes) {
          l.landed = false;
          l.x = this.startX;
        }
      this.prevLt = lt;
      fade =
        lt < SCRIPT.IN
          ? ease(lt / SCRIPT.IN)
          : lt > SCRIPT.HOLD
            ? 1 - ease((lt - SCRIPT.HOLD) / SCRIPT.OUT)
            : 1;
      let ci = 0;
      while (ci < SCRIPT.caps.length - 1 && lt >= SCRIPT.caps[ci + 1]![0]) ci++;
      if (ci !== this.capIx && this.cap) {
        const first = this.capIx < 0;
        this.capIx = ci;
        this.cap.textContent = SCRIPT.caps[ci]![1];
        if (!first && !RM.matches)
          this.cap.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: 420, easing: 'ease' });
      }
    }
    this.fade = fade;
    for (let i = this.lanes.length - 1; i >= 0; i--) {
      const l = this.lanes[i]!,
        age = (yard ? lt : t) - l.born;
      if (age < 0) {
        l.x = this.startX;
        l.hidden = true;
        continue;
      }
      l.hidden = false;
      const s = laneAt(l.k, age);
      l.x = this.xOf(s.p);
      l.st = s.st;
      l.word = s.word;
      l.p = s.p;
      if (s.p >= 4 && !l.landed) {
        l.landed = true;
        l.landT = t;
      }
      /* how present a Lane is: in the hero it follows the loop's fade; on the close a landed Lane fades a while later */
      l.f = yard ? fade : l.landed ? 1 - ease((t - l.landT - 3.4) / 1.4) : 1;
      if (!yard && l.landed && t - l.landT > 4.8) {
        this.lanes.splice(i, 1);
        this.spawn(0.4 + Math.random() * 1.6);
      }
    }
    if (yard) {
      const O = SCRIPT.overlap;
      this.ov =
        lt > O.from && lt < O.to + 0.4 ? ease((lt - O.from) / 0.24) * (1 - ease((lt - O.to) / 0.32)) : 0;
      this.placeTags();
    }
    this.frame(t);
  }
  placeTags() {
    const [ox, oy, bw] = this.tagOff,
      { B, L, r } = this.th,
      min = this.mainX - ox + B / 2 + L * 3 + r + 12;
    for (const l of this.lanes) {
      const d = l.tag;
      if (!d) continue;
      if (l.tagWord !== l.word) {
        l.tagWord = l.word;
        d.lastChild!.textContent = l.word;
        d.dataset.st = l.st;
        l.tagW = d.offsetWidth;
        l.tagH = d.offsetHeight;
      }
      const x = Math.round(clamp(l.x - ox + 14, min, Math.max(min, bw - l.tagW))),
        y = Math.round(l.y - oy - l.tagH - (this.gap < 70 ? 12 : 20));
      d.style.transform = `translate3d(${x}px,${y}px,0)`;
      d.style.opacity = this.fade < 1 ? this.fade.toFixed(2) : '';
      l.tr = [x + ox, y + oy, l.tagW, l.tagH];
    }
  }
  frame(t: number) {
    const { L, B, r, hr } = this.th,
      ctx = this.ctx,
      mx = Math.round(this.mainX),
      Q = Math.PI / 2;
    ctx.clearRect(0, 0, this.W, this.H);
    if (this.dots) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(this.dots, 0, 0);
      ctx.restore();
      /* the floor steps aside for the Lane tags, which move */
      for (const l of this.lanes)
        if (l.tr) ctx.clearRect(l.tr[0] - 8, l.tr[1] - 8, l.tr[2] + 14, l.tr[3] + 14);
    }
    const live = this.lanes.filter(l => !l.hidden),
      landed = live.filter(l => l.landed);
    for (const l of landed) l.front = l.y + r + (this.mainBot - l.y - r) * ease((t - l.landT) / 0.9);
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'round';
    ctx.lineWidth = L;
    for (const l of live) {
      let k = 0;
      for (const m of landed) if (m !== l && m.y < l.y) k += m.f * clamp((m.front - l.y - r) / 20, 0, 1);
      const xe = mx + B / 2 + L * k + L / 2,
        xa = xe + r,
        since = t - l.landT,
        f = l.landed ? 1 : clamp((xa - l.x) / (xa - this.mainX), 0, 1);
      l.hx = f > 0 ? xa - r * Math.sin(f * Q) : l.x;
      l.hy = f > 0 ? l.y + r - r * Math.cos(f * Q) : l.y;
      const cool = l.landed ? ease((since - 0.5) / 1.6) : 0,
        held = l.st === 'waiting',
        tail = l.landed ? mix(col('passed'), col('brand'), cool) : col('brand'),
        head = l.landed ? mix(col('passed'), col('text'), cool) : col('brand');
      const g = ctx.createLinearGradient(this.startX, 0, Math.min(l.hx, xa), 0),
        far = 0.16 + 0.14 * cool,
        near = l.landed ? 0.92 : held ? 0.8 : 1;
      g.addColorStop(0, rgba(tail, far * l.f));
      g.addColorStop(0.55, rgba(tail, (far + (near - far) * 0.5) * l.f));
      g.addColorStop(l.landed ? 0.86 : 1, rgba(tail, near * l.f));
      if (l.landed) g.addColorStop(1, rgba(head, near * l.f));
      ctx.strokeStyle = g;
      ctx.setLineDash(held ? [L, L * 2] : []); /* a held Lane's thread is broken */
      ctx.beginPath();
      ctx.moveTo(this.startX, l.y);
      ctx.lineTo(Math.max(l.x, xa), l.y);
      if (f > 0) ctx.arc(xa, l.y + r, r, -Q, -Q - f * Q, true);
      if (l.landed) ctx.lineTo(xe, l.front);
      ctx.stroke();
      ctx.setLineDash([]);
      if (l.landed && since < 0.9) {
        /* the hot tip of the pour */
        ctx.strokeStyle = rgba(col('mark-warm'), l.f);
        ctx.beginPath();
        ctx.moveTo(xe, Math.max(l.y + r, l.front - 16));
        ctx.lineTo(xe, l.front);
        ctx.stroke();
      }
      if (!l.landed && l.st === 'active' && l.p > 3) {
        /* checking: dots run ahead of the head along the way into main */
        ctx.fillStyle = rgba(col('brand'), 0.75 * l.f);
        const flat = Math.max(0, l.hx - xa),
          arc = r * Q * (1 - f);
        for (let d = 5 + ((t * 22) % 9); d < flat + arc; d += 9) {
          let x, y;
          if (d < flat) {
            x = l.hx - d;
            y = l.y;
          } else {
            const a = Math.min((f + (d - flat) / (r * Q)) * Q, Q);
            x = xa - r * Math.sin(a);
            y = l.y + r - r * Math.cos(a);
          }
          ctx.fillRect(Math.round(x - 1), Math.round(y - 1), 2, 2);
        }
      }
    }
    if (this.on) {
      ctx.fillStyle = rgba(col('text'), 0.92);
      ctx.fillRect(mx - B / 2, this.mainTop, B, this.mainBot - this.mainTop);
      for (const l of landed) {
        const u = (t - l.landT) / 0.5;
        if (u >= 1) continue; /* main rings once */
        const e = out(u),
          y0 = Math.max(this.mainTop + 34, l.y - 46),
          y1 = Math.min(this.mainBot, l.y + r + 46);
        ctx.fillStyle = rgba(col('passed'), (1 - u) * 0.8 * l.f);
        ctx.fillRect(mx - B / 2 - 3 - Math.round(8 * e), y0, 1, y1 - y0);
        ctx.fillRect(mx + B / 2 + L * 3 + 2 + Math.round(8 * e), y0, 1, y1 - y0);
      }
    }
    for (const l of live) {
      /* heads: a hot dot, a hollow amber ring when held, a diamond when two Lanes overlap */
      if (l.landed) continue;
      ctx.globalAlpha = l.f;
      if (l.st === 'conflict') {
        ctx.fillStyle = tok.conflict ?? '';
        diamond(ctx, l.hx, l.hy, hr + 2);
        ctx.fill();
      } else if (l.st === 'waiting') {
        ctx.fillStyle = tok.bg ?? '';
        ctx.strokeStyle = tok.waiting ?? '';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(l.hx, l.hy, hr, 0, 7);
        ctx.fill();
        ctx.stroke();
        ctx.lineWidth = L;
      } else {
        ctx.fillStyle = tok['mark-warm'] ?? '';
        ctx.beginPath();
        ctx.arc(l.hx, l.hy, hr, 0, 7);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    this.tie(this.W < 600 ? 2 : 3, hr + 7);
  }
  /* an overlap: a dotted tie between the heads of two Lanes, growing in from both ends and letting go the same way */
  tie(size: number, pad: number) {
    const O = SCRIPT.overlap,
      a = this.lanes[O.a],
      b = this.lanes[O.b],
      c = this.ctx;
    if (this.ov <= 0.01 || !this.yardMode || !a || !b) return;
    const x0 = a.hx,
      y0 = a.hy + pad,
      x1 = b.hx,
      y1 = b.hy - pad,
      len = y1 - y0,
      n = Math.floor(len / (size * 2.4));
    if (n < 1) return;
    c.fillStyle = tok.conflict ?? '';
    c.globalAlpha = this.fade;
    for (let i = 0; i < n; i++) {
      if (Math.min(i, n - 1 - i) > this.ov * (n / 2)) continue;
      const u = (i + 0.5) / n,
        x = x0 + (x1 - x0) * u,
        y = y0 + len * u;
      if (!this.open(x, y, 4)) continue;
      c.fillRect(Math.round(x - size / 2), Math.round(y - size / 2), size, size);
    }
    c.globalAlpha = 1;
  }
  still() {
    const n = this.yardMode ? 9.6 : 7;
    for (let s = 0; s < n * 30; s++) this.step(1 / 30);
  }
}

const stats = { ticks: 0, running: false, calm: 'awake' as 'awake' | 'slow', inView: 0 };
let started = false;

export function startHero() {
  if (started) return;
  started = true;
  (globalThis as { __forgeHero?: unknown }).__forgeHero = stats;
  const sigs: Sig[] = [];
  for (const el of document.querySelectorAll<HTMLElement>('[data-sig]')) {
    const cv = el.querySelector('canvas'),
      ctx = cv?.getContext('2d');
    if (cv && ctx) sigs.push(new Sig(el, cv, ctx));
  }
  if (!sigs.length) return;
  let last = 0,
    lastInput = performance.now();
  const want = () => !document.hidden && !RM.matches && sigs.some(s => s.inView);
  const job: FrameJob = now => {
    if (!want()) return (stats.running = false);
    stats.calm = now - lastInput > 60_000 ? 'slow' : 'awake';
    if (now - last < (stats.calm === 'slow' ? 63 : 30)) return true; /* 30 frames a second; 15 once calm */
    const dt = Math.min(0.07, (now - last) / 1000);
    last = now;
    stats.ticks++;
    for (const s of sigs) if (s.inView) s.step(dt);
    return true;
  };
  const kick = () => {
    if (stats.running || !want()) return;
    stats.running = true;
    last = performance.now();
    runFrames(job);
  };
  const touch = () => {
    lastInput = performance.now();
  };
  for (const e of ['pointermove', 'pointerdown', 'keydown', 'scroll', 'touchstart'])
    addEventListener(e, touch, { passive: true });
  document.addEventListener('visibilitychange', kick);
  const apply = () => {
    readTokens();
    for (const s of sigs) {
      s.layout();
      s.el.setAttribute('data-on', '');
      if (RM.matches) s.still();
    }
    kick();
  };
  RM.addEventListener('change', apply);
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', apply);
  new MutationObserver(apply).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  const io = new IntersectionObserver(entries => {
    for (const e of entries) {
      const s = sigs.find(x => x.el === e.target);
      if (s) s.inView = e.isIntersecting;
    }
    stats.inView = sigs.filter(s => s.inView).length;
    kick();
  });
  let rz = 0;
  const ro = new ResizeObserver(() => {
    clearTimeout(rz);
    rz = window.setTimeout(apply, 160);
  });
  for (const s of sigs) {
    io.observe(s.el);
    ro.observe(s.el);
    /* text blocks too: a late font swap or an opened disclosure moves them without resizing the section */
    for (const n of s.el.querySelectorAll('[data-crisp]:not([data-cap])')) ro.observe(n);
  }
  void (document.fonts?.ready ?? Promise.resolve()).then(apply);
}
