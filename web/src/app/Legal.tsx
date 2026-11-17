// SPDX-License-Identifier: Apache-2.0
import { PublicFrame } from './frames';
import { LEGAL_VERSION } from '../../../src/legal-version';
export default function Legal({ page }: { page: 'terms' | 'privacy' }) {
  return (
    <PublicFrame>
      <div className="intro">
        <h1>{page === 'terms' ? 'Terms' : 'Privacy policy'}</h1>
        <p>Draft {LEGAL_VERSION}, not legal advice. Pending owner approval before public launch.</p>
      </div>
      <article className="blk pad md">
        {page === 'terms' ? (
          <>
            <h2>Using Forge</h2>
            <p>
              Forge hosts source and work records for people and agents working together. A project’s settings
              determine access, checks and acceptance. Agent actions run through the account and device that
              authorize them.
            </p>
            <h2>Your work</h2>
            <p>
              Source snapshots, saved work and acceptance records identify what changed and who acted.
              Connecting a repository and running a check use the services you configure.
            </p>
            <h2>Before launch</h2>
            <p>
              This draft describes the service. Contract terms, operator identity, support contact and
              applicable legal terms await owner approval.
            </p>
          </>
        ) : (
          <>
            <h2>Data Forge uses</h2>
            <p>
              Forge keeps the account identity, sign-in methods, device approvals, project access, source and
              work records needed to run the service. Public identities use handles. Sign-in secrets and
              private device labels are not public profile fields.
            </p>
            <h2>Agents and data</h2>
            <p>
              Agents use the tools and providers chosen by their person. Forge records declared provenance
              separately from verified facts. Private source stays under the project’s access rules.
            </p>
            <h2>Browser storage</h2>
            <p>
              Sign-in storage and preferences support the app. Usage statistics do not require tracking
              cookies.
            </p>
            <h2>Before launch</h2>
            <p>
              Operator contact, final data-use commitments, retention and account-rights details await owner
              approval.
            </p>
          </>
        )}
        <p>
          <a className="lk" href="/-/signin">
            Sign in
          </a>{' '}
          ·{' '}
          <a className="lk" href={page === 'terms' ? '/-/privacy' : '/-/terms'}>
            {page === 'terms' ? 'Privacy policy' : 'Terms'}
          </a>
        </p>
      </article>
    </PublicFrame>
  );
}
