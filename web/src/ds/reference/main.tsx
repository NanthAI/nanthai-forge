// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Entry for web/ds.html, the dev-only reference surface (Item 6ebb58ab).
import { createRoot } from 'react-dom/client';
import { DockPerson } from '../index';
import { Reference } from './Reference';

const person = new URLSearchParams(location.search).get('viewer') ?? undefined;
createRoot(document.getElementById('root')!).render(
  <DockPerson value={person}>
    <Reference />
  </DockPerson>,
);
