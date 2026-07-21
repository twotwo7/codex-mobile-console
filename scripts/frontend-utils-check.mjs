import assert from 'node:assert/strict';
import { buildBriefRounds, compactBriefMessages, oldestMessageOrderSeq } from '../public/brief-view.js';
import { compileTextSearch, createSearchTextCache, normalizeSearchText } from '../public/session-search.js';

assert.equal(normalizeSearchText('  Codex\n手机  '), 'codex 手机');

const emptySearch = compileTextSearch('');
assert.equal(emptySearch.active, false);
assert.equal(emptySearch.matches('anything'), true);

const search = compileTextSearch('服务器 维护');
assert.equal(search.active, true);
assert.equal(search.matches('codex 服务器维护 控制台'), true);
assert.equal(search.matches('服务器开发平台'), false);
assert.equal(search.matches(null), false);
assert.equal(compileTextSearch('CODEX').matches('Codex 控制台'), true);

const getSearchText = createSearchTextCache();
const session = {};
const first = getSearchText(session, ['Codex 控制台', '/root/Projects']);
const second = getSearchText(session, ['Codex 控制台', '/root/Projects']);
const changed = getSearchText(session, ['Codex 控制台', '/root/Projects/mobile']);
assert.equal(first, 'codex 控制台 /root/projects');
assert.equal(second, first);
assert.notEqual(changed, first);

const verboseRounds = [
  { id: 'u1', role: 'user', text: '第一轮', orderSeq: 1 },
  ...Array.from({ length: 900 }, (_, index) => ({
    id: `t${index}`,
    role: 'tool',
    text: `tool ${index}`,
    orderSeq: index + 2
  })),
  { id: 'a1', role: 'assistant', text: '第一轮过程', orderSeq: 902 },
  { id: 'a2', role: 'assistant', text: '第一轮结论', orderSeq: 903 },
  { id: 'done1', role: 'assistant', text: 'Codex run finished.', orderSeq: 904 },
  { id: 'u2', role: 'user', text: '第二轮', orderSeq: 905 },
  { id: 'a3', role: 'assistant', text: '第二轮结论', orderSeq: 906 }
];
const rounds = buildBriefRounds(verboseRounds);
assert.equal(rounds.length, 2);
assert.equal(rounds[0].outputCount, 903);
assert.equal(rounds[0].conclusion.id, 'a2');
assert.deepEqual(compactBriefMessages(verboseRounds).map((message) => message.id), ['u1', 'a2', 'u2', 'a3']);
assert.equal(oldestMessageOrderSeq(compactBriefMessages(verboseRounds)), 1);

console.log('frontend utility checks passed');
