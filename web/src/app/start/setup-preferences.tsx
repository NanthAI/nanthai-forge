// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { useRef, useState } from 'react';
import { useMutation } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import { hostedError, hostedErrorCode } from '../../snapshot';
import { useToast } from '../trash/Toasts';
import type { SetupChange, SetupPreferences } from './setup-model';

export function useSetupPreferences(projectId: Id<'hostedProjects'>, preferences: SetupPreferences) {
  const write = useMutation(api.projectSetup.setPreferences);
  const { toast, show, clear } = useToast();
  const writing = useRef(false);
  const focus = useRef<'help' | 'heading' | null>(null);
  const [busy, setBusy] = useState(false);
  const focusAfterChange = (target: 'help' | 'heading') => (node: HTMLElement | null) => {
    if (!node || focus.current !== target) return;
    focus.current = null;
    node.focus();
  };
  async function apply(change: SetupChange, expectedRevision: number) {
    if (writing.current) return;
    writing.current = true;
    setBusy(true);
    if ('visibility' in change) focus.current = change.visibility === 'hidden' ? 'help' : 'heading';
    try {
      return await write({ projectId, operationId: crypto.randomUUID(), expectedRevision, change });
    } catch (error) {
      focus.current = null;
      throw error;
    } finally {
      writing.current = false;
      setBusy(false);
    }
  }
  async function change(next: SetupChange) {
    try {
      const result = await apply(next, preferences.revision);
      if (result && 'visibility' in next && next.visibility === 'hidden') {
        show('Getting started hidden. Bring it back from Help on Needs me.', async () => {
          await apply({ visibility: preferences.visibility }, result.revision);
        });
      }
    } catch (error) {
      show(hostedErrorCode(error) ? hostedError(error) : 'Could not save Getting started. Try again.');
    }
  }
  return { change, busy, toast, clear, focusAfterChange };
}
