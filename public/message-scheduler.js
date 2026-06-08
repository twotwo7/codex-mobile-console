export function createMessageScheduler(options) {
  const renderDebounceMs = options.renderDebounceMs ?? 120;
  const renderBusyDelayMs = options.renderBusyDelayMs ?? 180;
  const saveDebounceMs = options.saveDebounceMs ?? 600;
  let renderTimer = null;
  let pendingRender = null;
  let saveTimer = null;
  const pendingSaves = new Set();

  function clearRender(sessionId) {
    if (pendingRender?.sessionId !== sessionId) return;
    pendingRender = null;
    clearTimeout(renderTimer);
    renderTimer = null;
  }

  function scheduleRender(sessionId, renderOptions = {}) {
    if (!sessionId || sessionId !== options.getActiveId()) return;
    const requestedStickToBottom = renderOptions.stickToBottom === true;
    const nextStickToBottom = pendingRender
      ? pendingRender.stickToBottom === true || requestedStickToBottom
      : requestedStickToBottom;
    pendingRender = {
      sessionId,
      stickToBottom: nextStickToBottom,
      restoreAnchor: renderOptions.restoreAnchor || pendingRender?.restoreAnchor || null
    };
    clearTimeout(renderTimer);
    const delay = Number.isFinite(renderOptions.delay) ? renderOptions.delay : renderDebounceMs;
    renderTimer = setTimeout(flushRender, delay);
  }

  function flushRender() {
    if (!pendingRender || pendingRender.sessionId !== options.getActiveId()) {
      pendingRender = null;
      return;
    }
    if (options.isRendering()) {
      clearTimeout(renderTimer);
      renderTimer = setTimeout(flushRender, renderBusyDelayMs);
      return;
    }
    const next = pendingRender;
    pendingRender = null;
    renderTimer = null;
    options.render(next);
  }

  function scheduleSave(sessionId) {
    if (!sessionId) return;
    pendingSaves.add(sessionId);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSaves, saveDebounceMs);
  }

  function flushSaves() {
    clearTimeout(saveTimer);
    saveTimer = null;
    const ids = [...pendingSaves];
    pendingSaves.clear();
    for (const id of ids) options.save(id);
  }

  return {
    clearRender,
    scheduleRender,
    flushRender,
    scheduleSave,
    flushSaves
  };
}
