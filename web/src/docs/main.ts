// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Optional enhancements only: every document and link is present in the HTML without JavaScript.
import '../ds/base.css';
import '../ds/core.css';
import '../ds/public.css';
import '../ds/docs.css';

try {
  const theme = localStorage.getItem('forge-theme');
  if (theme === 'dark' || theme === 'light') document.documentElement.dataset.theme = theme;
} catch { /* Private windows keep the theme for this page. */ }
document.querySelector('[data-docs-theme]')?.addEventListener('click', () => {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('forge-theme', theme); } catch { /* Optional preference. */ }
});
if (matchMedia('(max-width: 860px)').matches) document.querySelector('details.docs-contents')?.removeAttribute('open');
const find = document.querySelector<HTMLInputElement>('[data-docs-find]');
find?.addEventListener('input', () => {
  const query = find.value.trim().toLocaleLowerCase();
  let matches = 0;
  for (const group of document.querySelectorAll<HTMLElement>('[data-docs-group]')) {
    let visible = 0;
    for (const row of group.querySelectorAll('li')) {
      row.hidden = !row.textContent?.toLocaleLowerCase().includes(query);
      if (!row.hidden) visible++;
    }
    group.hidden = !visible;
    const fold = group.querySelector('details');
    if (fold && query && visible) fold.open = true;
    matches += visible;
  }
  const empty = document.querySelector<HTMLElement>('.docs-no-results');
  if (empty) empty.hidden = matches > 0;
});
function copyText(button: HTMLButtonElement, code: HTMLElement, copied: () => void, failed: () => void) {
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(code.textContent ?? '');
      copied();
    } catch { failed(); }
  });
}

const prompt = document.querySelector<HTMLElement>('[data-docs-agent-prompt]');
if (prompt) {
  const twin = prompt.dataset.docsAgentPrompt!;
  const button = prompt.querySelector('button')!;
  const code = prompt.querySelector('code')!;
  const status = prompt.querySelector<HTMLElement>('[role="status"]')!;
  const disclosure = prompt.querySelector('details')!;
  const label = button.textContent;
  let reset: ReturnType<typeof setTimeout>;
  const guideUrl = new URL(new URL(twin).pathname, location.origin);
  code.textContent = code.textContent!.replace(twin, guideUrl.href);
  copyText(button, code, () => {
    clearTimeout(reset);
    status.textContent = '';
    button.textContent = 'Copied';
    reset = setTimeout(() => { button.textContent = label; }, 2_000);
  }, () => {
    clearTimeout(reset);
    button.textContent = label;
    disclosure.open = true;
    status.textContent = 'Could not copy. Select and copy the prompt.';
  });
  button.hidden = false;
}

for (const pre of document.querySelectorAll('pre')) {
  if (prompt?.contains(pre)) continue;
  const code = pre.querySelector('code');
  if (!code) continue;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn sm';
  button.textContent = 'Copy';
  button.setAttribute('aria-label', 'Copy code');
  const status = document.createElement('span');
  status.className = 'docs-copy-status';
  status.setAttribute('role', 'status');
  copyText(button, code, () => {
    status.textContent = 'Copied';
  }, () => {
    status.textContent = 'Could not copy. Select and copy the code.';
  });
  const actions = document.createElement('div');
  actions.className = 'docs-copy';
  actions.append(button, status);
  pre.after(actions);
}
