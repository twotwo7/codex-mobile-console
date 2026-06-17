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
  if (session.goal?.objective) {
    const plan = Array.isArray(session.goal.plan) ? session.goal.plan : [];
    const done = plan.filter((item) => item.status === 'done').length;
    const progress = plan.length ? ` ${done}/${plan.length}` : '';
    parts.push(`任务:${session.goal.status === 'complete' ? '完成' : session.goal.status === 'paused' ? '暂存' : '进行中'}${progress}`);
  }
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
    const summary = session?.statusSummary || {};
    const canStop = summary.canStop ?? (session?.canStop !== false && isRunning && session?.status !== 'stopping');
    const label = summary.label || (session?.status === 'stopping' ? '停止中' : '运行中');
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
      isRunning ? label : getOnline() ? '在线' : '离线',
      isRunning ? 'running' : getOnline() ? 'online' : ''
    );
    updateFavoritesButton();
  }

  function setTopMoreMenu(open) {
    if (!el.topMoreButton || !el.topMoreMenu) return;
    el.topMoreMenu.hidden = !open;
    el.topMoreButton.setAttribute('aria-expanded', String(open));
    if (open) setTopFilterMenu(false);
  }

  function closeTopMoreMenu() {
    setTopMoreMenu(false);
  }

  function setTopFilterMenu(open) {
    if (!el.topFilterButton || !el.topFilterMenu) return;
    el.topFilterMenu.hidden = !open;
    el.topFilterButton.setAttribute('aria-expanded', String(open));
    if (open) {
      el.topMoreMenu.hidden = true;
      el.topMoreButton.setAttribute('aria-expanded', 'false');
    }
  }

  function closeTopFilterMenu() {
    setTopFilterMenu(false);
  }

  function closeTopMenus() {
    closeTopMoreMenu();
    closeTopFilterMenu();
  }

  return {
    closeTopFilterMenu,
    closeTopMenus,
    closeTopMoreMenu,
    renderActiveStatus,
    setBadge,
    setTopFilterMenu,
    setTopMoreMenu
  };
}
