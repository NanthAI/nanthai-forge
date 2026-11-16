// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from 'react';

/** An app address opened without a session. The public page itself is the static document at /. */
export function SignedOut({ signIn }: { signIn?: ReactNode }) {
  return (
    <section className="fx-signed-out" aria-labelledby="fx-signed-out-title">
      <h1 id="fx-signed-out-title">Sign in to open your projects</h1>
      <p>Lanes, checks and the decisions that wait for you are behind sign-in.</p>
      <div className="fx-signed-out-act">
        {signIn ?? <p className="fx-faint">Sign-in is not configured for this build.</p>}
        <a href="/">What Forge is</a>
      </div>
    </section>
  );
}
