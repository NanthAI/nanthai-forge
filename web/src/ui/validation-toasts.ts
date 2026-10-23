// SPDX-License-Identifier: Apache-2.0
import { useEffect } from 'react';
import type { ToastStore } from './toast-store';

/** Native required/type validation uses the same notification and preserves the field value. */
export function useNativeValidationToasts(store: ToastStore) {
  useEffect(() => {
    const fields = new Map<HTMLElement, { id: string; invalid: string | null; described: string | null }>();
    const restore = (field: HTMLElement) => {
      const original = fields.get(field);
      if (!original) return;
      for (const [name, value] of [
        ['aria-invalid', original.invalid],
        ['aria-describedby', original.described],
      ]) {
        if (value === null) field.removeAttribute(name!);
        else field.setAttribute(name!, value!);
      }
      fields.delete(field);
    };
    const invalid = (event: Event) => {
      const field = event.target;
      if (!(
        field instanceof HTMLInputElement ||
        field instanceof HTMLTextAreaElement ||
        field instanceof HTMLSelectElement
      ))
        return;
      event.preventDefault();
      const id = store.show({ message: field.validationMessage });
      const original = fields.get(field);
      fields.set(field, {
        id,
        invalid: original ? original.invalid : field.getAttribute('aria-invalid'),
        described: original ? original.described : field.getAttribute('aria-describedby'),
      });
      field.setAttribute('aria-invalid', 'true');
      field.setAttribute('aria-describedby', id);
    };
    const input = (event: Event) => {
      const field = event.target;
      if (
        field instanceof HTMLInputElement ||
        field instanceof HTMLTextAreaElement ||
        field instanceof HTMLSelectElement
      ) {
        if (field.validity.valid) restore(field);
      }
    };
    const unsubscribe = store.subscribe(() => {
      for (const [field, state] of fields)
        if (!store.snapshot().some(entry => entry.id === state.id)) restore(field);
    });
    document.addEventListener('invalid', invalid, true);
    document.addEventListener('input', input, true);
    return () => {
      document.removeEventListener('invalid', invalid, true);
      document.removeEventListener('input', input, true);
      unsubscribe();
      for (const field of fields.keys()) restore(field);
    };
  }, [store]);
}
