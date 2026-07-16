import assert from 'node:assert/strict';
import { createSerialExecutor, createSingleFlight } from '../server-concurrency.js';

const singleFlight = createSingleFlight();
let executions = 0;
const results = await Promise.all(Array.from({ length: 20 }, () => singleFlight('same-session', async () => {
  executions += 1;
  await new Promise((resolve) => setTimeout(resolve, 10));
  return 'imported-session';
})));
assert.equal(executions, 1);
assert.deepEqual(new Set(results), new Set(['imported-session']));

await assert.rejects(() => singleFlight('retryable', async () => {
  throw new Error('expected failure');
}));
assert.equal(await singleFlight('retryable', async () => 'retried'), 'retried');

await assert.rejects(
  () => singleFlight('sync-failure', () => {
    throw new Error('original synchronous failure');
  }),
  /original synchronous failure/
);

const serial = createSerialExecutor();
const order = [];
await Promise.all([
  serial(async () => {
    order.push('a:start');
    await new Promise((resolve) => setTimeout(resolve, 15));
    order.push('a:end');
  }),
  serial(async () => {
    order.push('b:start');
    order.push('b:end');
  })
]);
assert.deepEqual(order, ['a:start', 'a:end', 'b:start', 'b:end']);

await assert.rejects(() => serial(async () => {
  throw new Error('expected serial failure');
}));
assert.equal(await serial(async () => 'continued'), 'continued');

console.log('server concurrency checks passed');
