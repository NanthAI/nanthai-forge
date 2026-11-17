// SPDX-License-Identifier: Apache-2.0
import { Writable } from 'node:stream';
import { secretFileFolder } from '../../dist/secret-run-files.js';
import { runWithSecrets } from '../../dist/secret-run.js';
const [root, tempRoot, mode] = process.argv.slice(2);
if (mode === 'killed') {
  const folder = secretFileFolder({ root, tempRoot });
  folder.write('FILE', Buffer.from('synthetic-file-material'));
  process.send({ path: folder.path });
  process.on('message', () => {});
} else {
  const sink = new Writable({ write(chunk, _encoding, done) {
    if (chunk.toString().includes('ready')) process.send({ ready: true });
    done();
  } });
  process.exitCode = await runWithSecrets({ root, command: [process.execPath, '-e', 'process.stdin.resume(); process.stdout.write("ready")'] },
    async () => ({ secrets: [{ name: 'FILE', kind: 'file', value: Buffer.from('synthetic-file-material') }] }),
    { source: {}, tempRoot, stdout: sink, stderr: sink, terminal: true });
}
