import assert from 'node:assert/strict';
import { createConnectionState } from '../public/connection-state.js';
import { createFrontendEvents } from '../public/frontend-events.js';
import { createSessionStateController, isSessionRunning, sessionStatusFromMessage } from '../public/session-state.js';
import { isStaleSessionSnapshot, sessionSnapshotPatch, snapshotStatusRevision } from '../public/session-snapshot.js';
import { versionSessionStatus } from '../session-status.js';
import { createTopbarView } from '../public/topbar-view.js';

function fakeClassList() {
  const values = new Set();
  return {
    contains: (name) => values.has(name),
    toggle: (name, enabled) => {
      if (enabled) values.add(name);
      else values.delete(name);
    }
  };
}

function fakeElement() {
  return {
    classList: fakeClassList(),
    className: '',
    dataset: {},
    disabled: false,
    hidden: false,
    textContent: '',
    title: '',
    attrs: {},
    setAttribute(name, value) {
      this.attrs[name] = String(value);
    }
  };
}

function createHarness() {
  const state = {
    activeId: 's1',
    sessions: [{
      id: 's1',
      title: 'Session 1',
      cwd: '/root/Projects/demo',
      status: 'idle',
      isRunning: false,
      canStop: false,
      queue: []
    }],
    snapshots: 0
  };
  const el = {
    activeMeta: fakeElement(),
    activeTitle: fakeElement(),
    connectionBadge: fakeElement(),
    favoritesButton: fakeElement(),
    runtimeButton: fakeElement(),
    topFilterButton: fakeElement(),
    topFilterMenu: fakeElement(),
    stopButton: fakeElement(),
    topMoreButton: fakeElement(),
    topMoreMenu: fakeElement()
  };
  const topbar = createTopbarView({
    el,
    getOnline: () => true,
    isSessionRunning,
    updateFavoritesButton: () => {}
  });
  const controller = createSessionStateController({
    getActiveId: () => state.activeId,
    getSessions: () => state.sessions,
    setSessions: (sessions) => {
      state.sessions = sessions;
    },
    saveSessionCache: () => {},
    onActiveSessionChange: (session) => {
      state.snapshots += 1;
      topbar.renderActiveStatus(session);
    }
  });
  return { controller, el, state, topbar };
}

{
  const session = {};
  const first = versionSessionStatus(session, {
    status: 'running', running: true, canStop: true, queueCount: 0, activeRunId: 'r1', lastRunStatus: 'running'
  }, () => '2026-07-29T01:00:00.000Z');
  assert.equal(first.revision, 1);
  assert.equal(first.updatedAt, '2026-07-29T01:00:00.000Z');
  const unchanged = versionSessionStatus(session, {
    status: 'running', running: true, canStop: true, queueCount: 0, activeRunId: 'r1', lastRunStatus: 'running'
  }, () => 'should-not-be-used');
  assert.equal(unchanged.revision, 1);
  const queueEdited = versionSessionStatus(session, {
    status: 'running', running: true, canStop: true, queueCount: 0, activeRunId: 'r1', lastRunStatus: 'running'
  }, () => '2026-07-29T01:00:30.000Z', '[{"id":"q1","text":"edited"}]');
  assert.equal(queueEdited.revision, 2);
  const completed = versionSessionStatus(session, {
    status: 'idle', running: false, canStop: false, queueCount: 0, activeRunId: '', lastRunStatus: 'completed'
  }, () => '2026-07-29T01:01:00.000Z');
  assert.equal(completed.revision, 3);
  assert.equal(completed.updatedAt, '2026-07-29T01:01:00.000Z');
}

{
  const current = { id: 's1', title: 'Old title', status: 'idle', statusRevision: 8, queuedCount: 0, lastSeq: 20, activityAt: '2026-07-29T01:00:00Z' };
  const stale = { id: 's1', title: 'New title', status: 'running', statusRevision: 7, queuedCount: 2, lastSeq: 10, activityAt: '2026-07-28T01:00:00Z' };
  assert.equal(snapshotStatusRevision(current), 8);
  assert.equal(isStaleSessionSnapshot(current, stale), true);
  assert.deepEqual(sessionSnapshotPatch(current, stale), { id: 's1', title: 'New title' });
  assert.equal(isStaleSessionSnapshot(current, { id: 's1', status: 'running' }), true);
  assert.equal(isStaleSessionSnapshot(current, { id: 's1', status: 'running', statusRevision: 9 }), false);
}

{
  const { controller, el, state } = createHarness();
  assert.equal(controller.getActiveSession().id, 's1');
  assert.equal(controller.mergeSessionSnapshot({ id: 's1', status: 'running', isRunning: true, canStop: true }), true);
  assert.equal(state.sessions[0].status, 'running');
  assert.equal(state.snapshots, 1);
  assert.equal(el.stopButton.hidden, false);
  assert.equal(el.stopButton.disabled, false);
  assert.equal(el.connectionBadge.hidden, true);

  assert.equal(controller.mergeSessionSnapshot({ id: 's1', status: 'idle', isRunning: false, canStop: false }), true);
  assert.equal(el.stopButton.hidden, true);
  assert.equal(el.connectionBadge.hidden, false);
  assert.equal(el.connectionBadge.dataset.icon, 'online');
}

{
  const { controller, state } = createHarness();
  assert.equal(controller.mergeSessionSnapshot({
    id: 's1', status: 'running', isRunning: true, canStop: true, queuedCount: 1, statusRevision: 12
  }), true);
  assert.equal(controller.mergeSessionSnapshot({
    id: 's1', title: 'Renamed safely', status: 'idle', isRunning: false, canStop: false, queuedCount: 0, statusRevision: 11
  }), true);
  assert.equal(state.sessions[0].title, 'Renamed safely');
  assert.equal(state.sessions[0].status, 'running');
  assert.equal(state.sessions[0].queuedCount, 1);
  assert.equal(controller.mergeSessionSnapshot({
    id: 's1', status: 'idle', isRunning: false, canStop: false, queuedCount: 0, statusRevision: 13
  }), true);
  assert.equal(state.sessions[0].status, 'idle');
  assert.equal(controller.mergeSessionSnapshot({
    id: 's1', status: 'running', isRunning: true, canStop: true, statusRevision: 12
  }), false);
  assert.equal(state.sessions[0].status, 'idle');
}

{
  const { controller, state } = createHarness();
  const messages = [
    { id: 'm1', seq: 1, role: 'system', text: 'Codex is working.', status: 'running' },
    { id: 'm2', seq: 2, role: 'system', text: 'Codex run finished.' }
  ];
  assert.equal(controller.applySessionStatusFromMessage('s1', messages[0], [messages[0]]), true);
  assert.equal(state.sessions[0].status, 'running');

  assert.equal(sessionStatusFromMessage(messages[1]), 'idle');
  assert.equal(sessionStatusFromMessage({ role: 'system', text: 'Codex run stopped. Starting next queued prompt.' }), 'running');
  assert.equal(controller.applySessionStatusFromMessage('s1', messages[1], messages), true);
  assert.equal(state.sessions[0].status, 'idle');

  assert.equal(controller.applySessionStatusFromMessage('s1', messages[0], messages), false);
  assert.equal(state.sessions[0].status, 'idle');
}

{
  const { controller, state } = createHarness();
  controller.mergeSessionSnapshot({
    id: 's1', status: 'idle', statusRevision: 2, statusSummary: { status: 'idle', running: false, revision: 2 }
  });
  assert.equal(controller.applySessionStatusFromMessage('s1', {
    id: 'late', seq: 99, role: 'system', text: 'Codex is working.', status: 'running'
  }, []), false);
  assert.equal(state.sessions[0].status, 'idle');
}

{
  const connection = createConnectionState({ online: false });
  assert.deepEqual(connection.snapshot(), {
    eventConnectionStatus: 'closed',
    lastContextRefreshAt: '',
    lastEventAt: '',
    lastSessionSnapshotAt: '',
    online: false
  });
  connection.setOnline(true);
  connection.setEventStatus('connecting');
  connection.markEvent('open');
  connection.markContextRefresh();
  connection.markSessionSnapshot();
  const snapshot = connection.snapshot();
  assert.equal(snapshot.online, true);
  assert.equal(snapshot.eventConnectionStatus, 'open');
  assert.ok(snapshot.lastEventAt);
  assert.ok(snapshot.lastContextRefreshAt);
  assert.ok(snapshot.lastSessionSnapshotAt);
}

{
  const { el, topbar } = createHarness();
  topbar.setTopMoreMenu(true);
  assert.equal(el.topMoreMenu.hidden, false);
  assert.equal(el.topMoreButton.attrs['aria-expanded'], 'true');
  assert.equal(el.topFilterMenu.hidden, true);
  topbar.closeTopMoreMenu();
  assert.equal(el.topMoreMenu.hidden, true);
  assert.equal(el.topMoreButton.attrs['aria-expanded'], 'false');
  topbar.setTopFilterMenu(true);
  assert.equal(el.topFilterMenu.hidden, false);
  assert.equal(el.topFilterButton.attrs['aria-expanded'], 'true');
  assert.equal(el.topMoreMenu.hidden, true);
  topbar.closeTopMenus();
  assert.equal(el.topFilterMenu.hidden, true);
  assert.equal(el.topMoreMenu.hidden, true);
}

{
  const writes = new Map();
  const storage = {
    getItem: (key) => writes.get(key) || '',
    setItem: (key, value) => writes.set(key, value)
  };
  let latest = [];
  const events = createFrontendEvents({
    limit: 3,
    persistDelayMs: 0,
    storage,
    storageKey: 'events',
    onChange: (items) => {
      latest = items;
    }
  });
  events.record('one', { ok: true });
  events.record('two');
  events.record('three');
  events.record('four', 'kept');
  assert.equal(latest.length, 3);
  assert.deepEqual(latest.map((item) => item.type), ['four', 'three', 'two']);
  assert.equal(latest[0].detail, 'kept');
  events.clear();
  assert.deepEqual(events.snapshot(), []);
}

console.log('state controller checks passed');
