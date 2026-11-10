// SPDX-License-Identifier: Apache-2.0
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { invariant } from './errors.js';
import { mcpConfig } from './setup.js';

/** A machine-local Codex compatibility package reusing the installed Forge runtime. */
export function pluginConfig(root: string, directory: string): object {
  const config = mcpConfig(root, { agent: true });
  const destination = resolve(directory),
    plugin = 'plugins/nanthai-forge';
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  };
  // The packaged skill links docs relative to the repository; the plugin copy points at the installed docs.
  const skill = readFileSync(new URL('../skills/forge-agent/SKILL.md', import.meta.url), 'utf8').replace(
    /\]\(\.\.\/\.\.\/docs\/([^)#\s]+)/g,
    (_, path: string) => `](${new URL(`../docs/${path}`, import.meta.url).href}`,
  );
  const files: Record<string, string> = {
    '.agents/plugins/marketplace.json': json({
      name: 'nanthai-forge-local',
      interface: { displayName: 'Forge local workflow' },
      plugins: [
        {
          name: 'nanthai-forge',
          source: { source: 'local', path: `./${plugin}` },
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
          category: 'Developer tools',
        },
      ],
    }),
    [`${plugin}/.codex-plugin/plugin.json`]: json({
      name: 'nanthai-forge',
      version: manifest.version,
      description: 'Work with hosted Forge source, Lanes, checks and landings.',
      skills: './skills/',
      mcpServers: './.mcp.json',
    }),
    [`${plugin}/.mcp.json`]: json({
      mcpServers: { forge: { ...config.mcpServers.forge, env_vars: ['FORGE_AUTH_TOKEN'] } },
    }),
    [`${plugin}/skills/forge-agent/SKILL.md`]: skill,
    'README.md': `# Forge local agent plugin\n\nThis package connects the selected hosted Forge checkout through the installed Forge runtime. It contains configuration and the Forge workflow skill, without source files or credentials. Forge runs hosted projects only: a folder without a hosted marker is refused (\`nforge host ROOT\` makes one).\n\nAdd this directory as a local marketplace with \`codex plugin marketplace add PATH\`, then install **nanthai-forge** from **Forge local workflow** in the desktop Plugins directory. Restart the client after installing or updating its cached plugin.\n\nThe checkout, Node executable and Forge CLI use absolute paths in \`plugins/nanthai-forge/.mcp.json\`. Keep that runtime installed; generate a new package after moving it or changing the selected checkout. The skill's documentation links point at the same installed package.\n\nHosted access uses saved \`nforge login\` credentials or the \`FORGE_AUTH_TOKEN\` process environment; no credential is embedded here. Tools run under the local OS account.\n\nRemove this marketplace or disable the plugin in the client to disconnect it. Removing this generated directory does not delete Forge source or Work.\n`,
  };
  const existing = lstatSync(destination, { throwIfNoEntry: false });
  if (existing) {
    invariant(
      existing.isDirectory(),
      'PLUGIN_CONFIG_CHANGED',
      'Plugin destination is not the original generated directory. Choose a new directory.',
    );
    const actual: string[] = [];
    const visit = (relative: string) => {
      for (const entry of readdirSync(join(destination, relative), { withFileTypes: true })) {
        const path = relative ? `${relative}/${entry.name}` : entry.name;
        invariant(
          !entry.isSymbolicLink(),
          'PLUGIN_CONFIG_CHANGED',
          'Generated plugin contains a symbolic link. Choose a new directory.',
        );
        if (entry.isDirectory()) visit(path);
        else {
          invariant(entry.isFile(), 'PLUGIN_CONFIG_CHANGED', 'Generated plugin contains a non-file entry.');
          actual.push(path);
        }
      }
    };
    visit('');
    invariant(
      actual.length === Object.keys(files).length &&
        actual.every(
          path => files[path] !== undefined && readFileSync(join(destination, path), 'utf8') === files[path],
        ),
      'PLUGIN_CONFIG_CHANGED',
      'Plugin files or runtime configuration differ. Existing files were preserved; choose a new directory.',
    );
  } else {
    const stage = mkdtempSync(join(dirname(destination), '.forge-plugin-'));
    try {
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(dirname(join(stage, path)), { recursive: true, mode: 0o700 });
        writeFileSync(join(stage, path), text, { flag: 'wx', mode: 0o600 });
      }
      renameSync(stage, destination);
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  }
  return {
    directory: destination,
    plugin: join(destination, plugin),
    marketplace: 'nanthai-forge-local',
    installed: false,
    runtime: fileURLToPath(new URL('./cli-entry.js', import.meta.url)),
    reused: Boolean(existing),
  };
}
