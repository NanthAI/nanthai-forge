// SPDX-License-Identifier: Apache-2.0
// The old screens' styles, loaded with the old app (Hosted.tsx) and never with the rebuilt app under /- (web/src/app),
// whose design-system frames would otherwise pick up legacy rules such as .tabs and .main. Same order as before.
import './legacy.css';
import './planning.css';
import './ui/signals.css';
import './shell/shell.css';
import './shell/hosted-frame.css';
import './cockpit/cockpit.css';
import './cockpit/now.css';
import './cockpit/activity.css';
import './cockpit/delegate.css';
import './lane/lane.css';
import './lane/diff.css';
import './lane/lane-fable.css';
import './intents/intents.css';
import './explore/explore.css';
import './device/device.css';
