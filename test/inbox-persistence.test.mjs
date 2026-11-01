import test from 'node:test';
import assert from 'node:assert/strict';
import { commitUpdates } from '../src/core.mjs';

test('failed inbox persistence leaves cursor and jobs unchanged for replay', () => {
  const state = { cursor: 'old', jobs: [], seen: [] };
  const update = { get_updates_buf: 'new', msgs: [{ from_user_id: 'owner', message_type: 1,
    message_id: '1', context_token: 'context', item_list: [{ type: 1, text_item: { text: 'hello' } }] }] };
  assert.throws(() => commitUpdates(state, update, 'owner', () => { throw new Error('disk full'); }), /disk full/);
  assert.equal(state.cursor, 'old');
  assert.equal(state.jobs.length, 0);
  let disk;
  commitUpdates(state, update, 'owner', draft => { disk = structuredClone(draft); });
  assert.equal(state.cursor, 'new');
  assert.equal(state.jobs.length, 1);
  assert.deepEqual(state, disk);
  commitUpdates(state, update, 'owner', () => {});
  assert.equal(state.jobs.length, 1);
});
