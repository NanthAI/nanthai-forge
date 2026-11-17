// SPDX-License-Identifier: Apache-2.0
import type { AccountProps } from '../screen-route';
import { Head } from '../Place';
import { A } from '../frames';
import Invitations from './Invitations';
import './people.css';
export default function InvitationHome({ leave, handle }: Partial<AccountProps>) {
  return (
    <>
      <Head trail={[{ label: 'Home' }]} sentence="Your projects and invitations.">
        {leave ? (
          <button type="button" className="btn ghost" onClick={leave}>
            Use another account{handle ? ` (@${handle})` : ''}
          </button>
        ) : null}
      </Head>
      <Invitations />
      <section className="region quiet" aria-label="Your projects">
        <p className="quietline">
          <A href="/projects">Open your projects</A> · <A href="/settings">Account settings</A>
        </p>
      </section>
    </>
  );
}
