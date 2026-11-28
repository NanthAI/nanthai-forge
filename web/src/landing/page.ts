// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Behaviour for the public page (web/index.html). No network requests, no storage, no app code. Everything here
// waits for its section to be on screen and the tab to be visible; at rest the page schedules nothing.
// The page reads completely without this script: the race and the charts are written in their end state.
import { reducedMotion, runFrames, stopFrames, type FrameJob } from './frames';

const doc = document;
const $ = <T extends Element = HTMLElement>(s: string, n: ParentNode = doc) => n.querySelector<T>(s);
const $$ = <T extends Element = HTMLElement>(s: string, n: ParentNode = doc) => [...n.querySelectorAll<T>(s)];
const RM = reducedMotion();
const stats = { race: false, term: false };
(globalThis as { __forgeLanding?: unknown }).__forgeLanding = stats;

/* The copied prompt names this site's own discovery file, so a preview or self-hosted copy points at itself. */
const promptEl = $('[data-prompt]');
if (promptEl)
  promptEl.textContent = (promptEl.textContent ?? '').replace(
    /^Read \/llms\.txt on the site this prompt came from\./,
    `Read ${location.origin}/llms.txt.`,
  );

for (const btn of $$<HTMLButtonElement>('[data-copy]')) {
  const label = $('[data-label]', btn);
  if (!label) continue;
  const was = label.textContent ?? '';
  let reset = 0;
  btn.addEventListener('click', async () => {
    clearTimeout(reset);
    try {
      await navigator.clipboard.writeText(promptEl?.textContent ?? '');
      label.textContent = 'Copied. Paste it into your agent.';
    } catch {
      label.textContent = 'Copy did not work. The prompt is below.';
      const peek = $<HTMLDetailsElement>('.peek');
      if (peek) {
        peek.open = true;
        peek.scrollIntoView({ block: 'nearest', behavior: RM.matches ? 'auto' : 'smooth' });
      }
    }
    reset = window.setTimeout(() => (label.textContent = was), 2600);
  });
}

/* Sections know when they are on screen. CSS pauses its loops on data-live="0"; scripts below subscribe. */
type Live = (on: boolean) => void;
const listeners = new Map<Element, Live[]>();
const io = new IntersectionObserver(
  entries => {
    for (const e of entries) {
      const s = e.target as HTMLElement;
      s.dataset.live = e.isIntersecting ? '1' : '0';
      if (e.isIntersecting) s.classList.add('seen');
      for (const fn of listeners.get(s) ?? []) fn(e.isIntersecting);
    }
  },
  { rootMargin: '0px 0px -12% 0px' },
);
for (const s of $$('[data-live]')) io.observe(s);
const onLive = (el: Element, fn: Live) => {
  const s = el.closest('[data-live]');
  if (s) listeners.set(s, [...(listeners.get(s) ?? []), fn]);
};
const awake = (el: Element) =>
  (el.closest<HTMLElement>('[data-live]')?.dataset.live === '1' && !doc.hidden) as boolean;

/* The statement: words light as they cross the reading line, once. */
for (const p of $$('[data-reveal]')) {
  const words = (p.textContent ?? '').split(' ');
  p.textContent = '';
  words.forEach((w, i) => {
    const span = doc.createElement('span');
    span.className = 'wd';
    span.textContent = w;
    if (i) p.append(' ');
    p.append(span);
  });
  if (RM.matches) continue;
  const wio = new IntersectionObserver(
    entries => {
      for (const e of entries)
        if (e.isIntersecting) {
          e.target.classList.add('on');
          wio.unobserve(e.target);
        }
    },
    { rootMargin: '0px 0px -28% 0px' },
  );
  $$('.wd', p).forEach((w, i) => {
    w.style.transitionDelay = `${(i % 6) * 40}ms`;
    wio.observe(w);
  });
}

/* What the agent sees: typed while the section is on screen, replayed after a long pause, shown whole otherwise. */
const term = $('[data-term]');
if (term) {
  const lines = [...term.children] as HTMLElement[];
  const cmds = lines.filter(l => l.matches('.cmd'));
  const full = new Map(cmds.map(c => [c, c.textContent ?? '']));
  const showAll = () => {
    for (const c of cmds) c.textContent = full.get(c) ?? '';
    for (const l of lines) l.classList.add('on');
  };
  let timer = 0,
    run = 0;
  const wait = (ms: number) => new Promise<void>(r => (timer = window.setTimeout(r, ms)));
  const play = async () => {
    const me = ++run;
    stats.term = true;
    for (const c of cmds) c.textContent = '';
    for (const l of lines) l.classList.remove('on');
    for (const l of lines) {
      if (me !== run) return;
      const text = full.get(l);
      if (text !== undefined) {
        for (let i = 1; i <= text.length; i++) {
          if (me !== run) return;
          l.textContent = text.slice(0, i);
          await wait(26);
        }
        await wait(320);
      } else {
        l.classList.add('on');
        await wait($('.wd', l)?.textContent === 'checks' ? 1500 : 760);
      }
    }
    await wait(5200);
    if (me === run && awake(term)) play();
    else if (me === run) stats.term = false;
  };
  const halt = () => {
    clearTimeout(timer);
    run++;
    stats.term = false;
    showAll();
  };
  if (RM.matches) showAll();
  else {
    onLive(term, on => (on ? (clearTimeout(timer), play()) : halt()));
    doc.addEventListener('visibilitychange', () => (doc.hidden ? halt() : awake(term) && play()));
  }
}

/* The race: both runs to scale at 120 times speed, played once on first view, then it rests on its end state. */
const race = $('[data-race]');
const marks = race ? $$('[data-at]', race).map(n => ({ n, at: Number(n.dataset.at) })) : [];
const [fMedian, fFinish, gMedian, gFinish] = marks.filter(({ n }) => n.matches('.mk'));
if (race && !RM.matches && fMedian && fFinish && gMedian && gFinish) {
  const SPEED = 120;
  const clock = $('[data-clock]', race),
    rf = $('[data-run="f"]', race),
    rg = $('[data-run="g"]', race),
    out = $('[data-readout]', race),
    fs = $('[data-fs]', race),
    gs = $('[data-gs]', race);
  const F = { med: fMedian.at, all: fFinish.at };
  const G = { med: gMedian.at, all: gFinish.at };
  const gap = Math.round(G.med - F.med);
  const medianGap = `${Math.floor(gap / 60)} min ${gap % 60} s`;
  const finalReadout = out?.innerHTML ?? '';
  const mmss = (s: number) => {
    s = Math.round(s);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  let shown = '';
  const say = (key: string, text: string, rest = '') => {
    if (!out || shown === key) return;
    shown = key;
    if (key === 'end') return void (out.innerHTML = finalReadout);
    out.textContent = text;
    if (rest) {
      const span = doc.createElement('span');
      span.textContent = rest;
      out.append(' ', span);
    }
  };
  const phase = (s: number, x: { med: number; all: number }) =>
    s >= x.all ? 'all ten on main' : s >= x.med ? 'half on main' : 'ten agents working';
  const draw = (s: number) => {
    const cut = (v: number) => `inset(0 ${(100 - (Math.min(s, v) / G.all) * 100).toFixed(2)}% 0 0)`;
    if (rf) rf.style.clipPath = cut(F.all);
    if (rg) rg.style.clipPath = cut(G.all);
    if (clock) clock.textContent = mmss(Math.min(s, G.all));
    for (const m of marks) m.n.classList.toggle('on', s >= m.at);
    if (fs) fs.textContent = phase(s, F);
    if (gs) gs.textContent = phase(s, G);
    if (s >= G.all) say('end', '');
    else if (s >= F.all)
      say('c', 'Forge: all ten on main.', `The GitHub flow still has ${mmss(G.all - s)} to go.`);
    else if (s >= G.med)
      say('b2', `Half of the GitHub flow’s tasks are on main, ${medianGap} after Forge’s.`);
    else if (s >= F.med)
      say(
        'b',
        'Half of Forge’s tasks are on main.',
        `The GitHub flow’s median is ${medianGap} after Forge’s.`,
      );
    else say('a', 'Both runs start with the same ten tasks.');
  };
  let t = 0,
    last = 0,
    done = false,
    running = false;
  const job: FrameJob = now => {
    if (!awake(race)) return (running = stats.race = false);
    t += Math.min(0.05, (now - last) / 1000) * SPEED;
    last = now;
    if (t >= G.all) {
      draw(G.all);
      done = true;
      return (running = stats.race = false);
    }
    draw(t);
    return true;
  };
  const kick = () => {
    if (done || running || !awake(race)) return;
    running = stats.race = true;
    last = performance.now();
    runFrames(job);
  };
  draw(0);
  onLive(race, on => (on ? kick() : (stopFrames(job), (running = stats.race = false))));
  doc.addEventListener('visibilitychange', kick);
}

/* The hero signature loads after first paint, when the browser is idle. */
if ($('[data-sig]')) {
  const go = () => void import('./hero').then(m => m.startHero());
  const idle = () =>
    'requestIdleCallback' in window ? requestIdleCallback(go, { timeout: 1200 }) : setTimeout(go, 200);
  if (doc.readyState === 'complete') idle();
  else addEventListener('load', idle, { once: true });
}
