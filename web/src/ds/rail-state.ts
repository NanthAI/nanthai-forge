// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { createContext, useCallback, useEffect, useRef, useState } from 'react';
import { keyAction } from '../app/router';

const storageKey = 'forge.rail';
const narrowScreen = '(max-width: 1240px)';
const phoneScreen = '(max-width: 860px)';
type Band = 'wide' | 'narrow';
type Choice = 'open' | 'shut';
const defaults: Record<Band, Choice> = { wide: 'open', narrow: 'shut' };
let sessionChoices: Record<Band, Choice> | undefined;

function readChoices(): Record<Band, Choice> {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    return {
      wide: stored?.wide === 'shut' ? 'shut' : 'open',
      narrow: stored?.narrow === 'open' ? 'open' : 'shut',
    };
  } catch {
    return { ...defaults };
  }
}

export const RailControls = createContext<{ shut: boolean; toggle: () => void } | null>(null);

function retainFocus(phone = false) {
  const active = document.activeElement;
  if (phone && active?.closest('.rail')) {
    document.getElementById('main')?.focus({ preventScroll: true });
  } else {
    active?.closest('.rail-pages')?.closest('.rail-place')?.querySelector<HTMLElement>('.rail-link')?.focus();
  }
}

export function useRailState() {
  const [band, setBand] = useState<Band>(() =>
    typeof matchMedia === 'function' && matchMedia(narrowScreen).matches ? 'narrow' : 'wide',
  );
  const [choices, setChoices] = useState(() => sessionChoices ?? readChoices());
  const choicesRef = useRef(choices);
  const bandRef = useRef(band);
  useEffect(() => {
    const media = matchMedia(narrowScreen);
    const phone = matchMedia(phoneScreen);
    const resize = () => {
      const next = media.matches ? 'narrow' : 'wide';
      if (phone.matches || choicesRef.current[next] !== choicesRef.current[bandRef.current])
        retainFocus(phone.matches);
      bandRef.current = next;
      setBand(next);
    };
    const sync = (event: StorageEvent) => {
      if (event.key !== storageKey && event.key !== null) return;
      sessionChoices = undefined;
      const next = readChoices();
      if (choicesRef.current[bandRef.current] !== next[bandRef.current]) retainFocus(phone.matches);
      choicesRef.current = next;
      setChoices(next);
    };
    media.addEventListener('change', resize);
    phone.addEventListener('change', resize);
    addEventListener('storage', sync);
    resize();
    return () => {
      media.removeEventListener('change', resize);
      phone.removeEventListener('change', resize);
      removeEventListener('storage', sync);
    };
  }, []);
  const toggle = useCallback(() => {
    if (matchMedia(phoneScreen).matches) return;
    retainFocus();
    const old = choicesRef.current;
    const next = { ...old, [band]: old[band] === 'open' ? 'shut' : 'open' } as Record<Band, Choice>;
    choicesRef.current = next;
    setChoices(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
      sessionChoices = undefined;
    } catch {
      sessionChoices = next;
    }
  }, [band]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || matchMedia(phoneScreen).matches) return;
      if (keyAction(event, event.target, false, true) !== 'rail') return;
      event.preventDefault();
      toggle();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [toggle]);
  return { shut: choices[band] === 'shut', toggle };
}
