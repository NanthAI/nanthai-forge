// SPDX-License-Identifier: Apache-2.0
// Settings > Landing and checks: how a landing is checked (Item 871e9b73). One folded line per setting with its value
// in effect and where that value comes from; opening a line says what the setting does, what it costs and the owner's
// command that changes it. Nothing is explained while the lines are shut (DESIGN.md rule 29). It draws from the policy
// the page has already read: no call, no subscription. A web switch for most of these would restart queued landings
// (POLICY_CHANGED) with one press, and web control is an owner decision (question B9), so the page shows the command.
import type { AutonomyPolicy } from '../../../../src/autonomy-policy';
import type { LandingModeView } from '../../../../src/landing-mode';
import { Region } from '../../ds';
import { CommandBlock } from '../start/parts';
import { changeWords, landingSettings, settingCommand } from './landing-settings';
import './checks.css';

export function LandingSettings(props: {
  policy: AutonomyPolicy;
  landing: LandingModeView | null;
  owner: boolean;
}) {
  const { owner } = props;
  const settings = landingSettings(props.policy, props.landing);
  return (
    <Region title="How a landing is checked" hint={owner ? undefined : 'only the owner changes these'}>
      {settings.map(setting => (
        <details className="lset" key={setting.id}>
          <summary>
            <span className="ttl">
              {setting.title}
              {setting.note ? <span className="sub">{setting.note}</span> : null}
            </span>
            <span className="val">
              <b>{setting.value}</b>
              <span className="t3">{setting.source}</span>
            </span>
            <span className="tw" aria-hidden="true" />
          </summary>
          <div className="pad beside">
            <div className="gs-stack">
              <p className="meta t2">{setting.does}</p>
              <p className="meta t2">{setting.costs}</p>
              <p className="meta">
                <a className="lk" href={setting.docs}>
                  How it works, in the docs
                </a>
              </p>
            </div>
            {owner ? (
              <div className="gs-stack">
                <p className="meta t2">
                  To change it, run this in the project with VALUE as {setting.values}.{' '}
                  {changeWords[setting.change]}
                </p>
                <CommandBlock
                  label={`The command that changes ${setting.title}`}
                  text={settingCommand(setting)}
                />
              </div>
            ) : null}
          </div>
        </details>
      ))}
    </Region>
  );
}
