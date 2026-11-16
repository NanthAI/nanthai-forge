// SPDX-License-Identifier: Apache-2.0
// Entry for web/ds.html, the dev-only reference surface (Item 6ebb58ab).
import { createRoot } from 'react-dom/client';
import '../index';
import { Reference } from './Reference';

createRoot(document.getElementById('root')!).render(<Reference />);
