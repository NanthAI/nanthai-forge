// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { secretRunCli } from '../../dist/secret-run-cli.js';
// Simulate attached terminals without a browser or real secret provider.
Object.defineProperty(process.stdout, 'isTTY', { value: true });
Object.defineProperty(process.stderr, 'isTTY', { value: true });
await secretRunCli(['--root', process.argv[2], '--', process.execPath, '-e', 'process.stdout.write(process.env.TOKEN); process.stderr.write(process.env.TOKEN)'],
  async () => ({ secrets: [{ name: 'TOKEN', kind: 'env', value: Buffer.from('synthetic-marker-value') }] }));
