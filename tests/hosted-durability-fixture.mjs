// SPDX-License-Identifier: Apache-2.0
export const mainHead = 'a'.repeat(64);
export function durabilityFixture() {
  return {
    hostedProjects: [
      {
        _id: 'project',
        _creationTime: 1,
        work: { generationId: 'generation', backupId: 'backup', revision: 3 },
      },
    ],
    projectWorkGenerations: [
      {
        _id: 'generation',
        _creationTime: 2,
        projectId: 'project',
        backupId: 'backup',
        status: 'ready',
        recordsGenerationId: 'partition',
      },
    ],
    projectWorkHeads: [{ _id: 'work-head', projectId: 'project', backupId: 'backup', revision: 3 }],
    projectWorkRecords: [
      ['channels', 'main', { head: mainHead }],
      ['intents', 'intent', { title: 'Synthetic intent' }],
      ['lanes', 'lane', { head: mainHead }],
      ['views', 'view', { head: mainHead }],
      ['lanes:payload', 'chunk', { text: 'Retained full payload' }],
    ].map(([collection, key, value], i) => ({
      _id: `record-${i}`,
      _creationTime: i,
      projectId: 'project',
      generationId: 'partition',
      collection,
      key,
      value: JSON.stringify(value),
    })),
    _storage: [{ _id: 'blob', _creationTime: 1, size: 7 }],
    secretValues: [{ _id: 'encrypted', ciphertext: 'synthetic-ciphertext' }],
  };
}
