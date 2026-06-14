function statusIconMode(mode = '') {
  if (mode === 'online') return 'online';
  if (mode === 'running') return 'running';
  if (mode === 'busy') return 'busy';
  return 'offline';
}

function sessionMetaText(session) {
  if (!session) return '未选择会话';
  const parts = [];
  if (session.cwd) parts.push(session.cwd);
  if (session.model) parts.push(session.model);
  if (session.profile) parts.push(`p:${session.profile}`);
  return parts.join(' · ');
}

export function createTopbarView(options) {
  const {
    el,
    getOnline,
    isSessionRunning,
    updateFavoritesButton
  } = options;

  function setBadge(text, mode = '') {
    const label = text || '离线';
    el.connectionBadge.textContent = '';
    el.connectionBadge.className = `connection-badge ${mode}`.trim();
    el.connectionBadge.dataset.icon = statusIconMode(mode);
    el.connectionBadge.setAttribute('aria-label', label);
    el.connectionBadge.title = label;
  }

  function renderActiveStatus(session) {
    const isRunning = isSessionRunning(session);
    const canStop = session?.canStop !== false && isRunning && session?.status !== 'stopping';
    el.stopButton.hidden = !isRunning;
    el.stopButton.disabled = !session || !canStop;
    el.stopButton.setAttribute('aria-label', canStop ? '停止当前任务' : '正在停止当前任务');
    el.stopButton.title = canStop ? '停止当前任务' : '正在停止当前任务';
    el.connectionBadge.hidden = isRunning;
    el.runtimeButton.disabled = !session;

    if (!session) {
      el.connectionBadge.hidden = false;
      el.activeTitle.textContent = 'Codex Console';
      el.activeMeta.textContent = '未选择会话';
      setBadge(getOnline() ? '在线' : '离线', getOnline() ? 'online' : '');
      updateFavoritesButton();
      return;
    }

    el.activeTitle.textContent = session.title;
    el.activeMeta.textContent = sessionMetaText(session);
    setBadge(
      isRunning ? session.status === 'stopping' ? '停止中' : '运行中' : getOnline() ? '在线' : '离线',
      isRunning ? 'running' : getOnline() ? 'online' : ''
    );
    updateFavoritesButton();
  }

  function setTopMoreMenu(open) {
    if (!el.topMoreButton || !el.topMoreMenu) return;
    el.topMoreMenu.hidden = !open;
    el.topMoreButton.setAttribute('aria-expanded', String(open));
  }

  function closeTopMoreMenu() {
    setTopMoreMenu(false);
  }

  return {
    closeTopMoreMenu,
    renderActiveStatus,
    setBadge,
    setTopMoreMenu
  };
}
