import { createMessageScheduler } from './message-scheduler.js?v=2';
import { cancelIdle, scheduleIdle, storageGet, storageJsonGet, storageJsonSet, storageSet } from './browser-utils.js?v=1';
import { escapeHtml, formatBytes, formatDuration, formatNumber, formatTime, summarizeText } from './format-utils.js?v=1';
import { compareMessages, findMessageIndex, lastRealSeq, mergeMessagePair, mergeMessages } from './message-utils.js?v=1';
import { createMessageView } from './message-view.js?v=3';
import { createPromptActions } from './prompt-actions.js?v=4';
import { createQueueView } from './queue-view.js?v=3';
import { createSkillView } from './skill-view.js?v=3';

const storedExpandedCwds = (() => {
  const value = storageJsonGet('cmc.expandedCwds', []);
  return Array.isArray(value) ? value : [];
})();

const state = {
  sessions: [],
  activeId: storageGet('cmc.activeId'),
  sessionViewMode: storageGet('cmc.sessionViewMode', 'recent'),
  theme: storageGet('cmc.theme', 'graphite'),
  autoFollowBottom: storageGet('cmc.autoFollowBottom', '1') === '1',
  elevated: storageGet('cmc.elevated') === '1',
  showStarredOnly: storageGet('cmc.showStarredOnly') === '1',
  pendingImages: [],
  sending: false,
  directoryPath: '/root/Projects',
  expandedCwds: new Set(storedExpandedCwds),
  messages: new Map(),
  messagePages: new Map(),
  messageRenderLimits: new Map(),
  messageCollapseStates: new Map(),
  lastSeq: new Map(),
  eventSource: null,
  contextRefreshTimer: null,
  contextRefreshInFlight: false,
  foregroundRefreshTimer: null,
  runtimeTimer: null,
  renderJobId: 0,
  renderingMessages: false,
  userScrolledDuringRender: false,
  suppressScrollTracking: false,
  scrollSuppressToken: 0,
  initialBottomLockSessionId: '',
  drawerOpen: false,
  drawerPanel: 'sessions',
  sessionActionId: '',
  sessionListDirty: true,
  sessionRenderLimit: 40,
  loadingOlder: false,
  cleanupTimer: null,
  localCacheCleanupHandle: null,
  online: navigator.onLine,
  localRuntimeSnapshot: null,
  localRuntimeSnapshotAt: 0,
  localRuntimeSessionId: '',
  skills: [],
  skillsLoadedAt: 0,
  skillDialogMode: 'quick'
};

const MAX_CACHED_SESSIONS = 2;
const MAX_LOCAL_MESSAGES = 800;
const MAX_BROWSER_CACHED_MESSAGES = 360;
const DESKTOP_MAX_RENDERED_MESSAGES = 180;
const MOBILE_MAX_RENDERED_MESSAGES = 120;
const MOBILE_MESSAGE_CHUNK = 18;
const DESKTOP_MESSAGE_CHUNK = 40;
const SESSION_RENDER_STEP = 40;
const MAX_LOCAL_MESSAGE_CACHE_BYTES = 1_200_000;
const LOCAL_CACHE_CLEANUP_BATCH = 3;

const CODEX_COMMANDS = [
  { name: '/status', detail: '查看会话状态', value: '/status' },
  { name: '/diff', detail: '查看当前改动', value: '/diff' },
  { name: '/compact', detail: '压缩上下文', value: '/compact' },
  { name: '/model', detail: '切换模型', value: '/model' },
  { name: '/approvals', detail: '调整审批模式', value: '/approvals' },
  { name: '/init', detail: '初始化项目说明', value: '/init' },
  { name: 'codex doctor', detail: '诊断本机 Codex', value: '请运行 `codex doctor` 并总结需要我处理的问题。' },
  { name: 'code review', detail: '代码审查', value: '请对当前工作区做一次代码审查，优先指出 bug、风险和缺少的测试。' }
];

const IMAGE_PROMPTS = [
  { label: '描述', value: '描述这张图片。' },
  { label: '问题', value: '指出这张图片里的问题，并给出处理建议。' },
  { label: '文字', value: '提取图片中的文字，并按原结构整理。' },
  { label: '客户', value: '这是客户发来的截图，请帮我判断客户想表达什么、可能的问题和我应该如何回复。' }
];

const messageScheduler = createMessageScheduler({
  getActiveId: () => state.activeId,
  isRendering: () => state.renderingMessages,
  render: ({ sessionId, stickToBottom, restoreAnchor }) => {
    renderMessages(sessionId, { stickToBottom, restoreAnchor });
  },
  save: saveMessages
});

const el = {
  loginView: document.querySelector('#loginView'),
  appView: document.querySelector('#appView'),
  loginForm: document.querySelector('#loginForm'),
  loginButton: document.querySelector('#loginButton'),
  loginError: document.querySelector('#loginError'),
  sessionDrawer: document.querySelector('#sessionDrawer'),
  drawerScrim: document.querySelector('#drawerScrim'),
  openDrawer: document.querySelector('#openDrawer'),
  closeDrawer: document.querySelector('#closeDrawer'),
  drawerTitle: document.querySelector('#drawerTitle'),
  drawerModeRow: document.querySelector('#drawerModeRow'),
  drawerSessionsButton: document.querySelector('#drawerSessionsButton'),
  drawerSessionsPanel: document.querySelector('#drawerSessionsPanel'),
  drawerSkillsPanel: document.querySelector('#drawerSkillsPanel'),
  drawerSettingsPanel: document.querySelector('#drawerSettingsPanel'),
  drawerSettingsButton: document.querySelector('#drawerSettingsButton'),
  sessionList: document.querySelector('#sessionList'),
  sessionViewButtons: [...document.querySelectorAll('[data-session-view]')],
  sessionActionSheet: document.querySelector('#sessionActionSheet'),
  closeSessionActionSheet: document.querySelector('#closeSessionActionSheet'),
  sessionActionTitle: document.querySelector('#sessionActionTitle'),
  sessionActionMeta: document.querySelector('#sessionActionMeta'),
  sessionActionButtons: document.querySelector('#sessionActionButtons'),
  newSessionButton: document.querySelector('#newSessionButton'),
  skillManagerButton: document.querySelector('#skillManagerButton'),
  logoutButton: document.querySelector('#logoutButton'),
  activeTitle: document.querySelector('#activeTitle'),
  activeMeta: document.querySelector('#activeMeta'),
  connectionBadge: document.querySelector('#connectionBadge'),
  emptyState: document.querySelector('#emptyState'),
  messagePane: document.querySelector('#messagePane'),
  promptForm: document.querySelector('#promptForm'),
  promptInput: document.querySelector('#promptInput'),
  commandButton: document.querySelector('#commandButton'),
  favoritesButton: document.querySelector('#favoritesButton'),
  runtimeButton: document.querySelector('#runtimeButton'),
  imageButton: document.querySelector('#imageButton'),
  imageInput: document.querySelector('#imageInput'),
  imagePreviewStrip: document.querySelector('#imagePreviewStrip'),
  elevatedRun: document.querySelector('#elevatedRun'),
  stopButton: document.querySelector('#stopButton'),
  sendButton: document.querySelector('#sendButton'),
  skillButton: document.querySelector('#skillButton'),
  themeSelect: document.querySelector('#themeSelect'),
  autoFollowBottom: document.querySelector('#autoFollowBottom'),
  sessionViewMode: document.querySelector('#sessionViewMode'),
  dialog: document.querySelector('#newSessionDialog'),
  newSessionForm: document.querySelector('#newSessionForm'),
  cwdInput: document.querySelector('#cwdInput'),
  browseCwdButton: document.querySelector('#browseCwdButton'),
  cancelNewSession: document.querySelector('#cancelNewSession'),
  directoryDialog: document.querySelector('#directoryDialog'),
  closeDirectoryDialog: document.querySelector('#closeDirectoryDialog'),
  directoryPath: document.querySelector('#directoryPath'),
  directoryList: document.querySelector('#directoryList'),
  directoryUpButton: document.querySelector('#directoryUpButton'),
  chooseDirectoryButton: document.querySelector('#chooseDirectoryButton'),
  settingsTabs: [...document.querySelectorAll('[data-settings-tab]')],
  settingsPages: [...document.querySelectorAll('[data-settings-page]')],
  storageStats: document.querySelector('#storageStats'),
  autoCleanupToggle: document.querySelector('#autoCleanupToggle'),
  runSettingsState: document.querySelector('#runSettingsState'),
  uploadRetentionDaysInput: document.querySelector('#uploadRetentionDaysInput'),
  runtimeRetentionDaysInput: document.querySelector('#runtimeRetentionDaysInput'),
  maxUploadMbInput: document.querySelector('#maxUploadMbInput'),
  refreshStorageButton: document.querySelector('#refreshStorageButton'),
  saveStorageButton: document.querySelector('#saveStorageButton'),
  cleanupUploadsButton: document.querySelector('#cleanupUploadsButton'),
  cleanupRuntimeButton: document.querySelector('#cleanupRuntimeButton'),
  commandDialog: document.querySelector('#commandDialog'),
  closeCommandDialog: document.querySelector('#closeCommandDialog'),
  commandList: document.querySelector('#commandList'),
  skillDialog: document.querySelector('#skillDialog'),
  closeSkillDialog: document.querySelector('#closeSkillDialog'),
  skillDialogHint: document.querySelector('#skillDialogHint'),
  skillSearch: document.querySelector('#skillSearch'),
  refreshSkillsButton: document.querySelector('#refreshSkillsButton'),
  skillStatus: document.querySelector('#skillStatus'),
  skillList: document.querySelector('#skillList'),
  drawerSkillSearch: document.querySelector('#drawerSkillSearch'),
  drawerRefreshSkillsButton: document.querySelector('#drawerRefreshSkillsButton'),
  drawerSkillStatus: document.querySelector('#drawerSkillStatus'),
  drawerSkillList: document.querySelector('#drawerSkillList'),
  skillDetailDialog: document.querySelector('#skillDetailDialog'),
  closeSkillDetailDialog: document.querySelector('#closeSkillDetailDialog'),
  skillDetailTitle: document.querySelector('#skillDetailTitle'),
  skillDetailBody: document.querySelector('#skillDetailBody'),
  runtimeDialog: document.querySelector('#runtimeDialog'),
  closeRuntimeDialog: document.querySelector('#closeRuntimeDialog'),
  runtimePanel: document.querySelector('#runtimePanel'),
  imageViewer: document.querySelector('#imageViewer'),
  closeImageViewer: document.querySelector('#closeImageViewer'),
  imageViewerImg: document.querySelector('#imageViewerImg')
};

const promptActions = createPromptActions({
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
  updateFavoritesButton,
  updateMessage,
  upsertMessage
});

const messageView = createMessageView({
  getMessageCollapsed,
  openImageViewer,
  retryMessage: promptActions.retryMessage,
  setMessageCollapsed,
  toggleStarred
});

const queueView = createQueueView({
  cancelQueuedPrompt: promptActions.cancelQueuedPrompt,
  editQueuedPrompt: promptActions.editQueuedPrompt,
  openImageViewer,
  topQueuedPrompt: promptActions.topQueuedPrompt
});

const skillView = createSkillView({
  commands: CODEX_COMMANDS,
  el,
  getSkills: () => state.skills,
  insertPromptText,
  openModal,
  closeModal
});

if ('scrollRestoration' in history) {
  history.scrollRestoration = 'manual';
}

applyTheme(state.theme);
el.themeSelect.value = state.theme;
el.autoFollowBottom.checked = state.autoFollowBottom;
el.elevatedRun.checked = state.elevated;
syncSessionViewControls();
updateRunSettingsState();

function cacheKey(id) {
  return `cmc.messages.${id}`;
}

function pageCacheKey(id) {
  return `cmc.messagePage.${id}`;
}

function collapseStateKey(sessionId = state.activeId) {
  return `cmc.messageCollapsed.${sessionId || 'global'}`;
}

function messageCollapseId(message) {
  return message.clientMessageId
    || (message.ids || []).find(Boolean)
    || message.id
    || (message.seq ? `seq:${message.seq}` : '');
}

function getMessageCollapsed(message) {
  const key = messageCollapseId(message);
  if (!key) return null;
  const states = loadMessageCollapseStates();
  if (!states || typeof states !== 'object' || !(key in states)) return null;
  return states[key] === true;
}

function setMessageCollapsed(message, collapsed) {
  const key = messageCollapseId(message);
  if (!key) return;
  const sessionId = state.activeId || 'global';
  const states = loadMessageCollapseStates(sessionId);
  const next = {
    ...(states && typeof states === 'object' ? states : {}),
    [key]: collapsed === true
  };
  state.messageCollapseStates.set(sessionId, next);
  storageJsonSet(collapseStateKey(sessionId), next);
}

function loadMessageCollapseStates(sessionId = state.activeId || 'global') {
  if (state.messageCollapseStates.has(sessionId)) return state.messageCollapseStates.get(sessionId);
  const states = storageJsonGet(collapseStateKey(sessionId), {});
  const safeStates = states && typeof states === 'object' ? states : {};
  state.messageCollapseStates.set(sessionId, safeStates);
  return safeStates;
}

function saveSessionCache() {
  storageJsonSet('cmc.sessions', state.sessions);
}

function saveExpandedCwds() {
  storageJsonSet('cmc.expandedCwds', [...state.expandedCwds]);
}

function loadCachedSessions() {
  const sessions = storageJsonGet('cmc.sessions', []);
  state.sessions = Array.isArray(sessions) ? sessions : [];
  state.sessionListDirty = true;
}

function saveMessages(id) {
  const messages = trimMessagesForStorage(mergeMessages([], state.messages.get(id) || []));
  const cached = messages.slice(-MAX_BROWSER_CACHED_MESSAGES).map(cacheSafeMessage);
  if (!storageJsonSet(cacheKey(id), cached)) {
    scheduleLocalCacheCleanup(500);
  }
}

function trimMessagesForStorage(messages) {
  if (!Array.isArray(messages) || messages.length <= MAX_LOCAL_MESSAGES) return messages || [];
  return messages.slice(-MAX_LOCAL_MESSAGES);
}

function cacheSafeMessage(message) {
  return {
    ...message,
    images: (message.images || []).map(({ data, dataUrl, ...image }) => image),
    retryImages: (message.retryImages || []).map(({ data, dataUrl, ...image }) => image)
  };
}

function loadMessages(id, options = {}) {
  if (state.messages.has(id)) return state.messages.get(id);
  const cached = options.fromCache === false ? [] : storageJsonGet(cacheKey(id), []);
  const messages = Array.isArray(cached) ? cached : [];
  const merged = trimMessagesForStorage(mergeMessages([], messages));
  state.messages.set(id, merged);
  state.lastSeq.set(id, lastRealSeq(merged));
  if (options.fromCache !== false) loadMessagePage(id);
  return merged;
}

function loadMessagePage(id) {
  if (state.messagePages.has(id)) return state.messagePages.get(id);
  const page = storageJsonGet(pageCacheKey(id), null);
  if (page && typeof page === 'object') {
    state.messagePages.set(id, { ...page, loading: false });
    return state.messagePages.get(id);
  }
  return null;
}

function firstPageLimit() {
  return renderedMessageLimit();
}

function maxHistoryLimit() {
  return MAX_LOCAL_MESSAGES;
}

function renderedMessageLimit() {
  return isMobileViewport() ? MOBILE_MAX_RENDERED_MESSAGES : DESKTOP_MAX_RENDERED_MESSAGES;
}

function sessionRenderedMessageLimit(sessionId = state.activeId) {
  return Math.min(maxHistoryLimit(), Math.max(renderedMessageLimit(), Number(state.messageRenderLimits.get(sessionId) || 0)));
}

function expandRenderedMessageLimit(sessionId, count) {
  if (!sessionId || !Number.isFinite(count) || count <= 0) return;
  const current = sessionRenderedMessageLimit(sessionId);
  state.messageRenderLimits.set(sessionId, Math.min(maxHistoryLimit(), current + count));
}

function setMessagePage(sessionId, page, options = {}) {
  const current = loadMessagePage(sessionId) || {};
  const incomingOffset = Number(page?.nextOffset ?? page?.afterSeq ?? 0);
  const offset = options.preserveOffset ? Math.max(Number(current.offset || 0), incomingOffset) : incomingOffset;
  const total = Number(page?.total ?? current.total ?? 0);
  const loaded = state.messages.get(sessionId)?.length || 0;
  const hasMore = (page?.hasMore === true || page?.hasMoreBefore === true) && loaded < maxHistoryLimit();
  const currentBeforeSeq = Number(current.beforeSeq || 0);
  const incomingBeforeSeq = Number(page?.beforeSeq || 0);
  const next = {
    offset,
    total,
    beforeSeq: currentBeforeSeq && incomingBeforeSeq ? Math.min(currentBeforeSeq, incomingBeforeSeq) : incomingBeforeSeq || currentBeforeSeq,
    afterSeq: Number(page?.afterSeq || current.afterSeq || 0),
    latestSeq: Number(page?.latestSeq || current.latestSeq || 0),
    firstSeq: Number(page?.firstSeq || current.firstSeq || 0),
    hasMore: options.preserveOffset && current.offset > incomingOffset ? current.hasMore === true && loaded < maxHistoryLimit() : hasMore,
    loading: false
  };
  if (page?.session) {
    next.sessionUpdatedAt = page.session.updatedAt || '';
    next.lastSeq = page.session.lastSeq || 0;
  } else {
    next.sessionUpdatedAt = current.sessionUpdatedAt || '';
    next.lastSeq = current.lastSeq || 0;
  }
  state.messagePages.set(sessionId, next);
  storageJsonSet(pageCacheKey(sessionId), next);
}

function isMessageCacheFresh(sessionId, session) {
  if (!session?.updatedAt) return false;
  const page = loadMessagePage(sessionId);
  const messages = state.messages.get(sessionId) || [];
  return Boolean(messages.length)
    && Boolean(page?.beforeSeq || messages.some((message) => message.orderSeq))
    && page?.sessionUpdatedAt === session.updatedAt
    && Number(page?.offset || 0) >= Math.min(firstPageLimit(), messages.length);
}

function sessionMessagesUrl(sessionId, params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const suffix = search.toString();
  return `/api/sessions/${encodeURIComponent(sessionId)}/messages${suffix ? `?${suffix}` : ''}`;
}

function cleanupIdleResources() {
  for (const id of [...state.messages.keys()]) {
    if (id === state.activeId) continue;
    state.messages.delete(id);
    state.lastSeq.delete(id);
    state.messagePages.delete(id);
    state.messageCollapseStates.delete(id);
  }
}

function scheduleResourceCleanup() {
  clearTimeout(state.cleanupTimer);
  state.cleanupTimer = setTimeout(cleanupIdleResources, 30000);
}

function cleanupLocalMessageCaches(deadline) {
  let cleaned = 0;
  try {
    const keys = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index) || '';
      if (key.startsWith('cmc.messages.')) keys.push(key);
    }
    for (const key of keys) {
      if (cleaned >= LOCAL_CACHE_CLEANUP_BATCH) break;
      if (deadline?.timeRemaining && deadline.timeRemaining() < 8) break;
      const raw = localStorage.getItem(key) || '';
      if (raw.length <= MAX_LOCAL_MESSAGE_CACHE_BYTES) continue;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        localStorage.removeItem(key);
        cleaned += 1;
        continue;
      }
      localStorage.setItem(key, JSON.stringify(parsed.slice(-MAX_BROWSER_CACHED_MESSAGES).map(cacheSafeMessage)));
      cleaned += 1;
    }
  } catch {
    // Local cleanup is best-effort and must never block chat.
  }
  state.localCacheCleanupHandle = null;
  if (cleaned >= LOCAL_CACHE_CLEANUP_BATCH) scheduleLocalCacheCleanup(2500);
}

function scheduleLocalCacheCleanup(timeout = 2200) {
  cancelIdle(state.localCacheCleanupHandle);
  state.localCacheCleanupHandle = scheduleIdle(cleanupLocalMessageCaches, timeout);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const error = new Error(data.error || data.message || `HTTP ${res.status}`);
    error.status = res.status;
    error.code = data.error || '';
    error.detail = data.message || '';
    throw error;
  }
  return data;
}

function parseEventData(event, fallback = null) {
  try {
    return JSON.parse(event.data || 'null') ?? fallback;
  } catch {
    return fallback;
  }
}

function setActiveSessionId(id = '') {
  state.activeId = id || '';
  storageSet('cmc.activeId', state.activeId);
  return state.activeId;
}

function setAuthView(isAuthed) {
  el.loginView.hidden = isAuthed;
  el.appView.hidden = !isAuthed;
}

function isMobileViewport() {
  return window.matchMedia('(max-width: 760px)').matches;
}

function setDrawer(open) {
  state.drawerOpen = open;
  state.renderJobId += 1;
  state.renderingMessages = false;
  if (!open) closeSessionActionSheet();
  document.body.classList.toggle('drawer-open', open);
  el.sessionDrawer.classList.toggle('open', open);
  el.drawerScrim.hidden = !open;
  if (open && state.drawerPanel === 'sessions' && state.sessionListDirty) {
    requestAnimationFrame(() => renderSessions({ force: true }));
  }
  if (open && state.drawerPanel === 'skills') {
    loadSkills().catch((error) => {
      el.drawerSkillList.textContent = error.message || '加载失败';
    });
  }
}

function resetSessionRenderLimit() {
  state.sessionRenderLimit = state.sessionViewMode === 'recent' ? 20 : SESSION_RENDER_STEP;
}

function syncSessionViewControls() {
  if (el.sessionViewMode) el.sessionViewMode.value = state.sessionViewMode;
  for (const button of el.sessionViewButtons) {
    const active = button.dataset.sessionView === state.sessionViewMode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-checked', String(active));
  }
}

function setSessionViewMode(mode) {
  if (!['recent', 'flat', 'cwd', 'trash'].includes(mode)) return;
  state.sessionViewMode = mode;
  storageSet('cmc.sessionViewMode', state.sessionViewMode);
  resetSessionRenderLimit();
  syncSessionViewControls();
  renderSessions({ force: true });
}

function setDrawerPanel(panel) {
  state.drawerPanel = ['skills', 'settings'].includes(panel) ? panel : 'sessions';
  const skillsActive = state.drawerPanel === 'skills';
  const settingsActive = state.drawerPanel === 'settings';
  if (el.drawerTitle) el.drawerTitle.textContent = settingsActive ? '设置' : skillsActive ? 'Skills' : '会话';
  el.drawerSessionsButton.classList.toggle('active', !skillsActive && !settingsActive);
  el.skillManagerButton.classList.toggle('active', skillsActive);
  el.drawerSettingsButton.classList.toggle('active', settingsActive);
  el.drawerSessionsButton.setAttribute('aria-selected', String(!skillsActive && !settingsActive));
  el.skillManagerButton.setAttribute('aria-selected', String(skillsActive));
  el.drawerSettingsButton.setAttribute('aria-selected', String(settingsActive));
  el.drawerSessionsPanel.classList.toggle('active', !skillsActive && !settingsActive);
  el.drawerSkillsPanel.classList.toggle('active', skillsActive);
  el.drawerSettingsPanel.classList.toggle('active', settingsActive);
  el.logoutButton.hidden = !settingsActive;
  if (skillsActive) {
    loadSkills().catch((error) => {
      el.drawerSkillList.textContent = error.message || '加载失败';
    });
  } else if (settingsActive) {
    selectSettingsPage('ui');
  } else {
    renderSessions({ force: true });
  }
}

function openModal(dialog) {
  if (!dialog) return;
  if (typeof dialog.showModal === 'function') {
    dialog.showModal();
  } else {
    dialog.setAttribute('open', '');
  }
}

function closeModal(dialog) {
  if (!dialog) return;
  if (typeof dialog.close === 'function') {
    dialog.close();
  } else {
    dialog.removeAttribute('open');
  }
}

function statusIconMode(mode = '') {
  if (mode === 'online') return 'online';
  if (mode === 'running') return 'running';
  if (mode === 'busy') return 'busy';
  return 'offline';
}

function setBadge(text, mode = '') {
  const label = text || '离线';
  el.connectionBadge.textContent = '';
  el.connectionBadge.className = `connection-badge ${mode}`.trim();
  el.connectionBadge.dataset.icon = statusIconMode(mode);
  el.connectionBadge.setAttribute('aria-label', label);
  el.connectionBadge.title = label;
}

function renderSessions(options = {}) {
  if (!options.force && isMobileViewport() && !state.drawerOpen) {
    state.sessionListDirty = true;
    return;
  }
  state.sessionListDirty = false;
  el.sessionList.innerHTML = '';
  const fragment = document.createDocumentFragment();

  const sessions = [...state.sessions]
    .filter((session) => state.sessionViewMode === 'trash' ? Boolean(session.trashedAt) : !session.trashedAt)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  const limit = state.sessionViewMode === 'recent'
    ? 20
    : Math.max(SESSION_RENDER_STEP, state.sessionRenderLimit || SESSION_RENDER_STEP);
  const visible = sessions.slice(0, limit);

  if (!visible.length) {
    const empty = document.createElement('div');
    empty.className = 'session-empty';
    empty.textContent = state.sessionViewMode === 'trash' ? '回收站为空' : '暂无会话';
    fragment.append(empty);
    el.sessionList.append(fragment);
    return;
  }

  if (state.sessionViewMode === 'cwd') {
    const groups = new Map();
    for (const session of visible) {
      const key = session.cwd || '未知目录';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(session);
    }
    for (const [cwd, group] of groups) {
      const section = document.createElement('section');
      section.className = 'session-group';
      const expanded = state.expandedCwds.has(cwd);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'session-group-toggle';
      button.setAttribute('aria-expanded', String(expanded));
      button.title = cwd;
      button.innerHTML = `
        <span>${escapeHtml(formatSessionCwd(cwd))}</span>
        <strong>${expanded ? '收起' : '展开'} · ${group.length}</strong>
      `;
      button.addEventListener('click', () => {
        if (state.expandedCwds.has(cwd)) state.expandedCwds.delete(cwd);
        else state.expandedCwds.add(cwd);
        saveExpandedCwds();
        renderSessions();
      });
      section.append(button);
      if (expanded) {
        for (const session of group) section.append(renderSessionButton(session));
      }
      fragment.append(section);
    }
    appendSessionListMore(fragment, sessions.length, visible.length);
    el.sessionList.append(fragment);
    return;
  }

  for (const session of visible) fragment.append(renderSessionButton(session));
  appendSessionListMore(fragment, sessions.length, visible.length);
  el.sessionList.append(fragment);
}

function appendSessionListMore(fragment, total, visibleCount) {
  if (state.sessionViewMode === 'recent' || visibleCount >= total) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'session-more-button';
  button.textContent = `加载更多 ${Math.min(SESSION_RENDER_STEP, total - visibleCount)} / 剩余 ${total - visibleCount}`;
  button.addEventListener('click', () => {
    state.sessionRenderLimit = Math.min(total, visibleCount + SESSION_RENDER_STEP);
    renderSessions({ force: true });
  });
  fragment.append(button);
}

function sessionStatusKind(session) {
  if (session.trashedAt) return 'trashed';
  if (isSessionRunning(session)) return 'running';
  if (session.status === 'error') return 'error';
  if (session.source === 'codex') return 'external';
  return 'idle';
}

function sessionStatusLabel(session) {
  if (session.trashedAt) return '回收站';
  if (isSessionRunning(session)) return session.status === 'stopping' ? '停止中' : '运行中';
  if (session.source === 'codex') return '全局 Codex';
  return session.status || 'idle';
}

function formatSessionCwd(cwd = '') {
  return cwd.replace(/^\/root\/Projects\/?/, '~/Projects/');
}

function closeSessionActionSheet() {
  state.sessionActionId = '';
  if (el.sessionActionSheet) el.sessionActionSheet.hidden = true;
  if (el.sessionActionButtons) el.sessionActionButtons.textContent = '';
}

function appendSessionActionButton(label, action, options = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = options.danger ? 'danger' : '';
  button.textContent = label;
  button.addEventListener('click', () => {
    closeSessionActionSheet();
    action();
  });
  el.sessionActionButtons.append(button);
}

function openSessionActionSheet(session) {
  if (!session?.id || !el.sessionActionSheet) return;
  state.sessionActionId = session.id;
  el.sessionActionTitle.textContent = session.title || '未命名会话';
  el.sessionActionMeta.textContent = `${sessionStatusLabel(session)} · ${formatSessionCwd(session.cwd || '')}`;
  el.sessionActionButtons.textContent = '';

  if (session.trashedAt) {
    appendSessionActionButton('还原', () => restoreSession(session));
    appendSessionActionButton('永久删除', () => deleteSession(session), { danger: true });
  } else {
    appendSessionActionButton('重命名', () => renameSession(session));
    appendSessionActionButton('Fork', () => forkSession(session));
    appendSessionActionButton('删除', () => deleteSession(session), { danger: true });
  }

  el.sessionActionSheet.hidden = false;
}

function renderSessionButton(session) {
  const row = document.createElement('div');
  row.className = `session-entry ${session.id === state.activeId ? 'active' : ''}`.trim();

  const button = document.createElement('button');
  button.type = 'button';
  button.className = `session-item ${session.id === state.activeId ? 'active' : ''} ${session.source === 'codex' ? 'external' : ''} ${session.trashedAt ? 'trashed' : ''}`.trim();
  button.innerHTML = `
    <span class="session-title-row">
      <i class="session-status-dot ${sessionStatusKind(session)}" aria-hidden="true"></i>
      <strong>${escapeHtml(session.title || '未命名会话')}</strong>
      <time>${escapeHtml(formatTime(session.trashedAt || session.updatedAt))}</time>
    </span>
    <span class="session-meta-row">${escapeHtml(sessionStatusLabel(session))} · ${escapeHtml(formatSessionCwd(session.cwd || ''))}</span>
  `;
  if (!session.trashedAt) button.addEventListener('click', () => selectSession(session.id));

  const menuButton = document.createElement('button');
  menuButton.type = 'button';
  menuButton.className = 'session-menu-button';
  menuButton.textContent = '⋯';
  menuButton.setAttribute('aria-label', `打开会话操作 ${session.title || session.id}`);
  menuButton.addEventListener('click', (event) => {
    event.stopPropagation();
    openSessionActionSheet(session);
  });

  if (session.trashedAt) {
    row.classList.add('trashed');
    row.append(button, menuButton);
    return row;
  }

  row.append(button, menuButton);
  return row;
}

function renderActive(options = {}) {
  const shouldRenderMessages = options.messages !== false;
  const session = state.sessions.find((item) => item.id === state.activeId);
  const isRunning = isSessionRunning(session);
  const canStop = session?.canStop !== false && isRunning && session?.status !== 'stopping';
  el.emptyState.hidden = Boolean(session);
  el.messagePane.hidden = !session;
  el.promptInput.disabled = !session;
  el.sendButton.disabled = !session || state.sending;
  el.stopButton.hidden = !isRunning;
  el.stopButton.disabled = !session || !canStop;
  el.stopButton.setAttribute('aria-label', canStop ? '停止当前任务' : '正在停止当前任务');
  el.stopButton.title = canStop ? '停止当前任务' : '正在停止当前任务';
  el.connectionBadge.hidden = isRunning;

  if (!session) {
    el.connectionBadge.hidden = false;
    el.activeTitle.textContent = 'Codex Console';
    el.activeMeta.textContent = '未选择会话';
    setBadge(state.online ? '在线' : '离线', state.online ? 'online' : '');
    return;
  }

  el.activeTitle.textContent = session.title;
  el.activeMeta.textContent = session.cwd || '';
  setBadge(isRunning ? session.status === 'stopping' ? '停止中' : '运行中' : state.online ? '在线' : '离线', isRunning ? 'running' : state.online ? 'online' : '');
  if (shouldRenderMessages) {
    renderMessages(session.id, {
      stickToBottom: options.stickToBottom ?? shouldStickToBottom(session.id),
      restoreAnchor: options.restoreAnchor || null
    });
  }
  else {
    updateQueuePanel();
    updateRunIndicator();
    if (options.stickToBottom === true && shouldFollowNewMessage(session.id)) settleMessagesToBottom();
    syncStreamingMarkers();
  }
  updateFavoritesButton();
}

function setProgrammaticMessageScrollTop(value) {
  state.suppressScrollTracking = true;
  const token = beginProgrammaticMessageScroll();
  el.messagePane.scrollTop = Math.max(0, value);
  releaseProgrammaticMessageScroll(token);
}

function beginProgrammaticMessageScroll() {
  state.suppressScrollTracking = true;
  const token = state.scrollSuppressToken + 1;
  state.scrollSuppressToken = token;
  return token;
}

function releaseProgrammaticMessageScroll(token) {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (state.scrollSuppressToken === token) state.suppressScrollTracking = false;
    });
  });
}

function messageBottomDistance() {
  return Math.max(0, el.messagePane.scrollHeight - el.messagePane.scrollTop - el.messagePane.clientHeight);
}

function firstVisibleMessageAnchor() {
  const paneTop = el.messagePane.getBoundingClientRect().top;
  for (const node of el.messagePane.querySelectorAll('.message')) {
    const rect = node.getBoundingClientRect();
    if (rect.bottom < paneTop) continue;
    return {
      seq: node.dataset.seq || '',
      id: node.dataset.messageId || '',
      clientMessageId: node.dataset.clientMessageId || '',
      offset: rect.top - paneTop
    };
  }
  return null;
}

function restoreMessageAnchor(anchor) {
  if (!anchor) return false;
  const nodes = [...el.messagePane.querySelectorAll('.message')];
  const target = nodes.find((node) => {
    const ids = (node.dataset.messageIds || '').split(',').filter(Boolean);
    return (anchor.id && (node.dataset.messageId === anchor.id || ids.includes(anchor.id)))
      || (anchor.clientMessageId && node.dataset.clientMessageId === anchor.clientMessageId)
      || (anchor.seq && Number(node.dataset.seq || 0) === Number(anchor.seq || 0));
  });
  if (!target) return false;
  const paneTop = el.messagePane.getBoundingClientRect().top;
  const targetTop = target.getBoundingClientRect().top;
  setProgrammaticMessageScrollTop(el.messagePane.scrollTop + targetTop - paneTop - anchor.offset);
  return true;
}

function settleMessagesToBottom() {
  setProgrammaticMessageScrollTop(el.messagePane.scrollHeight);
  requestAnimationFrame(() => {
    setProgrammaticMessageScrollTop(el.messagePane.scrollHeight);
    requestAnimationFrame(() => {
      setProgrammaticMessageScrollTop(el.messagePane.scrollHeight);
    });
  });
  setTimeout(() => setProgrammaticMessageScrollTop(el.messagePane.scrollHeight), 80);
  setTimeout(() => setProgrammaticMessageScrollTop(el.messagePane.scrollHeight), 240);
}

function lockInitialBottom(sessionId) {
  state.initialBottomLockSessionId = sessionId || '';
}

function unlockInitialBottom(sessionId = state.activeId) {
  if (!sessionId || state.initialBottomLockSessionId === sessionId) {
    state.initialBottomLockSessionId = '';
  }
}

function shouldStickToBottom(sessionId = state.activeId) {
  return Boolean(sessionId && state.initialBottomLockSessionId === sessionId);
}

function shouldFollowNewMessage(sessionId = state.activeId) {
  return state.autoFollowBottom || shouldStickToBottom(sessionId);
}

function getActiveSession() {
  return state.sessions.find((item) => item.id === state.activeId);
}

function isSessionRunning(session) {
  if (!session) return false;
  if (['idle', 'error'].includes(session.status)) return false;
  if (typeof session.isRunning === 'boolean') return session.isRunning;
  return session.status === 'running' || session.status === 'stopping';
}

function isActiveSessionRunning() {
  return isSessionRunning(getActiveSession());
}

function syncStreamingMarkers() {
  if (isActiveSessionRunning()) return;
  for (const node of el.messagePane.querySelectorAll('.message.streaming')) {
    node.classList.remove('streaming');
  }
}

function mergeSessionSnapshot(nextSession) {
  if (!nextSession?.id) return false;
  const patch = Object.fromEntries(Object.entries(nextSession).filter(([, value]) => value !== undefined));
  const index = state.sessions.findIndex((item) => item.id === nextSession.id);
  if (index < 0) {
    state.sessions.unshift(patch);
    saveSessionCache();
    return true;
  }

  const current = state.sessions[index];
  const next = { ...current, ...patch };
  const scalarKeys = [
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
  const changed = scalarKeys.some((key) => current[key] !== next[key])
    || JSON.stringify(current.queue || []) !== JSON.stringify(next.queue || []);
  if (!changed) return false;

  state.sessions = state.sessions.map((item) => item.id === next.id ? next : item);
  saveSessionCache();
  return true;
}

function renderMessages(sessionId, options = {}) {
  messageScheduler.clearRender(sessionId);
  const stickToBottom = options.stickToBottom ?? shouldStickToBottom(sessionId);
  const messages = displayMessages(sessionId);
  const renderJobId = ++state.renderJobId;
  state.renderingMessages = true;
  state.userScrolledDuringRender = false;
  const previousBottomDistance = messageBottomDistance();
  const previousAnchor = stickToBottom ? null : options.restoreAnchor || firstVisibleMessageAnchor();
  const renderScrollToken = beginProgrammaticMessageScroll();
  el.messagePane.innerHTML = '';
  const olderControl = renderOlderMessagesControl(sessionId);
  if (olderControl) el.messagePane.append(olderControl);
  if (state.showStarredOnly && !messages.length) {
    el.messagePane.append(renderFavoriteEmpty());
  }

  const restoreScroll = (finalChunk = false) => {
    if (!finalChunk) return;
    if (state.userScrolledDuringRender) {
      releaseProgrammaticMessageScroll(renderScrollToken);
      return;
    }
    if (stickToBottom) {
      settleMessagesToBottom();
      releaseProgrammaticMessageScroll(renderScrollToken);
      return;
    }
    if (!restoreMessageAnchor(previousAnchor)) {
      setProgrammaticMessageScrollTop(el.messagePane.scrollHeight - el.messagePane.clientHeight - previousBottomDistance);
    }
    releaseProgrammaticMessageScroll(renderScrollToken);
  };

  const baseChunkSize = isMobileViewport() ? MOBILE_MESSAGE_CHUNK : DESKTOP_MESSAGE_CHUNK;
  const chunkSize = messages.length <= renderedMessageLimit() ? Math.max(1, messages.length) : baseChunkSize;
  let index = 0;
  const renderChunk = () => {
    if (renderJobId !== state.renderJobId || state.activeId !== sessionId) {
      releaseProgrammaticMessageScroll(renderScrollToken);
      return;
    }
    const fragment = document.createDocumentFragment();
    const end = Math.min(index + chunkSize, messages.length);
    for (; index < end; index += 1) {
      fragment.append(messageView.renderMessage(messages[index], { animate: false }));
    }
    el.messagePane.append(fragment);
    if (index < messages.length) {
      requestAnimationFrame(renderChunk);
    } else {
      updateQueuePanel();
      updateRunIndicator();
      restoreScroll(true);
      if (renderJobId === state.renderJobId) state.renderingMessages = false;
      messageScheduler.flushRender();
    }
  };
  renderChunk();
}

function renderOlderMessagesControl(sessionId) {
  if (state.showStarredOnly) return null;
  const page = state.messagePages.get(sessionId);
  if (!page?.hasMore) return null;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'older-messages-button';
  button.textContent = page.loading ? '加载上一轮中...' : '加载上一轮对话';
  button.title = '加载到上一轮对话的开始';
  button.setAttribute('aria-label', button.title);
  button.disabled = page.loading === true;
  button.addEventListener('click', () => loadOlderMessages(sessionId));
  return button;
}

function openImageViewer(src, alt = '图片预览') {
  if (!src) return;
  el.imageViewerImg.src = src;
  el.imageViewerImg.alt = alt;
  el.imageViewer.hidden = false;
}

function closeImageViewer() {
  el.imageViewer.hidden = true;
  el.imageViewerImg.removeAttribute('src');
}

function displayMessages(sessionId) {
  const messages = loadMessages(sessionId);
  const filtered = state.showStarredOnly ? messages.filter((message) => message.starred === true) : messages;
  const maxRendered = sessionRenderedMessageLimit(sessionId);
  const visible = state.showStarredOnly ? filtered : filtered.slice(-maxRendered);
  return mergeDisplayMessages(visible);
}

function mergeDisplayMessages(messages) {
  const out = [];
  for (const message of messages) {
    const previous = out.at(-1);
    const canMerge = ['assistant', 'tool'].includes(message.role)
      && previous?.role === message.role
      && !message.pending
      && !previous.pending;
    if (canMerge) {
      if (message.role === 'tool' && !previous.groupFormatted) {
        previous.text = formatMergedMessagePart(previous);
        previous.groupFormatted = true;
      }
      previous.text = [previous.text, formatMergedMessagePart(message)].filter(Boolean).join('\n\n');
      previous.at = message.at || previous.at;
      previous.seq = message.seq || previous.seq;
      previous.id = previous.id || message.id;
      previous.ids = [...(previous.ids || [previous.id]).filter(Boolean), message.id].filter(Boolean);
      previous.starred = previous.starred === true || message.starred === true;
      previous.streaming = shouldShowStreamingCursor(message, messages);
      previous.groupCount = (previous.groupCount || 1) + 1;
      continue;
    }
    out.push({
      ...message,
      ids: message.id ? [message.id] : [],
      groupCount: 1,
      groupFormatted: false,
      streaming: shouldShowStreamingCursor(message, messages)
    });
  }
  return out;
}

function shouldShowStreamingCursor(message, messages) {
  return message.role === 'assistant' && isLatestAssistant(message, messages) && isActiveSessionRunning();
}

function formatMergedMessagePart(message) {
  if (message.role !== 'tool') return message.text || '';
  const label = message.rawType ? `[${message.rawType}]` : '[tool]';
  return `${label}\n${message.text || ''}`;
}

function isLatestAssistant(message, messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'assistant') return messages[i] === message;
  }
  return false;
}

function renderFavoriteEmpty() {
  const empty = document.createElement('div');
  empty.className = 'favorite-empty';
  empty.textContent = '暂无收藏';
  return empty;
}

function renderSessionLoading(text = '加载会话...') {
  state.renderingMessages = false;
  state.userScrolledDuringRender = false;
  el.emptyState.hidden = true;
  el.messagePane.hidden = false;
  el.messagePane.innerHTML = `<div class="session-loading">${escapeHtml(text)}</div>`;
  removeQueuePanel();
  removeRunIndicator();
}

function renderRunIndicator(session) {
  const indicator = document.createElement('div');
  indicator.className = 'run-indicator';
  indicator.dataset.runIndicator = '1';
  const waiting = session?.queuedCount ? ` · 待执行 ${session.queuedCount} 条` : '';
  const label = session?.status === 'stopping'
    ? '正在停止当前输入'
    : `Codex 正在处理当前输入${waiting}`;
  indicator.innerHTML = `
    <span class="run-orbit" aria-hidden="true"><i></i><i></i><i></i></span>
    <span>${label}</span>
  `;
  return indicator;
}

function updateRunIndicator() {
  const existing = el.messagePane.querySelector('[data-run-indicator="1"]');
  if (existing) existing.remove();
  const session = getActiveSession();
  if (!isSessionRunning(session)) return;
  el.messagePane.append(renderRunIndicator(session));
}

function removeRunIndicator() {
  const existing = el.messagePane.querySelector('[data-run-indicator="1"]');
  if (existing) existing.remove();
}

function updateQueuePanel() {
  const existing = el.messagePane.querySelector('[data-queue-panel="1"]');
  if (existing) existing.remove();
  if (state.showStarredOnly) return;
  const session = getActiveSession();
  if (!session?.queue?.length) return;
  el.messagePane.append(queueView.renderQueuePanel(session));
}

function removeQueuePanel() {
  const existing = el.messagePane.querySelector('[data-queue-panel="1"]');
  if (existing) existing.remove();
}

function isNearMessageBottom() {
  return messageBottomDistance() < 96;
}

function scrollMessagesToBottom() {
  settleMessagesToBottom();
}

function renderPendingImages() {
  el.imagePreviewStrip.innerHTML = '';
  el.imagePreviewStrip.hidden = !state.pendingImages.length;
  for (const image of state.pendingImages) {
    const item = document.createElement('div');
    item.className = 'image-preview-item';
    item.innerHTML = `
      <img src="${escapeHtml(image.data)}" alt="${escapeHtml(image.name)}">
      <span>${escapeHtml(formatBytes(image.size || image.originalSize))}</span>
      <button type="button" aria-label="移除图片">×</button>
    `;
    item.querySelector('button').addEventListener('click', () => {
      state.pendingImages = state.pendingImages.filter((candidate) => candidate.id !== image.id);
      renderPendingImages();
    });
    el.imagePreviewStrip.append(item);
  }
  if (state.pendingImages.length) {
    const actions = document.createElement('div');
    actions.className = 'image-quick-actions';
    for (const item of IMAGE_PROMPTS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = item.label;
      button.addEventListener('click', () => {
        el.promptInput.value = item.value;
        autoSizePrompt();
        el.promptInput.focus();
      });
      actions.append(button);
    }
    el.imagePreviewStrip.append(actions);
  }
}

function imageSizeFromDataUrl(dataUrl) {
  const base64 = String(dataUrl || '').split(',').pop() || '';
  return Math.round(base64.length * 0.75);
}

function renderStorageStats(data) {
  const settings = data.settings || {};
  el.autoCleanupToggle.checked = settings.autoCleanup === true;
  el.uploadRetentionDaysInput.value = settings.uploadRetentionDays ?? 30;
  el.runtimeRetentionDaysInput.value = settings.runtimeRetentionDays ?? 7;
  el.maxUploadMbInput.value = settings.maxUploadMb ?? 1024;
  const diskText = data.disk
    ? `${formatBytes(data.disk.freeBytes)} 可用 / ${formatBytes(data.disk.totalBytes)}`
    : '未知';
  el.storageStats.innerHTML = `
    <span>data ${escapeHtml(formatBytes(data.dataBytes))}</span>
    <span>图片 ${escapeHtml(formatBytes(data.uploadBytes))} · ${data.uploadCount || 0} 张</span>
    <span>孤儿 ${escapeHtml(formatBytes(data.orphanUploadBytes))} · ${data.orphanUploadCount || 0} 张</span>
    <span>运行缓存 ${escapeHtml(formatBytes(data.runtimeBytes))}</span>
    <span>state ${escapeHtml(formatBytes(data.stateBytes))}</span>
    <span>磁盘 ${escapeHtml(diskText)}</span>
  `;
}

async function loadStorageStats() {
  el.storageStats.textContent = '加载中...';
  const data = await api('/api/storage');
  renderStorageStats(data);
}

async function saveStorageSettings() {
  el.saveStorageButton.disabled = true;
  try {
    const data = await api('/api/storage', {
      method: 'PATCH',
      body: JSON.stringify({
        autoCleanup: el.autoCleanupToggle.checked,
        uploadRetentionDays: Number(el.uploadRetentionDaysInput.value || 0),
        runtimeRetentionDays: Number(el.runtimeRetentionDaysInput.value || 0),
        maxUploadMb: Number(el.maxUploadMbInput.value || 0)
      })
    });
    renderStorageStats(data);
  } finally {
    el.saveStorageButton.disabled = false;
  }
}

async function runStorageCleanup(mode) {
  const button = mode === 'runtime' ? el.cleanupRuntimeButton : el.cleanupUploadsButton;
  button.disabled = true;
  try {
    const data = await api('/api/storage/cleanup', {
      method: 'POST',
      body: JSON.stringify({ mode })
    });
    renderStorageStats(data.storage);
  } finally {
    button.disabled = false;
  }
}

function shortCommand(cmdline) {
  const text = (cmdline || []).join(' ').replace(/\s+/g, ' ').trim();
  return summarizeText(text || '-', 160);
}

function localStorageStats() {
  let bytes = 0;
  let cmcKeys = 0;
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index) || '';
    const value = localStorage.getItem(key) || '';
    bytes += (key.length + value.length) * 2;
    if (key.startsWith('cmc.')) cmcKeys += 1;
  }
  return { keys: localStorage.length, cmcKeys, bytes };
}

async function browserRuntimeInfo(sessionId) {
  const now = Date.now();
  if (state.localRuntimeSnapshot && state.localRuntimeSessionId === sessionId && now - state.localRuntimeSnapshotAt < 5000) {
    return state.localRuntimeSnapshot;
  }
  const [storageEstimate, cacheNames] = await Promise.all([
    navigator.storage?.estimate ? navigator.storage.estimate().catch(() => null) : null,
    window.caches?.keys ? caches.keys().catch(() => []) : []
  ]);
  const local = localStorageStats();
  const messages = sessionId ? loadMessages(sessionId) : [];
  const page = sessionId ? loadMessagePage(sessionId) : null;
  const snapshot = {
    online: navigator.onLine,
    visibility: document.visibilityState || '',
    platform: navigator.userAgentData?.platform || navigator.platform || '',
    serviceWorker: 'serviceWorker' in navigator
      ? navigator.serviceWorker.controller ? '已接管' : '未接管'
      : '不支持',
    cacheNames,
    storageUsageBytes: storageEstimate?.usage,
    storageQuotaBytes: storageEstimate?.quota,
    localStorageBytes: local.bytes,
    localStorageKeys: local.keys,
    cmcLocalStorageKeys: local.cmcKeys,
    memoryLimitBytes: performance.memory?.jsHeapSizeLimit || 0,
    memoryUsedBytes: performance.memory?.usedJSHeapSize || 0,
    cachedSessionCount: state.messages.size,
    currentCachedMessages: messages.length,
    currentLastSeq: state.lastSeq.get(sessionId) || 0,
    pageOffset: page?.offset || 0,
    pageTotal: page?.total || 0,
    pageHasMore: page?.hasMore === true,
    pendingImages: state.pendingImages.length,
    renderingMessages: state.renderingMessages,
    updatedAt: new Date().toISOString()
  };
  state.localRuntimeSnapshot = snapshot;
  state.localRuntimeSnapshotAt = now;
  state.localRuntimeSessionId = sessionId;
  return snapshot;
}

function storageRatioText(usage, quota) {
  if (!Number.isFinite(usage) || !Number.isFinite(quota) || quota <= 0) return '未知';
  return `${formatBytes(usage)} / ${formatBytes(quota)} · ${Math.round((usage / quota) * 100)}%`;
}

function renderTokenUsage(data) {
  const usage = data.codexUsage;
  if (!usage?.available) {
    return `
      <div class="runtime-section">
        <strong>Codex 会话</strong>
        <p>${usage?.codexSessionId ? '暂未找到 token_count 记录。' : '当前会话还没有绑定 Codex 原始会话。'}</p>
      </div>
    `;
  }
  const total = usage.totalTokenUsage || {};
  const last = usage.lastTokenUsage || {};
  return `
    <div class="runtime-section">
      <strong>Codex 会话</strong>
      <div class="runtime-meter"><i style="width:${Math.min(100, usage.contextPercent || 0)}%"></i></div>
      <div class="runtime-grid compact">
        <span>上下文 <strong>${formatNumber(usage.contextTokens)}</strong></span>
        <span>窗口 <strong>${formatNumber(usage.modelContextWindow)}</strong></span>
        <span>剩余 <strong>${formatNumber(usage.contextRemaining)}</strong></span>
        <span>占用 <strong>${usage.contextPercent || 0}%</strong></span>
      </div>
      <p>累计 ${formatNumber(total.totalTokens)} token · 输入 ${formatNumber(total.inputTokens)} · 输出 ${formatNumber(total.outputTokens)}</p>
      <span>最近一轮 ${formatNumber(last.totalTokens)} · 缓存输入 ${formatNumber(last.cachedInputTokens)} · 自动压缩剩余为估算</span>
    </div>
  `;
}

function renderServiceRuntime(data) {
  const service = data.service || {};
  const diskText = service.disk
    ? `${formatBytes(service.disk.freeBytes)} / ${formatBytes(service.disk.totalBytes)}`
    : '未知';
  return `
    <div class="runtime-section">
      <strong>服务状态</strong>
      <div class="runtime-grid compact">
        <span>服务 <strong>${escapeHtml(service.version ? `v${service.version}` : service.name || '-')}</strong></span>
        <span>PID <strong>${service.pid || '-'}</strong></span>
        <span>启动 <strong>${escapeHtml(formatDuration(service.uptimeMs || 0))}</strong></span>
        <span>SSE <strong>${service.sseClients || 0}</strong></span>
        <span>运行 <strong>${service.runningSessions || 0}</strong></span>
        <span>请求 <strong>${service.activeRequests || 0}/${formatNumber(service.totalRequests || 0)}</strong></span>
        <span>RSS <strong>${escapeHtml(formatBytes(service.memory?.rssBytes || 0))}</strong></span>
        <span>堆 <strong>${escapeHtml(formatBytes(service.memory?.heapUsedBytes || 0))}</strong></span>
      </div>
      <span>Node ${escapeHtml(service.node || '-')} · ${escapeHtml(service.host || '-')}:${service.port || '-'} · 磁盘 ${escapeHtml(diskText)}</span>
    </div>
  `;
}

function renderBrowserRuntime(local) {
  const cacheText = local.cacheNames?.length ? local.cacheNames.slice(-2).join(', ') : '无';
  const heapText = local.memoryLimitBytes
    ? `${formatBytes(local.memoryUsedBytes)} / ${formatBytes(local.memoryLimitBytes)}`
    : '浏览器未开放';
  return `
    <div class="runtime-section">
      <strong>浏览器本地</strong>
      <div class="runtime-grid compact">
        <span>网络 <strong>${local.online ? '在线' : '离线'}</strong></span>
        <span>页面 <strong>${escapeHtml(local.visibility || '-')}</strong></span>
        <span>SW <strong>${escapeHtml(local.serviceWorker)}</strong></span>
        <span>缓存 <strong>${local.cacheNames?.length || 0}</strong></span>
        <span>存储 <strong>${escapeHtml(storageRatioText(local.storageUsageBytes, local.storageQuotaBytes))}</strong></span>
        <span>local <strong>${escapeHtml(formatBytes(local.localStorageBytes || 0))}</strong></span>
        <span>消息 <strong>${local.currentCachedMessages}/${local.pageTotal || 0}</strong></span>
        <span>分页 <strong>${local.pageOffset || 0}${local.pageHasMore ? '+' : ''}</strong></span>
      </div>
      <span>localStorage ${local.cmcLocalStorageKeys}/${local.localStorageKeys} 项 · JS 堆 ${escapeHtml(heapText)} · ${escapeHtml(cacheText)}</span>
    </div>
  `;
}

async function renderRuntimePanel(data) {
  const active = data.activeRun;
  const processes = data.processes || [];
  const local = await browserRuntimeInfo(data.session?.id || state.activeId);
  el.runtimePanel.innerHTML = `
    <div class="runtime-section">
      <strong>Codex 运行时</strong>
      <div class="runtime-grid compact">
        <span>状态 <strong>${data.running ? '运行中' : '未运行'}</strong></span>
        <span>PID <strong>${data.pid || '-'}</strong></span>
        <span>进程 <strong>${data.processCount || 0}</strong></span>
        <span>内存 <strong>${formatBytes((data.memoryKb || 0) * 1024)}</strong></span>
        <span>CPU <strong>${formatDuration(data.cpuMs || 0)}</strong></span>
        <span>时长 <strong>${formatDuration(data.uptimeMs || 0)}</strong></span>
      </div>
    </div>
    ${renderBrowserRuntime(local)}
    ${renderServiceRuntime(data)}
    ${renderTokenUsage(data)}
    <div class="runtime-section">
      <strong>当前输入</strong>
      <p>${escapeHtml(active?.prompt || '无运行中的输入')}</p>
      <span>${escapeHtml(active?.startedAt ? `开始 ${formatTime(active.startedAt)} · 图片 ${active.imageCount || 0}` : '')}</span>
    </div>
    <div class="runtime-section">
      <strong>队列</strong>
      <p>${data.queue?.length ? `${data.queue.length} 条等待执行` : '无排队输入'}</p>
    </div>
    <div class="runtime-process-list">
      ${processes.length ? processes.map((item) => `
        <div class="runtime-process" style="--depth:${item.depth || 0}">
          <span>PID ${item.pid} · ${escapeHtml(item.state || '-')} · ${formatBytes((item.memoryKb || 0) * 1024)}</span>
          <strong>${escapeHtml(item.name || '-')}</strong>
          <code>${escapeHtml(shortCommand(item.cmdline))}</code>
          <small>${escapeHtml(item.cwd || '')}</small>
        </div>
      `).join('') : '<p class="runtime-empty">没有关联的 Codex 子进程。</p>'}
    </div>
    <small class="runtime-checked">更新 ${escapeHtml(formatTime(data.checkedAt))}</small>
  `;
}

function runtimeErrorCopy(error) {
  if (error?.status === 404 && error?.code === 'session_not_found') {
    return {
      title: '会话不存在',
      detail: '当前选择的会话在服务端已不存在，可能已经被删除、移入回收站，或本地缓存还没同步。'
    };
  }
  if (error?.status === 404 && error?.code === 'not_found') {
    return {
      title: '运行时接口不可用',
      detail: '后端可能还没重启到包含运行时功能的版本。等安全重启完成后再试，或先刷新会话列表。'
    };
  }
  if (error?.status === 401) {
    return {
      title: '登录已失效',
      detail: '请重新登录后再查看运行时。'
    };
  }
  return {
    title: '运行时加载失败',
    detail: error?.message || '暂时无法获取运行时信息。'
  };
}

function renderRuntimeError(error) {
  const copy = runtimeErrorCopy(error);
  el.runtimePanel.innerHTML = `
    <div class="runtime-section">
      <strong>${escapeHtml(copy.title)}</strong>
      <p>${escapeHtml(copy.detail)}</p>
      <button class="ghost-button inline" type="button" data-runtime-refresh>刷新会话</button>
    </div>
  `;
  el.runtimePanel.querySelector('[data-runtime-refresh]')?.addEventListener('click', async () => {
    el.runtimePanel.textContent = '刷新中...';
    await refreshSessions();
    await loadRuntimeInfo().catch(renderRuntimeError);
  });
}

async function loadRuntimeInfo() {
  const session = getActiveSession();
  if (!session) {
    el.runtimePanel.textContent = '未选择会话';
    return;
  }
  const data = await api(`/api/sessions/${encodeURIComponent(session.id)}/runtime`);
  await renderRuntimePanel(data);
  if (data.session && mergeSessionSnapshot(data.session)) {
    renderSessions();
    renderActive({ messages: false });
  }
}

function openRuntimeDialog() {
  if (!state.activeId) return;
  openModal(el.runtimeDialog);
  clearInterval(state.runtimeTimer);
  el.runtimePanel.textContent = '加载中...';
  loadRuntimeInfo().catch(renderRuntimeError);
  state.runtimeTimer = setInterval(() => {
    if (!el.runtimeDialog.open) return;
    loadRuntimeInfo().catch(renderRuntimeError);
  }, 2000);
}

function closeRuntimeDialog() {
  clearInterval(state.runtimeTimer);
  state.runtimeTimer = null;
  closeModal(el.runtimeDialog);
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('解析图片失败。'));
    image.src = dataUrl;
  });
}

async function compressImageDataUrl(dataUrl, type) {
  const image = await loadImage(dataUrl);
  const maxSide = 1600;
  const scale = Math.min(1, maxSide / Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height));
  if (scale >= 1 && imageSizeFromDataUrl(dataUrl) < 1024 * 1024) return dataUrl;

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round((image.naturalWidth || image.width) * scale));
  canvas.height = Math.max(1, Math.round((image.naturalHeight || image.height) * scale));
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const nextType = type === 'image/webp' ? 'image/webp' : 'image/jpeg';
  const compressed = canvas.toDataURL(nextType, 0.82);
  return imageSizeFromDataUrl(compressed) < imageSizeFromDataUrl(dataUrl) ? compressed : dataUrl;
}

function readImageFile(file) {
  return new Promise((resolve, reject) => {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      reject(new Error('只支持 PNG、JPEG、WebP 图片。'));
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      reject(new Error('单张图片不能超过 8MB。'));
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const originalData = String(reader.result || '');
        const compressedData = await compressImageDataUrl(originalData, file.type);
        const nextType = compressedData.startsWith('data:image/webp') ? 'image/webp'
          : compressedData.startsWith('data:image/jpeg') ? 'image/jpeg'
            : file.type;
        resolve({
          id: globalThis.crypto?.randomUUID ? crypto.randomUUID() : `image-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          name: file.name || 'image',
          type: nextType,
          data: compressedData,
          originalSize: file.size,
          size: imageSizeFromDataUrl(compressedData)
        });
      } catch (error) {
        reject(error);
      }
    };
    reader.onerror = () => reject(new Error('读取图片失败。'));
    reader.readAsDataURL(file);
  });
}

async function addImageFiles(fileList) {
  const files = [...fileList].slice(0, Math.max(0, 4 - state.pendingImages.length));
  if (!files.length) return;
  el.imageButton.disabled = true;
  el.imageButton.textContent = '处理中';
  try {
    const images = await Promise.all(files.map(readImageFile));
    state.pendingImages = [...state.pendingImages, ...images].slice(0, 4);
    renderPendingImages();
  } catch (error) {
    alert(error.message || '添加图片失败');
  } finally {
    el.imageInput.value = '';
    el.imageButton.disabled = false;
    el.imageButton.textContent = '图片';
  }
}

function updateRunSettingsState() {
  el.runSettingsState.textContent = el.elevatedRun.checked
    ? '提权默认开启'
    : '提权默认关闭';
}

function insertPromptText(text) {
  const value = el.promptInput.value || '';
  const start = el.promptInput.selectionStart ?? value.length;
  const end = el.promptInput.selectionEnd ?? value.length;
  const prefix = value.slice(0, start);
  const suffix = value.slice(end);
  const next = `${prefix}${text}${suffix}`;
  el.promptInput.value = next;
  const cursor = start + text.length;
  el.promptInput.setSelectionRange(cursor, cursor);
  autoSizePrompt();
  el.promptInput.focus();
}

async function loadSkills(force = false) {
  const fresh = Date.now() - state.skillsLoadedAt < 60 * 1000;
  if (!force && state.skills.length && fresh) {
    skillView.renderSkillViews();
    return;
  }
  el.skillList.textContent = '加载中...';
  el.drawerSkillList.textContent = '加载中...';
  const data = await api('/api/skills');
  state.skills = data.skills || [];
  state.skillsLoadedAt = Date.now();
  skillView.renderSkillStatus(data);
  skillView.renderSkillViews();
}

async function refreshSkillsInBackground() {
  if (el.refreshSkillsButton) el.refreshSkillsButton.disabled = true;
  el.drawerRefreshSkillsButton.disabled = true;
  el.skillStatus.textContent = '已提交扫描，列表会从缓存读取。';
  el.drawerSkillStatus.textContent = '已提交扫描，列表会从缓存读取。';
  try {
    const data = await api('/api/skills/refresh', { method: 'POST' });
    skillView.renderSkillStatus(data);
    setTimeout(() => {
      loadSkills(true).catch((error) => {
        el.skillStatus.textContent = error.message || '刷新状态失败';
        el.drawerSkillStatus.textContent = error.message || '刷新状态失败';
      });
    }, 1200);
  } catch (error) {
    el.skillStatus.textContent = error.message || '提交扫描失败';
    el.drawerSkillStatus.textContent = error.message || '提交扫描失败';
  } finally {
    if (el.refreshSkillsButton) el.refreshSkillsButton.disabled = false;
    el.drawerRefreshSkillsButton.disabled = false;
  }
}

async function openSkillDialog() {
  state.skillDialogMode = 'quick';
  if (el.skillDialogHint) {
    el.skillDialogHint.textContent = '点击 skill 后插入到输入框。';
  }
  openModal(el.skillDialog);
  el.skillSearch.focus();
  try {
    await loadSkills();
  } catch (error) {
    el.skillList.textContent = error.message || '加载失败';
  }
}

function upsertMessage(sessionId, message) {
  const messages = loadMessages(sessionId);
  const replacedIndex = findMessageIndex(messages, message);
  const isNewMessage = replacedIndex < 0;
  const incoming = (message.id || message.seq) ? { ...message, pending: false, failed: false } : message;
  let renderedMessage = incoming;
  if (replacedIndex >= 0) {
    renderedMessage = mergeMessagePair(messages[replacedIndex], incoming);
    messages[replacedIndex] = renderedMessage;
  } else {
    messages.push(incoming);
  }
  messages.sort(compareMessages);
  state.lastSeq.set(sessionId, lastRealSeq(messages));
  messageScheduler.scheduleSave(sessionId);

  if (renderedMessage.status) {
    const nextRunning = renderedMessage.status === 'running' || renderedMessage.status === 'stopping';
    const changed = mergeSessionSnapshot({
      id: sessionId,
      status: renderedMessage.status,
      isRunning: nextRunning,
      canStop: renderedMessage.status === 'running',
      queuedCount: renderedMessage.queuedCount,
      updatedAt: renderedMessage.at
    });
    if (changed) renderSessions();
  }

  if (sessionId === state.activeId) {
    const stickToBottom = isNewMessage ? shouldFollowNewMessage(sessionId) : shouldStickToBottom(sessionId);
    if (state.renderingMessages || replacedIndex >= 0 || renderedMessage.role === 'assistant' || renderedMessage.role === 'tool') {
      messageScheduler.scheduleRender(sessionId, { stickToBottom });
      return;
    }
    const nextNode = messageView.renderMessage(renderedMessage);
    const existing = findRenderedMessageNode(renderedMessage);
    removeRunIndicator();
    removeQueuePanel();
    if (existing) existing.replaceWith(nextNode);
    else el.messagePane.append(nextNode);
    updateQueuePanel();
    updateRunIndicator();
    if (stickToBottom) scrollMessagesToBottom();
    renderActive({ messages: false });
  }
}

function findRenderedMessageNode(message) {
  return [...el.messagePane.querySelectorAll('.message')].find((node) => {
    const ids = (node.dataset.messageIds || '').split(',').filter(Boolean);
    return (message.id && (node.dataset.messageId === message.id || ids.includes(message.id)))
      || (message.clientMessageId && node.dataset.clientMessageId === message.clientMessageId)
      || (message.seq && Number(node.dataset.seq || 0) === Number(message.seq || 0));
  });
}

function updateMessage(sessionId, message) {
  const messages = loadMessages(sessionId);
  const index = findMessageIndex(messages, message);
  if (index < 0) {
    upsertMessage(sessionId, message);
    return;
  }
  const updatedMessage = mergeMessagePair(messages[index], message);
  messages[index] = updatedMessage;
  messages.sort(compareMessages);
  state.lastSeq.set(sessionId, lastRealSeq(messages));
  messageScheduler.scheduleSave(sessionId);
  if (sessionId === state.activeId) {
    if (state.renderingMessages) {
      messageScheduler.scheduleRender(sessionId, { stickToBottom: shouldStickToBottom(sessionId) });
      return;
    }
    const node = findRenderedMessageNode(message);
    if (node) {
      const stickToBottom = shouldStickToBottom(sessionId);
      node.replaceWith(messageView.renderMessage(updatedMessage, { animate: false }));
      updateQueuePanel();
      updateRunIndicator();
      if (stickToBottom) scrollMessagesToBottom();
      renderActive({ messages: false });
    } else {
      messageScheduler.scheduleRender(sessionId, { stickToBottom: shouldStickToBottom(sessionId) });
    }
  }
}

async function refreshSessions(options = {}) {
  try {
    const data = await api('/api/sessions');
    state.sessions = data.sessions || [];
    saveSessionCache();
    const firstWebSession = state.sessions.find((item) => item.source !== 'codex' && !item.trashedAt);
    if (!state.activeId && firstWebSession) setActiveSessionId(firstWebSession.id);
    if (state.activeId && !state.sessions.some((item) => item.id === state.activeId && !item.trashedAt)) {
      setActiveSessionId(firstWebSession?.id || '');
    }
    setActiveSessionId(state.activeId);
    renderSessions();
    if (state.activeId && options.messages !== false) {
      renderActive({ messages: false });
      renderSessionLoading();
      await loadSession(state.activeId, { showLoading: false });
    } else {
      renderActive({ messages: false });
    }
  } catch (error) {
    if (error.status === 401) throw error;
    loadCachedSessions();
    renderSessions();
    renderActive({ messages: options.messages !== false, stickToBottom: true });
  }
}

window.cmcAfterLogin = async function cmcAfterLogin() {
  setAuthView(true);
  await refreshSessions();
};

async function loadSession(id, options = {}) {
  lockInitialBottom(id);
  if (options.showLoading !== false && state.activeId === id) {
    renderActive({ messages: false });
    renderSessionLoading();
  }
  try {
    const knownSession = state.sessions.find((item) => item.id === id);
    if (options.full !== true && isMessageCacheFresh(id, knownSession)) {
      renderSessions();
      renderActive({ stickToBottom: true });
      connectEvents(id);
      startContextRefreshLoop();
      scheduleResourceCleanup();
      return;
    }
    const limit = options.full === true ? maxHistoryLimit() : firstPageLimit();
    const data = await api(sessionMessagesUrl(id, { limit }));
    const session = data.session || { id };
    mergeSessionSnapshot(session);
    const cached = state.messages.get(id) || [];
    const merged = options.full === true
      ? mergeMessages([], data.messages || [])
      : mergeMessages(cached, data.messages || []);
    const trimmed = trimMessagesForStorage(merged);
    state.messages.set(id, trimmed);
    state.lastSeq.set(id, lastRealSeq(trimmed));
    setMessagePage(id, data, { preserveOffset: options.full !== true });
    saveSessionCache();
    saveMessages(id);
    renderSessions();
    renderActive({ stickToBottom: true });
    connectEvents(id);
    startContextRefreshLoop();
    scheduleResourceCleanup();
  } catch {
    loadMessages(id);
    renderActive({ stickToBottom: true });
    connectEvents(id);
    startContextRefreshLoop();
  }
}

async function loadOlderMessages(sessionId) {
  const session = state.sessions.find((item) => item.id === sessionId);
  const page = state.messagePages.get(sessionId);
  if (!session || !page?.hasMore || page.loading || state.loadingOlder) return;
  const loaded = loadMessages(sessionId).length;
  const remaining = Math.max(0, maxHistoryLimit() - loaded);
  if (remaining <= 0) {
    state.messagePages.set(sessionId, { ...page, hasMore: false });
    renderActive({ messages: false });
    return;
  }

  state.loadingOlder = true;
  state.messagePages.set(sessionId, { ...page, loading: true });
  const previousAnchor = firstVisibleMessageAnchor();
  renderActive({ messages: false });
  try {
    const data = await api(sessionMessagesUrl(sessionId, { previousTurn: 1, beforeSeq: page.beforeSeq || '' }));
    if (data.session) mergeSessionSnapshot(data.session);
    const merged = mergeMessages(data.messages || [], loadMessages(sessionId));
    state.messages.set(sessionId, trimMessagesForStorage(merged));
    state.lastSeq.set(sessionId, lastRealSeq(merged));
    expandRenderedMessageLimit(sessionId, (data.messages || []).length);
    setMessagePage(sessionId, {
      ...data,
      hasMore: data.hasMoreBefore === true && merged.length < maxHistoryLimit()
    });
    saveMessages(sessionId);
    if (state.activeId === sessionId) {
      renderSessions();
      renderActive({ stickToBottom: false, restoreAnchor: previousAnchor });
    }
  } catch (error) {
    state.messagePages.set(sessionId, { ...page, loading: false });
    if (state.activeId === sessionId) renderActive({ messages: false });
  } finally {
    state.loadingOlder = false;
    scheduleResourceCleanup();
  }
}

async function refreshActiveContext() {
  const session = getActiveSession();
  if (!session?.codexSessionId || !state.online || state.contextRefreshInFlight) return;
  state.contextRefreshInFlight = true;
  try {
    const page = state.messagePages.get(session.id);
    const currentMessages = loadMessages(session.id);
    const afterSeq = page?.latestSeq || Math.max(0, ...currentMessages.map((message) => Number(message.orderSeq || 0)).filter(Boolean));
    const data = await api(sessionMessagesUrl(session.id, { limit: firstPageLimit(), afterSeq }));
    const nextMessages = data.messages || [];
    const currentLast = currentMessages.at(-1);
    const nextLast = nextMessages.at(-1);
    const mergedMessages = mergeMessages(currentMessages, nextMessages);
    const hasNewMessages = mergedMessages.length > currentMessages.length;
    const changed = currentMessages.length !== mergedMessages.length
      || currentLast?.at !== nextLast?.at
      || currentLast?.text !== nextLast?.text;
    const sessionChanged = mergeSessionSnapshot(data.session);
    if (changed) {
      state.messages.set(session.id, trimMessagesForStorage(mergedMessages));
      state.lastSeq.set(session.id, lastRealSeq(mergedMessages));
      messageScheduler.scheduleSave(session.id);
    }
    setMessagePage(session.id, {
      ...data,
      hasMoreBefore: (state.messagePages.get(session.id)?.hasMore === true) || data.hasMoreBefore === true
    }, { preserveOffset: true });
    if (changed || sessionChanged) {
      if (state.activeId === session.id) {
        const stickToBottom = hasNewMessages ? shouldFollowNewMessage(session.id) : shouldStickToBottom(session.id);
        renderSessions();
        if (changed) messageScheduler.scheduleRender(session.id, { stickToBottom });
        else renderActive({ messages: false });
      }
    }
  } catch {
    // Keep the current cached view; the normal online handler will retry later.
  } finally {
    state.contextRefreshInFlight = false;
  }
}

function startContextRefreshLoop() {
  clearInterval(state.contextRefreshTimer);
  const session = getActiveSession();
  if (!session?.codexSessionId) return;
  state.contextRefreshTimer = setInterval(refreshActiveContext, 5000);
}

function connectEvents(id) {
  if (state.eventSource) state.eventSource.close();
  if (!id || !navigator.onLine) return;

  const after = state.lastSeq.get(id) || 0;
  const source = new EventSource(`/api/events?sessionId=${encodeURIComponent(id)}&after=${after}`);
  state.eventSource = source;

  source.addEventListener('hello', (event) => {
    state.online = true;
    let sessionChanged = false;
    const data = parseEventData(event, {});
    sessionChanged = data?.session ? mergeSessionSnapshot(data.session) : false;
    if (sessionChanged) renderSessions();
    renderActive({ messages: false });
  });

  source.addEventListener('message', (event) => {
    const message = parseEventData(event);
    if (message) upsertMessage(id, message);
  });

  source.addEventListener('message_update', (event) => {
    const message = parseEventData(event);
    if (message) updateMessage(id, message);
  });

  source.addEventListener('session', (event) => {
    const session = parseEventData(event);
    if (!session) return;
    const changed = mergeSessionSnapshot(session);
    if (changed) renderSessions();
    if (session.id === state.activeId) renderActive({ messages: false });
  });

  source.onerror = () => {
    source.close();
    if (state.eventSource === source) state.eventSource = null;
    setBadge('重连中', 'busy');
    setTimeout(() => {
      if (state.activeId === id) connectEvents(id);
    }, 1600);
  };
}

async function selectSession(id) {
  const session = state.sessions.find((item) => item.id === id);
  if (session?.source === 'codex') {
    await importExternalSession(session.codexSessionId);
    return;
  }
  setActiveSessionId(id);
  setDrawer(false);
  renderSessions();
  renderActive({ messages: false });
  renderSessionLoading();
  await loadSession(id, { showLoading: false });
}

async function importExternalSession(codexSessionId) {
  try {
    const data = await api('/api/codex-sessions/import', {
      method: 'POST',
      body: JSON.stringify({ codexSessionId })
    });
    state.sessions = state.sessions.filter((item) => item.codexSessionId !== codexSessionId || item.source !== 'codex');
    state.sessions.unshift(data.session);
    setActiveSessionId(data.session.id);
    saveSessionCache();
    setDrawer(false);
    renderSessions();
    await loadSession(state.activeId);
  } catch (error) {
    alert(error.message || '导入失败');
  }
}

async function forkSession(session) {
  if (!session?.id) return;
  if (isSessionRunning(session)) {
    alert('会话正在运行，停止或等待结束后再 fork。');
    return;
  }
  try {
    setBadge('Fork 中', 'busy');
    const data = await api(`/api/sessions/${encodeURIComponent(session.id)}/fork`, {
      method: 'POST',
      body: JSON.stringify({ title: session.title || '' })
    });
    if (data.session) {
      mergeSessionSnapshot(data.session);
      setActiveSessionId(data.session.id);
      saveSessionCache();
      setDrawer(false);
      renderSessions();
      await loadSession(state.activeId, { full: true });
    }
  } catch (error) {
    const messages = {
      session_running: '会话正在运行，停止或等待结束后再 fork。',
      codex_session_missing: '当前会话还没有绑定 Codex 原始会话，先运行一次后再 fork。',
      codex_session_not_found: '没有找到 Codex 原始会话文件，无法 fork。'
    };
    alert(messages[error.code] || error.detail || error.message || 'Fork 失败');
    renderActive({ messages: false });
  }
}

async function deleteSession(session) {
  const permanent = Boolean(session.trashedAt);
  const deletesCodex = permanent && Boolean(session.codexSessionId);
  const label = permanent
    ? deletesCodex
      ? '永久删除这个 Codex 原始会话文件？这会从 /root/.codex/sessions 删除历史，无法恢复。'
      : '永久删除这个会话记录？无法恢复。'
    : '将这个会话移入回收站？';
  if (!confirm(label)) return;
  try {
    const data = await api(`/api/sessions/${encodeURIComponent(session.id)}`, {
      method: 'DELETE',
      body: JSON.stringify({ permanent, deleteCodex: deletesCodex })
    });
    if (permanent) {
      state.sessions = state.sessions.filter((item) => item.id !== session.id);
    } else if (data.session) {
      mergeSessionSnapshot(data.session);
    }
    if (state.activeId === session.id) {
      setActiveSessionId(state.sessions.find((item) => item.source !== 'codex' && !item.trashedAt)?.id || '');
      if (state.eventSource) state.eventSource.close();
      state.eventSource = null;
    }
    saveSessionCache();
    renderSessions();
    renderActive();
    if (state.activeId) await loadSession(state.activeId);
  } catch (error) {
    alert(error.status === 409 ? '会话正在运行，先停止后再删除。' : error.message || '删除失败');
  }
}

async function restoreSession(session) {
  try {
    const data = await api(`/api/sessions/${encodeURIComponent(session.id)}/restore`, { method: 'POST' });
    if (data.session) mergeSessionSnapshot(data.session);
    renderSessions();
    renderActive();
  } catch (error) {
    alert(error.message || '还原失败');
  }
}

async function renameSession(session) {
  const title = prompt('新的会话名称', session.title || '');
  if (title === null) return;
  const nextTitle = title.trim();
  if (!nextTitle) return;
  try {
    const data = await api(`/api/sessions/${encodeURIComponent(session.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ title: nextTitle })
    });
    mergeSessionSnapshot({ ...(data.session || {}), id: session.id, title: nextTitle });
    if (state.activeId === session.id) {
      el.activeTitle.textContent = nextTitle;
    }
    renderSessions();
  } catch (error) {
    alert(error.message || '改名失败');
  }
}

if (!el.loginForm.dataset.fallbackBound) {
  el.loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    el.loginError.textContent = '';
    el.loginButton.disabled = true;
    el.loginButton.textContent = '登录中';
    const password = new FormData(el.loginForm).get('password');
    try {
      await api('/api/login', { method: 'POST', body: JSON.stringify({ password }) });
      await window.cmcAfterLogin();
    } catch (error) {
      el.loginError.textContent = error.status === 401 ? '密码不正确。' : `登录失败：${error.message}`;
    } finally {
      el.loginButton.disabled = false;
      el.loginButton.textContent = '登录';
    }
  });
}

async function stopCurrentRun() {
  if (!state.activeId) return;
  const sessionId = state.activeId;
  el.stopButton.disabled = true;
  try {
    const data = await api(`/api/sessions/${sessionId}/stop`, { method: 'POST' });
    if (data.session) {
      if (mergeSessionSnapshot(data.session)) renderSessions();
      renderActive({ messages: false });
    }
  } catch (error) {
    upsertMessage(sessionId, {
      at: new Date().toISOString(),
      role: 'system',
      text: error.message || '停止失败'
    });
  }
}

async function toggleStarred(message) {
  const session = getActiveSession();
  if (!session) return;
  const ids = (message.ids?.length ? message.ids : [message.id]).filter(Boolean);
  if (!ids.length) return;
  const next = !message.starred;
  applyLocalStarred(session.id, ids, next);
  renderActive();
  try {
    await Promise.all(ids.map((id) => api(`/api/sessions/${session.id}/messages/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ starred: next })
    })));
  } catch (error) {
    applyLocalStarred(session.id, ids, !next);
    renderActive();
    upsertMessage(session.id, {
      at: new Date().toISOString(),
      role: 'system',
      text: error.message || '收藏失败'
    });
  }
}

function applyLocalStarred(sessionId, ids, starred) {
  const idSet = new Set(ids);
  const messages = loadMessages(sessionId).map((message) => (
    idSet.has(message.id) ? { ...message, starred } : message
  ));
  state.messages.set(sessionId, messages);
  saveMessages(sessionId);
}

function updateFavoritesButton() {
  el.favoritesButton.classList.toggle('active', state.showStarredOnly);
  el.favoritesButton.setAttribute('aria-pressed', String(state.showStarredOnly));
  el.favoritesButton.setAttribute('aria-label', state.showStarredOnly ? '显示全部消息' : '只看收藏');
  el.favoritesButton.title = state.showStarredOnly ? '显示全部消息' : '只看收藏';
  el.favoritesButton.textContent = state.showStarredOnly ? '★' : '☆';
}

el.promptForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  await promptActions.sendPrompt(el.promptInput.value);
});

el.promptInput.addEventListener('keydown', (event) => {
  if (event.isComposing || event.key !== 'Enter') return;
  autoSizePrompt();
});

document.addEventListener('click', () => messageView.closeMessageMenus());

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') messageView.closeMessageMenus();
  if (event.key === 'Escape' && !el.sessionActionSheet?.hidden) closeSessionActionSheet();
  if (event.key === 'Escape' && !el.imageViewer.hidden) closeImageViewer();
});

el.stopButton.addEventListener('click', stopCurrentRun);

el.favoritesButton.addEventListener('click', () => {
  state.showStarredOnly = !state.showStarredOnly;
  storageSet('cmc.showStarredOnly', state.showStarredOnly ? '1' : '0');
  renderActive();
});

el.imageButton.addEventListener('click', () => el.imageInput.click());

el.imageInput.addEventListener('change', () => addImageFiles(el.imageInput.files || []));

el.promptInput.addEventListener('paste', (event) => {
  const files = [...(event.clipboardData?.files || [])].filter((file) => file.type.startsWith('image/'));
  if (!files.length) return;
  event.preventDefault();
  addImageFiles(files);
});

el.themeSelect.addEventListener('change', () => {
  state.theme = el.themeSelect.value;
  storageSet('cmc.theme', state.theme);
  applyTheme(state.theme);
});

el.autoFollowBottom.addEventListener('change', () => {
  state.autoFollowBottom = el.autoFollowBottom.checked;
  storageSet('cmc.autoFollowBottom', state.autoFollowBottom ? '1' : '0');
  if (!state.autoFollowBottom) unlockInitialBottom();
});

el.elevatedRun.addEventListener('change', () => {
  state.elevated = el.elevatedRun.checked;
  storageSet('cmc.elevated', state.elevated ? '1' : '0');
  updateRunSettingsState();
});

el.sessionViewMode.addEventListener('change', () => {
  setSessionViewMode(el.sessionViewMode.value);
});

for (const button of el.sessionViewButtons) {
  button.addEventListener('click', () => setSessionViewMode(button.dataset.sessionView));
}

el.newSessionForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(el.newSessionForm);
  const payload = Object.fromEntries(form.entries());
  try {
    const data = await api('/api/sessions', { method: 'POST', body: JSON.stringify(payload) });
    state.sessions.unshift(data.session);
    setActiveSessionId(data.session.id);
    el.dialog.close();
    saveSessionCache();
    renderSessions();
    await loadSession(state.activeId);
  } catch (error) {
    alert(error.message || '创建失败');
  }
});

el.logoutButton.addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  setAuthView(false);
});

el.openDrawer.addEventListener('click', () => setDrawer(true));
el.closeDrawer.addEventListener('click', () => setDrawer(false));
el.drawerScrim.addEventListener('click', () => setDrawer(false));
el.sessionActionSheet?.addEventListener('click', (event) => {
  if (event.target === el.sessionActionSheet) closeSessionActionSheet();
});
el.closeSessionActionSheet?.addEventListener('click', closeSessionActionSheet);
el.drawerSessionsButton.addEventListener('click', () => setDrawerPanel('sessions'));
el.newSessionButton.addEventListener('click', () => openModal(el.dialog));
el.skillManagerButton.addEventListener('click', () => setDrawerPanel('skills'));
el.drawerSettingsButton.addEventListener('click', () => setDrawerPanel('settings'));
el.commandButton.addEventListener('click', () => {
  skillView.renderCommandList();
  openModal(el.commandDialog);
});
el.closeCommandDialog.addEventListener('click', () => closeModal(el.commandDialog));
el.skillButton.addEventListener('click', () => openSkillDialog());
el.closeSkillDialog.addEventListener('click', () => closeModal(el.skillDialog));
el.closeSkillDetailDialog.addEventListener('click', () => closeModal(el.skillDetailDialog));
el.skillSearch.addEventListener('input', skillView.renderSkillList);
el.drawerSkillSearch.addEventListener('input', skillView.renderDrawerSkillList);
el.refreshSkillsButton?.addEventListener('click', () => {
  refreshSkillsInBackground();
});
el.drawerRefreshSkillsButton.addEventListener('click', () => {
  refreshSkillsInBackground();
});
el.runtimeButton.addEventListener('click', openRuntimeDialog);
el.closeRuntimeDialog.addEventListener('click', closeRuntimeDialog);
el.runtimeDialog.addEventListener('close', () => {
  clearInterval(state.runtimeTimer);
  state.runtimeTimer = null;
});
function selectSettingsPage(page) {
  for (const tab of el.settingsTabs) {
    const active = tab.dataset.settingsTab === page;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  }
  for (const panel of el.settingsPages) {
    panel.classList.toggle('active', panel.dataset.settingsPage === page);
  }
  if (page === 'storage') {
    loadStorageStats().catch((error) => {
      el.storageStats.textContent = error.message || '加载失败';
    });
  }
}

for (const tab of el.settingsTabs) {
  tab.addEventListener('click', () => selectSettingsPage(tab.dataset.settingsTab));
}
el.refreshStorageButton.addEventListener('click', () => loadStorageStats().catch((error) => {
  el.storageStats.textContent = error.message || '刷新失败';
}));
el.saveStorageButton.addEventListener('click', () => saveStorageSettings().catch((error) => {
  el.storageStats.textContent = error.message || '保存失败';
}));
el.cleanupUploadsButton.addEventListener('click', () => runStorageCleanup('orphanUploads').catch((error) => {
  el.storageStats.textContent = error.message || '清理失败';
}));
el.cleanupRuntimeButton.addEventListener('click', () => runStorageCleanup('runtime').catch((error) => {
  el.storageStats.textContent = error.message || '清理失败';
}));
el.closeImageViewer.addEventListener('click', closeImageViewer);
el.imageViewer.addEventListener('click', (event) => {
  if (event.target === el.imageViewer) closeImageViewer();
});
el.cancelNewSession.addEventListener('click', () => closeModal(el.dialog));
el.browseCwdButton.addEventListener('click', () => openDirectoryBrowser(el.cwdInput.value));
el.closeDirectoryDialog.addEventListener('click', () => closeModal(el.directoryDialog));
el.directoryUpButton.addEventListener('click', () => {
  if (el.directoryUpButton.dataset.path) loadDirectories(el.directoryUpButton.dataset.path);
});
el.chooseDirectoryButton.addEventListener('click', () => {
  el.cwdInput.value = state.directoryPath;
  closeModal(el.directoryDialog);
});

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  const colors = {
    graphite: '#101215',
    daylight: '#f5f2ea',
    terminal: '#050806',
    ocean: '#0d1320'
  };
  if (meta) meta.setAttribute('content', colors[theme] || colors.graphite);
}

async function openDirectoryBrowser(startPath) {
  openModal(el.directoryDialog);
  await loadDirectories(startPath || '/root/Projects');
}

async function loadDirectories(dir) {
  el.directoryPath.textContent = '加载中...';
  el.directoryList.innerHTML = '';
  try {
    const data = await api(`/api/fs?path=${encodeURIComponent(dir)}`, { headers: {} });
    state.directoryPath = data.path;
    el.directoryPath.textContent = data.path;
    el.directoryUpButton.disabled = !data.parent;
    el.directoryUpButton.dataset.path = data.parent || '';
    for (const entry of data.entries || []) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'directory-item';
      button.textContent = entry.name;
      button.addEventListener('click', () => loadDirectories(entry.path));
      el.directoryList.append(button);
    }
    if (!el.directoryList.children.length) {
      const empty = document.createElement('p');
      empty.className = 'directory-empty';
      empty.textContent = '没有可进入的子目录。';
      el.directoryList.append(empty);
    }
  } catch (error) {
    el.directoryPath.textContent = error.message || '目录读取失败';
  }
}

function autoSizePrompt() {
  el.promptInput.style.height = 'auto';
  const maxHeight = Math.min(Math.round(window.innerHeight * 0.28), 180);
  el.promptInput.style.height = `${Math.min(el.promptInput.scrollHeight, maxHeight)}px`;
}

el.promptInput.addEventListener('input', autoSizePrompt);

el.messagePane.addEventListener('scroll', () => {
  if (state.suppressScrollTracking) return;
  unlockInitialBottom();
  if (state.renderingMessages) state.userScrolledDuringRender = true;
}, { passive: true });

window.addEventListener('online', () => {
  state.online = true;
  refreshSessions({ messages: false }).catch(() => {});
  if (state.activeId) connectEvents(state.activeId);
  startContextRefreshLoop();
});

window.addEventListener('offline', () => {
  state.online = false;
  if (state.eventSource) state.eventSource.close();
  clearInterval(state.contextRefreshTimer);
  renderActive({ messages: false });
});

document.addEventListener('visibilitychange', () => {
  clearTimeout(state.foregroundRefreshTimer);
  if (document.hidden) {
    messageScheduler.flushSaves();
    return;
  }
  if (!document.hidden) {
    state.foregroundRefreshTimer = setTimeout(() => {
      refreshActiveContext();
    }, 600);
  }
});

window.addEventListener('pagehide', () => messageScheduler.flushSaves());

function registerServiceWorkerLater() {
  if (!('serviceWorker' in navigator)) return;
  scheduleIdle(() => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }, 3000);
}

async function boot() {
  setAuthView(false);
  try {
    await api('/api/me');
    setAuthView(true);
    await refreshSessions();
  } catch {
    loadCachedSessions();
    if (!navigator.onLine && state.sessions.length) {
      setAuthView(true);
      renderSessions({ force: true });
      renderActive({ stickToBottom: true });
    } else {
      setAuthView(false);
    }
  } finally {
    registerServiceWorkerLater();
    scheduleLocalCacheCleanup();
  }
}

boot();
