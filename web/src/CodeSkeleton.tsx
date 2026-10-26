// SPDX-License-Identifier: Apache-2.0
import './code.css';
/** Reserve the same heading, tree, file and inspector columns as the loaded browser. */
export function CodeSkeleton() {
  return (
    <section className="code-browser hosted-code" aria-label="Project code" aria-busy="true">
      <header className="code-heading">
        <h1>Code</h1>
      </header>
      <div className="workspace">
        <aside className="sidebar" aria-label="Repository files">
          <label className="search">
            <input type="search" aria-label="Find a file" placeholder="Find a file" disabled />
          </label>
          <h2>Files</h2>
          <p role="status" className="code-loading">
            Loading files…
          </p>
        </aside>
        <main className="main">
          <div className="empty">Select a file</div>
        </main>
        <aside className="inspector" aria-label="This file">
          <h2>This file</h2>
          <p className="inspector-file">Select a file</p>
        </aside>
      </div>
    </section>
  );
}
