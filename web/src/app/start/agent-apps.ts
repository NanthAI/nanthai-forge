// SPDX-License-Identifier: Apache-2.0
// Connecting the agent app a person already uses (Items c3e4a838, 6beca32b): the prompt that makes an agent explain
// before it sets anything up, and the commands that connect each app today. Forge works with any agent app and any
// CI and never starts an agent itself: these are words to paste and commands to run, nothing more. Every command here
// is one the CLI ships now (tests/start-agent-apps.test.mjs checks each against the CLI's usage); the published package
// and the bare `nforge login` are Phase 8 and do not appear.
import { hrefFor } from '../paths';

export const agentApps = ['claude-code', 'codex', 'cursor', 'other'] as const;
export type AgentApp = (typeof agentApps)[number];

export const agentAppLabels: Record<AgentApp, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  other: 'Another app',
};

/** One step of a connection: what it does, the commands to run, who has to act, and where on the web they act. */
export type SetupStep = {
  title: string;
  detail: string;
  commands: readonly string[];
  needsPerson?: boolean;
  link?: { label: string; href: string };
};

/** The prompt the landing page copies, with this site's own discovery file. The agent explains first and installs
 * nothing until its person says so (owner decision 5.2). */
export function explainFirstPrompt(origin: string) {
  return [
    `Read ${origin}/llms.txt.`,
    '',
    'Then tell me, in five lines: what Forge would change about how you and other agents land work in this repository, what it would cost us in CI minutes compared with our current flow, and what you need from me to try it on one small change. Do not install anything yet.',
  ].join('\n');
}

/** The line that adds one more agent to a project that already exists. */
export function joinPrompt(origin: string, projectUrl: string) {
  return [
    `Read ${origin}/llms.txt.`,
    '',
    `Then join the Forge project ${projectUrl}: clone it, start your own Lane for the task I give you, save as you go and land it when its check passes. Tell me before anything that needs me.`,
  ].join('\n');
}

const INSTALL = [
  'git clone https://github.com/NanthAI/nanthai-forge.git',
  'cd nanthai-forge',
  'npm ci --ignore-scripts && npm run build:core && npm link --ignore-scripts',
];

/** The steps for one app. `deployment` is the backend address `nforge login` takes; `project` the project's address
 * when there is one (otherwise the agent imports first). */
export function setupSteps(app: AgentApp, deployment: string, project?: string): SetupStep[] {
  const steps: SetupStep[] = [
    {
      title: 'Install the command line',
      detail:
        'There is no published package yet: it installs from the source repository and updates itself to main.',
      commands: INSTALL,
    },
    {
      title: 'Sign this machine in',
      detail:
        'It prints a code and a link to the approval page here. Check that the code matches, name the device and approve; the agent waits until you do. It then shows with the same name and code under',
      commands: [`nforge login ${deployment}`],
      needsPerson: true,
      link: { label: 'Account, Sign-in and devices.', href: hrefFor({ frame: 'account', place: 'devices' }) },
    },
    project
      ? {
          title: 'Clone the project',
          detail: 'Each agent then starts its own Lane inside this folder.',
          commands: [`nforge clone ${project} ./${project.split('/').at(-1) ?? 'project'}`],
        }
      : {
          title: 'Bring the repository across',
          detail: 'History comes with it and nothing changes on GitHub.',
          commands: ['nforge import https://github.com/OWNER/REPO'],
        },
  ];
  if (app === 'claude-code')
    steps.push({
      title: 'Hooks and tools',
      detail:
        'The first nforge run adds advisory hooks to Claude Code and prints the undo. For tools as well as commands, add the printed forge entry to .mcp.json in the project folder.',
      commands: ['nforge mcp-config . --agent'],
    });
  else if (app === 'codex')
    steps.push({
      title: 'Hooks and plugin',
      detail:
        'The first nforge run adds advisory hooks to Codex and prints the undo. The plugin holds Forge’s skill and agent tools.',
      commands: ['nforge plugin-config . NEW_DIRECTORY'],
    });
  else if (app === 'cursor')
    steps.push({
      title: 'Tools over MCP',
      detail:
        'Cursor runs nforge agent commands in its terminal. For tools as well, add the printed forge entry to .cursor/mcp.json in the project folder; remove that entry to undo. Forge adds no hooks to Cursor.',
      commands: ['nforge mcp-config . --agent'],
    });
  else
    steps.push({
      title: 'Commands, or tools over MCP',
      detail:
        'Any app with a terminal runs nforge agent commands; nothing else to install. An app that reads MCP takes the printed forge entry in its MCP settings. Hooks cover Claude Code and Codex only.',
      commands: ['nforge mcp-config . --agent'],
    });
  return steps;
}

/** The address `nforge login` takes: this build's backend (public: the browser already talks to it). */
export const deploymentUrl = () =>
  (import.meta.env?.VITE_CONVEX_URL as string | undefined) ?? 'https://YOUR_DEPLOYMENT.convex.cloud';

const STORE = 'forge.start.app';
/** The app this browser picked last; a per-viewer convenience that falls back to the first app. */
export function rememberedApp(): AgentApp {
  try {
    const value = localStorage.getItem(STORE);
    return (agentApps as readonly string[]).includes(value ?? '') ? (value as AgentApp) : 'claude-code';
  } catch {
    return 'claude-code';
  }
}
export function rememberApp(app: AgentApp) {
  try {
    localStorage.setItem(STORE, app);
  } catch {
    // a private window keeps the choice for this visit only
  }
}
