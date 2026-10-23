// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from 'react';
import { drafts, navigate, requestNavigation, setNavigationConfirmation } from './navigation';
import { Button } from './primitives';

/** Call with the actual draft and a reset callback; successful saves clear the draft normally. */
export function useUnsavedInput(dirty: boolean, discard: () => void) {
  const key = useRef(Symbol('draft'));
  const reset = useRef(discard);
  reset.current = discard;
  useEffect(() => {
    const id = key.current;
    if (dirty) drafts.set(id, () => reset.current());
    else drafts.delete(id);
    return () => {
      drafts.delete(id);
    };
  }, [dirty]);
}

/** Same-document links use the app router. Only real drafts can prompt, inside the app. */
export function NavigationGuard() {
  const [pending, setPending] = useState<(() => void) | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    setNavigationConfirmation(action => setPending(() => action));
    const click = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!(link instanceof HTMLAnchorElement) || link.target || link.hasAttribute('download')) return;
      const url = new URL(link.href);
      if (url.origin !== location.origin) return;
      const projectPath = /^\/(?:local|[^/]+)\/[^/]+(?:\/|$)/.test(url.pathname);
      if (url.pathname !== location.pathname && !projectPath) {
        if (!drafts.size) return;
        event.preventDefault();
        event.stopPropagation();
        requestNavigation(() => location.assign(url.href));
        return;
      }
      // Keep document anchors and their scrolling behavior intact.
      if (url.pathname === location.pathname && url.search === location.search) return;
      event.preventDefault();
      event.stopPropagation();
      navigate(url);
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (!drafts.size) return;
      event.preventDefault();
      event.returnValue = '';
    };
    // Stamp history entries so Back/Forward can restore the current page while a draft is reviewed.
    const push = history.pushState.bind(history),
      replace = history.replaceState.bind(history);
    let position = 0;
    let restoring = false;
    let approved = false;
    history.replaceState({ ...history.state, forgePosition: position }, '');
    history.pushState = (state, unused, url) => {
      position += 1;
      push({ ...state, forgePosition: position }, unused, url);
    };
    history.replaceState = (state, unused, url) =>
      replace({ ...state, forgePosition: position }, unused, url);
    const pop = (event: PopStateEvent) => {
      if (restoring) {
        restoring = false;
        event.stopImmediatePropagation();
        return;
      }
      const next = event.state?.forgePosition;
      // Synthetic popstate notifies URL subscribers after a push; it isn't browser traversal.
      if (!event.isTrusted || typeof next !== 'number') return;
      if (approved || !drafts.size) {
        approved = false;
        position = next;
        return;
      }
      const delta = next - position;
      if (!delta) return;
      event.stopImmediatePropagation();
      restoring = true;
      history.go(-delta);
      setPending(() => () => {
        approved = true;
        history.go(delta);
      });
    };
    document.addEventListener('click', click, true);
    addEventListener('beforeunload', unload);
    addEventListener('popstate', pop, true);
    return () => {
      setNavigationConfirmation();
      document.removeEventListener('click', click, true);
      removeEventListener('beforeunload', unload);
      removeEventListener('popstate', pop, true);
      history.pushState = push;
      history.replaceState = replace;
    };
  }, []);
  useEffect(() => {
    if (!pending) return;
    const opener = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => {
      dialog.current?.close();
      opener?.focus();
    };
  }, [pending]);
  return pending ? (
    <dialog
      ref={dialog}
      className="fx fx-draft-confirm"
      aria-labelledby="fx-draft-title"
      onCancel={event => {
        event.preventDefault();
        setPending(null);
      }}
    >
      <h2 id="fx-draft-title">Leave unsaved input?</h2>
      <p>Your draft has not been saved.</p>
      <div className="fx-reply-actions">
        <Button onClick={() => setPending(null)}>Keep editing</Button>
        <Button
          variant="primary"
          onClick={() => {
            const action = pending;
            for (const discard of drafts.values()) discard();
            drafts.clear();
            setPending(null);
            action();
          }}
        >
          Discard and leave
        </Button>
      </div>
    </dialog>
  ) : null;
}
