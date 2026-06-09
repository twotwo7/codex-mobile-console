const DEFAULT_LIMIT = 50;

function nowIso() {
  return new Date().toISOString();
}

function safeDetail(detail) {
  if (detail === undefined || detail === null) return '';
  if (typeof detail === 'string') return detail;
  if (typeof detail === 'number' || typeof detail === 'boolean') return String(detail);
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

function loadStored(storageKey, storage) {
  if (!storageKey || !storage) return [];
  try {
    const parsed = JSON.parse(storage.getItem(storageKey) || '[]');
    return Array.isArray(parsed) ? parsed.filter((item) => item?.at && item?.type) : [];
  } catch {
    return [];
  }
}

export function createFrontendEvents(options = {}) {
  const limit = Math.max(1, Number(options.limit || DEFAULT_LIMIT));
  const storage = options.storage || null;
  const storageKey = options.storageKey || '';
  const onChange = options.onChange || (() => {});
  const persistDelayMs = Math.max(0, Number(options.persistDelayMs || 500));
  let entries = loadStored(storageKey, storage).slice(-limit);
  let nextId = entries.reduce((max, item) => Math.max(max, Number(item.id || 0)), 0) + 1;
  let persistTimer = 0;

  function persist() {
    if (!storageKey || !storage) return;
    try {
      storage.setItem(storageKey, JSON.stringify(entries.slice(-limit)));
    } catch {
      // Diagnostics must never break the chat UI.
    }
  }

  function schedulePersist() {
    if (!storageKey || !storage) return;
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = 0;
      persist();
    }, persistDelayMs);
  }

  function snapshot() {
    return entries.slice().reverse();
  }

  function record(type, detail = '', level = 'info') {
    const entry = {
      id: nextId,
      at: nowIso(),
      type: String(type || 'event'),
      detail: safeDetail(detail),
      level: level || 'info'
    };
    nextId += 1;
    entries = [...entries, entry].slice(-limit);
    schedulePersist();
    onChange(snapshot());
    return entry;
  }

  function clear() {
    entries = [];
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = 0;
    }
    persist();
    onChange([]);
  }

  return {
    clear,
    record,
    snapshot
  };
}
