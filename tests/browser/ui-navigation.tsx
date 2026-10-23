// SPDX-License-Identifier: Apache-2.0
// Open through the repository-root Vite server; synthetic input, real navigation and draft guard.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { NavigationGuard, useUnsavedInput } from '../../web/src/ui/NavigationGuard';
import { useSection } from '../../web/src/WorkspaceUI';
import '../../web/src/ui/tokens.css';
import '../../web/src/ui/components.css';
function Fixture() {
  const [text, setText] = useState('');
  const [page, choose] = useSection('page', ['one', 'two', 'three'] as const, 'one');
  useUnsavedInput(Boolean(text.trim()), () => setText(''));
  return (
    <>
      <NavigationGuard />
      <main>
        <h1>{page}</h1>
        <label>
          Note
          <textarea value={text} onChange={event => setText(event.target.value)} />
        </label>
        <button onClick={() => setText('')}>Save</button>
        <a href="?page=two">Two</a>
        <button onClick={() => choose('three')}>Three</button>
      </main>
    </>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
