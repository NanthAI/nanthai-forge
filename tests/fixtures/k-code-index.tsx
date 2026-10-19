// SPDX-License-Identifier: Apache-2.0
import { createRoot } from 'react-dom/client';
import HostedCode from '../../web/src/HostedCode';
import '../../web/src/style.css';
const head = 'a'.repeat(64);
const legacy = new URLSearchParams(location.search).has('legacy');
const runtime = globalThis as typeof globalThis & { __forgeTree: unknown; __codeReads: unknown[] };
runtime.__codeReads = [];
runtime.__forgeTree = {
  queries: {
    'projectWorkIndex:detail': () => ({ generationId: 'g1', value: legacy ? null : JSON.stringify({ head, files: 2 }) }),
  },
  pages: {
    'projectWorkIndex:records': (args: { collection: string }) => args.collection === 'sourceTreePaths'
      ? [{ value: JSON.stringify({ paths: ['README.md', 'src/main.ts'] }) }] : [],
  },
  actions: {
    'projectSourceReview:read': (args: { file?: string }) => {
      runtime.__codeReads.push(args);
      if (!args.file) {
        if (!legacy) throw new Error('Indexed trees must not request full source');
        return JSON.stringify({available:true, paths:[{path:'README.md'}, {path:'src/main.ts'}]});
      }
      return JSON.stringify({ available: true, file: { after: { blob: head } },
        after: { kind: 'text', text: 'export const value = 1;\n', offset: 0, line: 1, nextOffset: null } });
    },
  },
};
createRoot(document.getElementById('root')!).render(<HostedCode
  projectId={'project' as never} workspace={{generationId:'g1', backupId:'backup', sourceHead:head} as never}
  head={head} lanes={[]} />);
