// SPDX-License-Identifier: Apache-2.0
// Before a first project (`/new`, the bare frame): give a prompt to the agent app the person already uses, or import
// a repository yourself (Items 6beca32b, c3e4a838). The agent explains first and installs nothing until its person says
// so; Forge never starts an agent. The connection step reads this account’s confirmation once. The import
// door opens the import page (`/new/import`).
import type { ConvexReactClient } from 'convex/react';
import { Region } from '../../ds';
import { A } from '../frames';
import { Head } from '../Place';
import { hrefFor } from '../paths';
import { agentAppsSummary, deploymentUrl, explainFirstPrompt } from './agent-apps';
import { CommandBlock, ConnectSteps, CopyKey, FirstRunLine } from './parts';
import './start.css';

export default function Start({ connectionClient }: { connectionClient?: Pick<ConvexReactClient, 'query'> }) {
  const prompt = explainFirstPrompt(location.origin);
  return (
    <div className="gs">
      <Head
        trail={[{ label: 'Start your first project' }]}
        sentence="Give this to your agent, or import a repository yourself."
      />
      <FirstRunLine id="lane">
        Forge gives every agent its own Lane: it saves there, your CI checks the result, and it lands on main.
      </FirstRunLine>
      <div className="gs-doors">
        <Region title="Let your agent set it up">
          <div className="pad gs-stack">
            <p className="t2">
              Your agent reads one public file and tells you, in five lines, what would change. It installs
              nothing yet.
            </p>
            <div className="btns">
              <CopyKey text={prompt} label="Give this to your agent" kind="primary" size="lg" />
            </div>
          </div>
          <details className="gs-peek">
            <summary>See the prompt it copies</summary>
            <CommandBlock label="The prompt" text={prompt} />
          </details>
          <p className="quietline">
            When you say “set it up”, it stops where only you can act: approving its device and allowing Forge
            on GitHub.
          </p>
        </Region>
        <Region title="Import it yourself">
          <div className="pad gs-stack">
            <p className="t2">
              Pick a repository on GitHub. History comes with it, and nothing changes there.
            </p>
            <div className="btns">
              <A className="btn" href={hrefFor({ frame: 'bare', page: 'import' })}>
                Import from GitHub
              </A>
            </div>
          </div>
          <p className="quietline">
            Not on GitHub? Run <code translate="no">nforge host .</code> in the folder
          </p>
        </Region>
      </div>
      <Region
        title="Connect your agent app yourself"
        fold="start.connect"
        foldedByDefault
        sum={agentAppsSummary}
      >
        <ConnectSteps deployment={deploymentUrl()} connectionClient={connectionClient} />
      </Region>
    </div>
  );
}
