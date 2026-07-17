import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSqliteMessageStore, stateMetadataSnapshot } from '../state-store.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'cmc-state-store-'));
try {
  const store = createSqliteMessageStore({ databaseFile: path.join(root, 'messages.sqlite3') });
  await store.initialize();
  const state = {
    version: 1,
    sessions: {
      one: { id: 'one', title: 'One', messages: [{ id: 'm1', text: 'first' }, { id: 'm2', text: 'second' }] },
      two: { id: 'two', title: 'Two', messages: [{ id: 'm3', text: 'third' }] }
    }
  };
  assert.equal(await store.hydrateState(state), false);
  assert.ok((await store.persistMessages(state, { generation: 1 })).changed >= 3);
  assert.deepEqual(await store.stats(), { messageCount: 3, sessionCount: 2, generation: 1 });

  state.sessions.one.messages[0].text = 'updated';
  state.sessions.one.messages.pop();
  delete state.sessions.two;
  store.markSessionDirty('one');
  assert.ok((await store.persistMessages(state, { generation: 2 })).changed >= 3);
  assert.deepEqual(await store.stats(), { messageCount: 1, sessionCount: 1, generation: 2 });

  const metadata = stateMetadataSnapshot(state);
  assert.equal(Object.hasOwn(metadata.sessions.one, 'messages'), true);
  assert.equal(metadata.sessions.one.messages, undefined);
  const reloaded = JSON.parse(JSON.stringify(metadata));
  const nextStore = createSqliteMessageStore({ databaseFile: path.join(root, 'messages.sqlite3') });
  await nextStore.initialize();
  assert.equal(await nextStore.hydrateState(reloaded), true);
  assert.deepEqual(reloaded.sessions.one.messages, [{ id: 'm1', text: 'updated' }]);
  console.log('state store checks passed');
} finally {
  await rm(root, { recursive: true, force: true });
}
