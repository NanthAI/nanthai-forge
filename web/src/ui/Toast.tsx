import { useNativeValidationToasts } from './validation-toasts';
import { retryReads } from './read-retry';
// SPDX-License-Identifier: Apache-2.0
import {
  Children,
  createContext,
  isValidElement,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { Glyph } from './Glyph';
import { ToastStore, toastErrorText, type Toast, type ToastInput } from './toast-store';

const fallback = new ToastStore();
const ToastContext = createContext(fallback);
export const useToast = () => useContext(ToastContext);

function ToastItem({ entry, store }: { entry: Toast; store: ToastStore }) {
  useEffect(() => {
    if (entry.tone === 'error' || entry.persistent || entry.busy) return;
    const timer = setTimeout(() => store.dismiss(entry.id), 6000);
    return () => clearTimeout(timer);
  }, [entry.id, entry.at, entry.tone, entry.persistent, entry.busy, store]);
  return (
    <div className={`fx-toast fx-toast-${entry.tone}`} role={entry.tone === 'error' ? 'alert' : 'status'}>
      <span className="fx-toast-main">
        <Glyph
          name={entry.tone === 'error' ? 'failed' : entry.tone === 'success' ? 'passed' : 'info'}
          size={15}
        />
        <span id={entry.id}>
          {entry.message}
          {entry.count > 1 && <span aria-label={`${entry.count} occurrences`}> ×{entry.count}</span>}
        </span>
      </span>
      {entry.retry && (
        <button
          type="button"
          className="fx-btn fx-btn-secondary fx-btn-sm"
          disabled={entry.busy}
          onClick={() => void store.retry(entry.id)}
        >
          {entry.busy ? 'Retrying…' : 'Retry'}
        </button>
      )}
      {entry.action as ReactNode}
      <button
        type="button"
        className="fx-icon-btn fx-toast-x"
        aria-label="Dismiss"
        onClick={() => store.dismiss(entry.id)}
      >
        <Glyph name="close" size={13} />
      </button>
    </div>
  );
}
export function ToastProvider({
  children,
  store: suppliedStore,
}: {
  children: ReactNode;
  store?: ToastStore;
}) {
  const [store] = useState(() => suppliedStore ?? new ToastStore());
  useNativeValidationToasts(store);
  const entries = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  return (
    <ToastContext.Provider value={store}>
      {children}
      <BrowserConnection />
      <SignInErrors />
      <div className="fx fx-toast-stack" aria-label="Notifications">
        {entries.slice(0, 3).map(entry => (
          <ToastItem key={entry.id} entry={entry} store={store} />
        ))}
      </div>
      {entries.slice(3).map(entry => (
        <span hidden key={entry.id} id={entry.id}>
          {entry.message}
        </span>
      ))}
    </ToastContext.Provider>
  );
}

function content(nodes: ReactNode): { text: string; actions: ReactNode[] } {
  let text = '';
  const actions: ReactNode[] = [];
  Children.forEach(nodes, child => {
    if (typeof child === 'string' || typeof child === 'number') text += `${child} `;
    else if (isValidElement<{ children?: ReactNode; onClick?: unknown; href?: string }>(child)) {
      if (child.props.onClick || child.props.href) actions.push(child);
      else {
        const nested = content(child.props.children);
        text += nested.text;
        actions.push(...nested.actions);
      }
    }
  });
  return { text: text.trim(), actions };
}

/** Declarative bridge for query failures and existing mapped error copy. No inline error prose. */
function ErrorToastReport({
  children,
  error,
  retry,
  fieldIds,
  read,
}: {
  children?: ReactNode;
  error?: string;
  retry?: ToastInput['retry'];
  fieldIds?: string[];
  read?: boolean;
}) {
  const store = useToast();
  const marker = useRef<HTMLSpanElement>(null);
  const latest = useRef({ retry, children });
  latest.current = { retry, children };
  const message = toastErrorText(error ?? content(children).text);
  useEffect(() => {
    let retried = false;
    const parts = content(latest.current.children);
    const id = store.show({
      message,
      ...(latest.current.retry
        ? {
            retry: async () => {
              retried = true;
              const result = await latest.current.retry!();
              // Reads and event handlers report recovery by clearing their error slot.
              return result === undefined ? false : result;
            },
          }
        : {}),
      action: parts.actions.length ? <>{parts.actions}</> : undefined,
    });
    // A form keeps its draft and associates its quiet field markers with the toast sentence.
    const fields = fieldIds
      ? fieldIds.flatMap(id => {
          const field = document.getElementById(id);
          return field ? [field] : [];
        })
      : Array.from(
          (
            marker.current?.closest('form') ?? (!read ? marker.current?.parentElement : null)
          )?.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
            'input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=file]), textarea, select',
          ) ?? [],
        );
    const originals = fields.map(
      field => [field, field.getAttribute('aria-invalid'), field.getAttribute('aria-describedby')] as const,
    );
    for (const [field, , described] of originals) {
      field.setAttribute('aria-invalid', 'true');
      field.setAttribute('aria-describedby', [described, id].filter(Boolean).join(' '));
    }
    const restore = () => {
      for (const [field, invalid, described] of originals) {
        if (invalid === null) field.removeAttribute('aria-invalid');
        else field.setAttribute('aria-invalid', invalid);
        if (described === null) field.removeAttribute('aria-describedby');
        else field.setAttribute('aria-describedby', described);
      }
    };
    const unsubscribe = store.subscribe(() => {
      if (!store.snapshot().some(entry => entry.id === id)) restore();
    });
    return () => {
      unsubscribe();
      restore();
      if (retried) store.dismiss(id);
    };
  }, [message, store]);
  return <span ref={marker} className="fx-error-placeholder" aria-hidden="true" />;
}

export function ErrorToast(props: {
  children?: ReactNode;
  error?: string;
  retry?: ToastInput['retry'];
  read?: boolean;
  fieldIds?: string[];
}) {
  if (props.error !== undefined ? !props.error : !content(props.children).text) return null;
  const parts = content(props.children);
  const retryAction = parts.actions.find(
    action =>
      isValidElement<{ children?: ReactNode; onClick?: unknown }>(action) &&
      /^retry|^try again|^refresh/i.test(content(action.props.children).text),
  );
  const retry =
    props.retry ??
    (isValidElement<{ onClick?: () => unknown }>(retryAction) ? retryAction.props.onClick : undefined) ??
    (props.read ? retryReads : undefined);
  const remaining = parts.actions.filter(action => action !== retryAction);
  return (
    <ErrorToastReport {...props} {...(retry ? { retry } : {})}>
      {parts.text}
      {remaining}
    </ErrorToastReport>
  );
}

/** All connection observers share one notification; recovery removes it. */
export function ConnectionToast({ disconnected }: { disconnected: boolean }) {
  const store = useToast();
  const source = useId();
  useEffect(() => {
    store.connection(source, disconnected);
    return () => store.connection(source, false);
  }, [disconnected, source, store]);
  return null;
}
function BrowserConnection() {
  const [offline, setOffline] = useState(() => typeof navigator !== 'undefined' && !navigator.onLine);
  useEffect(() => {
    const update = () => setOffline(!navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return <ConnectionToast disconnected={offline} />;
}

/** Clerk owns its modal DOM. Bridge its error slots without replacing its sign-in flow. */
function SignInErrors() {
  const store = useToast();
  useEffect(() => {
    const seen = new WeakMap<Element, string>();
    const scan = () => {
      for (const node of document.querySelectorAll('.cl-alertText, .cl-formFieldErrorText')) {
        const text = node.textContent?.trim();
        if (!text || seen.get(node) === text) continue;
        seen.set(node, text);
        const id = store.show({ message: toastErrorText(text) });
        const field = node.closest('.cl-formField')?.querySelector('input');
        if (field) {
          field.setAttribute('aria-invalid', 'true');
          field.setAttribute('aria-describedby', id);
        }
      }
    };
    const observer = new MutationObserver(scan);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    scan();
    return () => observer.disconnect();
  }, [store]);
  return null;
}
