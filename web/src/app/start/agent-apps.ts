// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Connecting the agent app a person already uses (Items c3e4a838, 6beca32b): the prompt that makes an agent explain
// before it sets anything up, and the commands that connect each app today. Forge works with any agent app and any
// CI and never starts an agent itself: these are words to paste and commands to run, nothing more. Every command here
// is one the CLI ships now (tests/app-getting-started.test.mjs checks each against the CLI's usage); the published package
// and the bare `nforge login` are Phase 8 and do not appear.
import { hrefFor } from '../paths';

export const agentApps = ['claude-code', 'codex', 'cursor', 'opencode', 'pi', 'other'] as const;
export type AgentApp = (typeof agentApps)[number];

export const agentAppLabels: Record<AgentApp, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  pi: 'Pi',
  other: 'Another app',
};

export const agentAppsSummary = `${agentApps
  .slice(0, -1)
  .map(app => agentAppLabels[app])
  .join(', ')}, or another app`;

/** A page of the docs that explains a step, so the step itself stays short (DESIGN.md rule 29). */
export type DocsLink = { label: string; href: string };

/** One step of a connection: the commands to run, who has to act, where on the web they act, and the docs that explain
 * it. `detail` is kept for words that change what the person does (where an entry goes, how to undo it). */
export type SetupStep = {
  title: string;
  detail?: string;
  commands: readonly string[];
  needsPerson?: boolean;
  optional?: boolean;
  link?: { label: string; href: string };
  docs?: readonly DocsLink[];
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

const HOOKS: DocsLink = { label: 'Hooks', href: '/docs/agents/workflow/#overlap-before-the-first-write' };
const MCP: DocsLink = { label: 'MCP', href: '/docs/agents/#connect-over-mcp' };
/** What an agent reads before it starts: the repository's instructions, then project and personal guidance. */
export const guidanceDocs: DocsLink = {
  label: 'What your agent reads first',
  href: '/docs/agents/#copy-prompts-and-briefings',
};

/** The steps every agent app shares: after these an agent runs nforge commands in its terminal and needs nothing
 * more. `deployment` is the backend address `nforge login` takes; `project` the project's address when there is one
 * (otherwise the agent imports first). */
export function sharedSteps(deployment: string, project?: string): SetupStep[] {
  return [
    {
      title: 'Install the command line',
      commands: INSTALL,
      docs: [{ label: 'Install guide', href: '/docs/quickstart/#install-the-development-cli' }],
    },
    {
      title: 'Sign this machine in',
      detail:
        'It prints a code and a link to the approval page here. Check that the code matches, name the device and approve; the agent waits until you do. It then shows with the same name and code under',
      commands: [`nforge login ${deployment}`],
      needsPerson: true,
      link: { label: 'Account, Sign-in and devices.', href: hrefFor({ frame: 'account', place: 'devices' }) },
      docs: [{ label: 'Devices and sign-ins', href: '/docs/guides/access/' }],
    },
    project
      ? {
          title: 'Clone the project',
          commands: [`nforge clone ${project} ./${project.split('/').at(-1) ?? 'project'}`],
        }
      : {
          title: 'Bring the repository across',
          commands: ['nforge import https://github.com/OWNER/REPO'],
        },
  ];
}

export const appStepTitle = 'Tools for your agent app';
/** The last step before an app is picked: the choice itself, and the docs for every app. */
export const appStepDocs: readonly DocsLink[] = [HOOKS, MCP];

const manualSetup: Record<AgentApp, string> = {
  'claude-code': 'Add the forge entry to mcpServers in .mcp.json in the project folder.',
  codex: 'Put the printed command and args in [mcp_servers.forge] in .codex/config.toml.',
  cursor: 'Add the forge entry to mcpServers in .cursor/mcp.json.',
  opencode:
    'In opencode.json or opencode.jsonc, add forge under mcp.servers. Set type to local and command to an array with the executable followed by its arguments.',
  pi: 'Add the forge entry to mcpServers in .pi/mcp.json. Pi reads project settings after it trusts the project.',
  other:
    'Add the printed forge entry to the app’s MCP settings. Remove that entry to undo. Any app with a terminal can run nforge agent . directly.',
};

/** MCP tools are optional. The shared CLI works from the terminal of any app. */
export function appStep(app: AgentApp): SetupStep {
  return {
    title: appStepTitle,
    optional: true,
    docs: appStepDocs,
    detail: manualSetup[app],
    commands: [app === 'other' ? 'nforge mcp-config . --agent' : `nforge connect ${app}`],
  };
}

/** Every step for one app, in order. */
export const setupSteps = (app: AgentApp, deployment: string, project?: string): SetupStep[] => [
  ...sharedSteps(deployment, project),
  appStep(app),
];

/** The address `nforge login` takes: this build's backend (public: the browser already talks to it). */
export const deploymentUrl = () =>
  (import.meta.env?.VITE_CONVEX_URL as string | undefined) ?? 'https://YOUR_DEPLOYMENT.convex.cloud';

const STORE = 'forge.start.app';
/** The app this browser picked last, a per-viewer convenience. Nothing is picked until the person picks: every app is
 * offered the same way. */
export function rememberedApp(): AgentApp | null {
  try {
    const value = localStorage.getItem(STORE);
    return (agentApps as readonly string[]).includes(value ?? '') ? (value as AgentApp) : null;
  } catch {
    return null;
  }
}
export function rememberApp(app: AgentApp) {
  try {
    localStorage.setItem(STORE, app);
  } catch {
    // a private window keeps the choice for this visit only
  }
}
