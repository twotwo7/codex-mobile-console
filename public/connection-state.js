export function createConnectionState(initial = {}) {
  const state = {
    online: initial.online === true,
    eventConnectionStatus: initial.eventConnectionStatus || 'closed',
    lastEventAt: initial.lastEventAt || '',
    lastContextRefreshAt: initial.lastContextRefreshAt || '',
    lastSessionSnapshotAt: initial.lastSessionSnapshotAt || ''
  };

  function nowIso() {
    return new Date().toISOString();
  }

  function snapshot() {
    return { ...state };
  }

  function setOnline(online) {
    state.online = online === true;
    return snapshot();
  }

  function setEventStatus(status) {
    state.eventConnectionStatus = status || 'closed';
    return snapshot();
  }

  function markEvent(status = state.eventConnectionStatus) {
    state.lastEventAt = nowIso();
    if (status) state.eventConnectionStatus = status;
    return snapshot();
  }

  function markContextRefresh() {
    state.lastContextRefreshAt = nowIso();
    return snapshot();
  }

  function markSessionSnapshot() {
    state.lastSessionSnapshotAt = nowIso();
    return snapshot();
  }

  return {
    markContextRefresh,
    markEvent,
    markSessionSnapshot,
    setEventStatus,
    setOnline,
    snapshot
  };
}
