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
    state,
    storageSet,
    editQueuedPromptText,
    updateFavoritesButton,
    updateMessage,
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
    const previousFiles = [...state.pendingFiles];
    if (!opts.keepInput) el.promptInput.value = '';
    if (!opts.keepImages) {
      state.pendingImages = [];
    }
    if (!opts.keepFiles) state.pendingFiles = [];
    renderPendingImages();
    autoSizePrompt();
    return { previousInput, previousImages, previousFiles };
  }

  function restoreComposer(sessionId, snapshot) {
    if (state.activeId !== sessionId || el.promptInput.value || state.pendingImages.length || state.pendingFiles.length) return;
    el.promptInput.value = snapshot.previousInput;
    state.pendingImages = snapshot.previousImages;
    state.pendingFiles = snapshot.previousFiles;
    autoSizePrompt();
    renderPendingImages();
  }

  function optimisticMessage({ clientMessageId, elevated, files, images, prompt }) {
    return {
      at: new Date().toISOString(),
      role: 'user',
      text: prompt || (images.length ? '请分析这些图片。' : '请分析这些文件。'),
      elevated,
      clientMessageId,
      images: images.map((image) => ({ name: image.name, type: image.type, dataUrl: image.data })),
      files: files.map(({ data, ...file }) => file),
      retryImages: images,
      retryFiles: [],
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
    const files = opts.files ? [...opts.files] : [...state.pendingFiles];
    if ((!prompt && !images.length && !files.length) || !state.activeId) return;

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
    upsertMessage(sessionId, optimisticMessage({ clientMessageId, elevated, files, images, prompt }));

    try {
      const data = await api(`/api/sessions/${sessionId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ prompt, elevated, clientMessageId, images, files })
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

  async function retryMessage(message) {
    const session = getActiveSession();
    const messageId = message.id || message.clientMessageId || message.seq;
    if (!session || !messageId) return;
    const localImages = (message.retryImages || message.images || []).map((image) => ({
      ...image,
      data: image.data || image.dataUrl
    })).filter((image) => image.data);

    if (message.failed && !message.id && localImages.length) {
      sendPrompt(message.text || '', {
        images: localImages,
        keepInput: true,
        keepImages: true,
        keepFiles: true
      });
      return;
    }

    try {
      const data = await api(`/api/sessions/${session.id}/messages/${encodeURIComponent(messageId)}/retry`, { method: 'POST' });
      if (data.message) updateMessage(session.id, data.message);
      if (data.session) {
        if (mergeSessionSnapshot(data.session)) renderSessions();
        renderActive({ messages: false });
      }
    } catch (error) {
      upsertMessage(session.id, {
        at: new Date().toISOString(),
        role: 'system',
        text: error.message || '重试失败'
      });
    }
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

  async function patchQueuedPrompt(queueId, body, fallbackText) {
    const session = getActiveSession();
    if (!session || !queueId) return;
    try {
      const data = await api(`/api/sessions/${session.id}/queue/${encodeURIComponent(queueId)}`, {
        method: 'PATCH',
        body: JSON.stringify(body)
      });
      if (data.message) updateMessage(session.id, data.message);
      if (data.session) {
        if (mergeSessionSnapshot(data.session)) renderSessions();
        renderActive({ messages: false });
      }
    } catch (error) {
      upsertMessage(session.id, {
        at: new Date().toISOString(),
        role: 'system',
        text: error.message || fallbackText
      });
    }
  }

  function topQueuedPrompt(queueId) {
    return patchQueuedPrompt(queueId, { action: 'top' }, '置顶排队失败');
  }

  async function editQueuedPrompt(item) {
    const current = item.displayPrompt || item.prompt || '';
    const nextPrompt = editQueuedPromptText
      ? await editQueuedPromptText(item)
      : window.prompt('编辑排队输入', current);
    if (nextPrompt === null) return;
    const prompt = String(nextPrompt || '').trim();
    if (!prompt || prompt === current) return;
    patchQueuedPrompt(item.id, { prompt }, '编辑排队失败');
  }

  async function mergeQueuedPrompts(queueIds = []) {
    const session = getActiveSession();
    if (!session || (session.queue || []).length < 2) return;
    try {
      const data = await api(`/api/sessions/${session.id}/queue/merge`, {
        method: 'POST',
        body: JSON.stringify({ queueIds })
      });
      if (data.message) updateMessage(session.id, data.message);
      if (data.session) {
        if (mergeSessionSnapshot(data.session)) renderSessions();
        renderActive({ messages: false });
      }
    } catch (error) {
      upsertMessage(session.id, {
        at: new Date().toISOString(),
        role: 'system',
        text: error.message || '合并队列失败'
      });
    }
  }

  return {
    cancelQueuedPrompt,
    editQueuedPrompt,
    mergeQueuedPrompts,
    retryMessage,
    sendPrompt,
    setSendState,
    topQueuedPrompt
  };
}
