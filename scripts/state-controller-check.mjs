import assert from 'node:assert/strict';
import { createConnectionState } from '../public/connection-state.js';
import { createSessionStateController, isSessionRunning, sessionStatusFromMessage } from '../public/session-state.js';
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
  const messages = [
    { id: 'm1', seq: 1, role: 'system', text: 'Codex is working.', status: 'running' },
    { id: 'm2', seq: 2, role: 'system', text: 'Codex run finished.' }
  ];
  assert.equal(controller.applySessionStatusFromMessage('s1', messages[0], [messages[0]]), true);
  assert.equal(state.sessions[0].status, 'running');

  assert.equal(sessionStatusFromMessage(messages[1]), 'idle');
  assert.equal(controller.applySessionStatusFromMessage('s1', messages[1], messages), true);
  assert.equal(state.sessions[0].status, 'idle');

  assert.equal(controller.applySessionStatusFromMessage('s1', messages[0], messages), false);
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
  topbar.closeTopMoreMenu();
  assert.equal(el.topMoreMenu.hidden, true);
  assert.equal(el.topMoreButton.attrs['aria-expanded'], 'false');
}

console.log('state controller checks passed');
