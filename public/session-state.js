const SESSION_STATUS_KEYS = [
  'source',
  'title',
  'cwd',
  'model',
  'sandbox',
  'approval',
  'codexSessionId',
  'status',
  'trashedAt',
  'createdAt',
  'updatedAt',
  'lastSeq',
  'storedStatus',
  'isRunning',
  'canStop',
  'queuedCount'
];

export function isSessionRunning(session) {
  if (!session) return false;
  if (['idle', 'error'].includes(session.status)) return false;
  if (typeof session.isRunning === 'boolean') return session.isRunning;
  return session.status === 'running' || session.status === 'stopping';
}

export function sessionStatusFromMessage(message) {
  if (!message) return '';
  if (['running', 'stopping', 'idle', 'error'].includes(message.status)) return message.status;
  if (message.role !== 'system') return '';
  const text = String(message.text || '');
  if (text.includes('Codex run finished. Starting next queued prompt.')) return 'running';
  if (text.includes('Codex run stopped. Starting next queued prompt.')) return 'running';
  if (text.includes('Codex is working')) return 'running';
  if (text.includes('Stop requested.')) return 'stopping';
  if (text.includes('Codex run finished.') || text.includes('Codex run stopped.') || text.includes('Recovered stale run state')) return 'idle';
  if (text.includes('Codex exited with code') || text.includes('Failed to start Codex')) return 'error';
  return '';
}

function messageSequenceValue(message) {
  return Number(message?.orderSeq || message?.seq || 0);
}

function latestMessageSeq(messages) {
  return Math.max(0, ...(messages || []).map((message) => Number(message.seq || 0)).filter((seq) => seq > 0));
}

export function createSessionStateController(options) {
  const {
    getActiveId,
    getSessions,
    onActiveSessionChange = () => {},
    onSessionChange = () => {},
    saveSessionCache = () => {},
    setSessions
  } = options;

  function getActiveSession() {
    return getSessions().find((item) => item.id === getActiveId());
  }

  function isActiveSessionRunning() {
    return isSessionRunning(getActiveSession());
  }

  function mergeSessionSnapshot(nextSession) {
    if (!nextSession?.id) return false;
    const patch = Object.fromEntries(Object.entries(nextSession).filter(([, value]) => value !== undefined));
    const sessions = getSessions();
    const index = sessions.findIndex((item) => item.id === nextSession.id);
    if (index < 0) {
      setSessions([patch, ...sessions]);
      saveSessionCache();
      if (nextSession.id === getActiveId()) onActiveSessionChange(patch);
      onSessionChange(patch, null);
      return true;
    }

    const current = sessions[index];
    const next = { ...current, ...patch };
    const changed = SESSION_STATUS_KEYS.some((key) => current[key] !== next[key])
      || JSON.stringify(current.queue || []) !== JSON.stringify(next.queue || []);
    if (!changed) return false;

    setSessions(sessions.map((item) => item.id === next.id ? next : item));
    saveSessionCache();
    if (next.id === getActiveId()) onActiveSessionChange(next);
    onSessionChange(next, current);
    return true;
  }

  function applySessionStatusFromMessage(sessionId, message, messages) {
    const status = sessionStatusFromMessage(message);
    if (!status) return false;
    const messageSeq = messageSequenceValue(message);
    const latestSeq = latestMessageSeq(messages);
    if (messageSeq && latestSeq && messageSeq < latestSeq) return false;
    const nextRunning = status === 'running' || status === 'stopping';
    return mergeSessionSnapshot({
      id: sessionId,
      status,
      isRunning: nextRunning,
      canStop: status === 'running',
      queuedCount: message.queuedCount,
      updatedAt: message.at
    });
  }

  return {
    applySessionStatusFromMessage,
    getActiveSession,
    isActiveSessionRunning,
    isSessionRunning,
    mergeSessionSnapshot
  };
}
