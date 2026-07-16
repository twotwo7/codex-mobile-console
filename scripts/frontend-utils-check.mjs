import assert from 'node:assert/strict';
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

console.log('frontend utility checks passed');
