// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { Head } from '../Place';
import { A } from '../frames';
import Invitations from './Invitations';
import './people.css';
export default function InvitationHome() {
  return (
    <>
      <Head trail={[{ label: 'Home' }]} sentence="Your projects and invitations." />
      <Invitations />
      <section className="region quiet" aria-label="Your projects">
        <p className="quietline">
          <A href="/projects">Open your projects</A> · <A href="/settings">Account settings</A>
        </p>
      </section>
    </>
  );
}
