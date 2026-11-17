// SPDX-License-Identifier: Apache-2.0
/** The words of one invitation email. Plain text first; the HTML is the same words, styled inline from the design
 * tokens' light values (email clients ignore external CSS), with no images. */
export function inviteEmail(input: {
  inviter: string;
  project: string;
  role: 'read' | 'write';
  url: string;
}) {
  const can = input.role === 'write' ? 'read and change' : 'read';
  const subject = `${input.inviter} invited you to ${input.project} on Forge`;
  const text = [
    `${input.inviter} invited you to ${can} ${input.project} on Forge.`,
    '',
    `Open it: ${input.url}`,
    '',
    'Sign in with this email address, then accept the invitation. It expires after 7 days. Nothing happens if you ignore this email.',
  ].join('\n');
  const esc = (value: string) =>
    value.replace(
      /[&<>"']/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
    );
  const html =
    '<!doctype html><html><body style="margin:0;padding:24px;background:#f4f6f9;font-family:system-ui,sans-serif;color:#141a24">' +
    '<div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e3e7ed;border-radius:0;padding:24px">' +
    `<p style="margin:0 0 16px;font-size:16px;line-height:1.5"><b>${esc(input.inviter)}</b> invited you to ${can} <b>${esc(input.project)}</b> on Forge.</p>` +
    `<p style="margin:0 0 16px"><a href="${esc(input.url)}" style="display:inline-block;padding:8px 14px;border-radius:3px;background:#141a24;color:#ffffff;text-decoration:none;font-size:14px">Open ${esc(input.project)}</a></p>` +
    `<p style="margin:0;font-size:13px;line-height:1.5;color:#4f5b6b">Sign in with this email address, then accept the invitation. It expires after 7 days. Nothing happens if you ignore this email.</p>` +
    '</div></body></html>';
  return { subject, text, html };
}
