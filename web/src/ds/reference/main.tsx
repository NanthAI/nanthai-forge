// SPDX-License-Identifier: Apache-2.0
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
