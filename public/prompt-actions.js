export function createPromptActions(options) {
  const {
    api,
    autoSizePrompt,
    el,
    getActiveSession,
    loadMessages,
    mergeSessionSnapshot,
    renderActive,
    renderPendingImages,
    renderSessions,
    saveMessages,
    scrollMessagesToBottom,
    state,
    storageSet,
    updateFavoritesButton,
    upsertMessage
  } = options;

  function setSendState(mode) {
    state.sending = mode === 'sending';
    el.sendButton.disabled = !state.activeId || state.sending;
    el.sendButton.textContent = state.sending ? '发送中' : '发送';
  }

  function createClientMessageId() {
    return globalThis.crypto?.randomUUID
      ? crypto.randomUUID()
      : `local-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function clearComposer(opts) {
    const previousInput = el.promptInput.value;
    const previousImages = [...state.pendingImages];
    if (!opts.keepInput) el.promptInput.value = '';
    if (!opts.keepImages) {
      state.pendingImages = [];
      renderPendingImages();
    }
    autoSizePrompt();
    return { previousInput, previousImages };
  }

  function restoreComposer(sessionId, snapshot) {
    if (state.activeId !== sessionId || el.promptInput.value || state.pendingImages.length) return;
    el.promptInput.value = snapshot.previousInput;
    state.pendingImages = snapshot.previousImages;
    autoSizePrompt();
    renderPendingImages();
  }

  function optimisticMessage({ clientMessageId, elevated, images, prompt }) {
    return {
      at: new Date().toISOString(),
      role: 'user',
      text: prompt || '请分析这张图片。',
      elevated,
      clientMessageId,
      images: images.map((image) => ({ name: image.name, type: image.type, dataUrl: image.data })),
      retryImages: images,
      delivery: 'sending',
      pending: true
    };
  }

  function markLocalClientMessage(sessionId, clientMessageId, patch) {
    const messages = loadMessages(sessionId);
    const index = messages.findIndex((message) => message.clientMessageId === clientMessageId);
    if (index < 0) return false;
    messages[index] = { ...messages[index], ...patch };
    saveMessages(sessionId);
    if (state.activeId === sessionId) renderActive();
    return true;
  }

  function markSendFailed(sessionId, clientMessageId) {
    markLocalClientMessage(sessionId, clientMessageId, {
      pending: false,
      failed: true,
      delivery: 'failed'
    });
  }

  async function sendPrompt(rawPrompt, opts = {}) {
    const prompt = String(rawPrompt || '').trim();
    const images = opts.images ? [...opts.images] : [...state.pendingImages];
    if ((!prompt && !images.length) || !state.activeId) return;

    const sessionId = state.activeId;
    if (state.showStarredOnly) {
      state.showStarredOnly = false;
      storageSet('cmc.showStarredOnly', '0');
      updateFavoritesButton();
    }

    const composerSnapshot = clearComposer(opts);
    const elevated = Boolean(el.elevatedRun.checked);
    const clientMessageId = createClientMessageId();
    setSendState('sending');
    upsertMessage(sessionId, optimisticMessage({ clientMessageId, elevated, images, prompt }));
    scrollMessagesToBottom();

    try {
      const data = await api(`/api/sessions/${sessionId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ prompt, elevated, clientMessageId, images })
      });
      markLocalClientMessage(sessionId, clientMessageId, {
        pending: false,
        delivery: data.queued === true ? 'queued' : 'sent',
        runState: data.queued === true ? 'queued' : 'submitted'
      });
      if (mergeSessionSnapshot(data.session)) renderSessions();
      renderActive({ messages: false });
    } catch (error) {
      restoreComposer(sessionId, composerSnapshot);
      markSendFailed(sessionId, clientMessageId);
      upsertMessage(sessionId, {
        at: new Date().toISOString(),
        role: 'system',
        text: error.message || '发送失败'
      });
    } finally {
      setSendState('');
    }
  }

  function retryMessage(message) {
    sendPrompt(message.text || '', {
      images: (message.retryImages || message.images || []).map((image) => ({
        ...image,
        data: image.data || image.dataUrl
      })).filter((image) => image.data),
      keepInput: true,
      keepImages: true
    });
  }

  async function cancelQueuedPrompt(queueId) {
    const session = getActiveSession();
    if (!session || !queueId) return;
    try {
      const data = await api(`/api/sessions/${session.id}/queue/${encodeURIComponent(queueId)}`, { method: 'DELETE' });
      if (data.session) {
        if (mergeSessionSnapshot(data.session)) renderSessions();
        renderActive({ messages: false });
      }
    } catch (error) {
      upsertMessage(session.id, {
        at: new Date().toISOString(),
        role: 'system',
        text: error.message || '取消排队失败'
      });
    }
  }

  return {
    cancelQueuedPrompt,
    retryMessage,
    sendPrompt,
    setSendState
  };
}
