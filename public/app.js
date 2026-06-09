import { createMessageScheduler } from './message-scheduler.js?v=2';
import { cancelIdle, scheduleIdle, storageGet, storageJsonGet, storageJsonSet, storageSet } from './browser-utils.js?v=1';
import { escapeHtml, formatBytes, formatDuration, formatNumber, formatTime, summarizeText } from './format-utils.js?v=1';
import { compareMessages, findMessageIndex, lastRealSeq, mergeMessagePair, mergeMessages } from './message-utils.js?v=5';
import { createMessageView } from './message-view.js?v=3';
import { createPromptActions } from './prompt-actions.js?v=5';
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
  turnRenderLimits: new Map(),
  messageCollapseStates: new Map(),
  turnCollapseStates: new Map(),
  pendingTurnCollapseSaves: new Set(),
  turnCollapseSaveHandle: null,
  latestTurnIds: new Map(),
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
  sessionListDirty: true,
  sessionRenderLimit: 40,
  loadingOlder: false,
  cleanupTimer: null,
  localCacheCleanupHandle: null,
  promptResizeHandle: 0,
  expandedTurnOrder: [],
  collapsedTurnBodyOrder: [],
  loadingTurnIds: new Set(),
  online: navigator.onLine,
  localRuntimeSnapshot: null,
  localRuntimeSnapshotAt: 0,
  localRuntimeSessionId: '',
  skills: [],
  skillsLoadedAt: 0,
  skillDialogMode: 'quick'
};

const HISTORY_TURN_PAGE_SIZE = 2;
const REFRESH_MESSAGE_LIMIT = 120;
const MAX_CACHED_SESSIONS = 2;
const MAX_LOCAL_MESSAGES = 3000;
const MAX_BROWSER_CACHED_MESSAGES = 3000;
const MIN_BROWSER_CACHED_MESSAGES = 360;
const DEFAULT_RENDERED_TURNS = 3;
const MAX_EXPANDED_TURNS = 2;
const MAX_COLLAPSED_TURN_BODIES = 3;
const SESSION_RENDER_STEP = 40;
const MAX_LOCAL_MESSAGE_CACHE_BYTES = 4_500_000;
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
  renderDebounceMs: 220,
  renderBusyDelayMs: 320,
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
  drawerSessionsButton: document.querySelector('#drawerSessionsButton'),
  drawerSessionsPanel: document.querySelector('#drawerSessionsPanel'),
  drawerSkillsPanel: document.querySelector('#drawerSkillsPanel'),
  sessionList: document.querySelector('#sessionList'),
  newSessionButton: document.querySelector('#newSessionButton'),
  skillManagerButton: document.querySelector('#skillManagerButton'),
  settingsButton: document.querySelector('#settingsButton'),
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
  settingsDialog: document.querySelector('#settingsDialog'),
  closeSettingsDialog: document.querySelector('#closeSettingsDialog'),
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
el.sessionViewMode.value = state.sessionViewMode;
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

function turnCollapseStateKey(sessionId = state.activeId) {
  return `cmc.turnCollapsed.${sessionId || 'global'}`;
}

function messageCollapseId(message) {
  return message.clientMessageId
    || (message.ids || []).find(Boolean)
    || message.id
    || (message.seq ? `seq:${message.seq}` : '')
    || (message.orderSeq ? `order:${message.orderSeq}` : '');
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

function loadTurnCollapseStates(sessionId = state.activeId || 'global') {
  if (state.turnCollapseStates.has(sessionId)) return state.turnCollapseStates.get(sessionId);
  const states = storageJsonGet(turnCollapseStateKey(sessionId), {});
  const safeStates = states && typeof states === 'object' ? states : {};
  state.turnCollapseStates.set(sessionId, safeStates);
  return safeStates;
}

function setTurnCollapsed(sessionId, turnId, collapsed) {
  if (!sessionId || !turnId) return;
  const states = loadTurnCollapseStates(sessionId);
  states[turnId] = collapsed === true;
  state.turnCollapseStates.set(sessionId, states);
  scheduleTurnCollapseSave(sessionId);
}

function scheduleTurnCollapseSave(sessionId) {
  if (!sessionId) return;
  state.pendingTurnCollapseSaves.add(sessionId);
  if (state.turnCollapseSaveHandle) return;
  state.turnCollapseSaveHandle = scheduleIdle(() => {
    state.turnCollapseSaveHandle = null;
    flushTurnCollapseSaves();
  }, 1200);
}

function flushTurnCollapseSaves() {
  cancelIdle(state.turnCollapseSaveHandle);
  state.turnCollapseSaveHandle = null;
  const ids = [...state.pendingTurnCollapseSaves];
  state.pendingTurnCollapseSaves.clear();
  for (const sessionId of ids) {
    storageJsonSet(turnCollapseStateKey(sessionId), loadTurnCollapseStates(sessionId));
  }
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
  if (!saveMessageCacheWithFallback(cacheKey(id), messages)) scheduleLocalCacheCleanup(500);
}

function trimMessagesForStorage(messages) {
  if (!Array.isArray(messages) || messages.length <= MAX_LOCAL_MESSAGES) return messages || [];
  return messages.slice(-MAX_LOCAL_MESSAGES);
}

function cacheSafeMessage(message) {
  return {
    ...message,
    images: (message.images || []).map(cacheSafeImage),
    retryImages: (message.retryImages || []).map(({ data, dataUrl, ...image }) => image)
  };
}

function cacheSafeImage(image) {
  const { data, dataUrl, ...safe } = image || {};
  if (!safe.url && safe.fileName) safe.url = `/api/uploads/${encodeURIComponent(safe.fileName)}`;
  if (!safe.url && !safe.fileName && dataUrl) safe.dataUrl = dataUrl;
  return safe;
}

function safeMessageCache(messages, limit) {
  return messages.slice(-limit).map(cacheSafeMessage);
}

function saveMessageCacheWithFallback(key, messages) {
  const attempts = [];
  let limit = Math.min(MAX_BROWSER_CACHED_MESSAGES, messages.length || 0);
  while (limit > MIN_BROWSER_CACHED_MESSAGES) {
    attempts.push(limit);
    limit = Math.max(MIN_BROWSER_CACHED_MESSAGES, Math.floor(limit / 2));
  }
  attempts.push(Math.min(MIN_BROWSER_CACHED_MESSAGES, messages.length || MIN_BROWSER_CACHED_MESSAGES));
  for (const attempt of [...new Set(attempts.filter((item) => item > 0))]) {
    if (storageJsonSet(key, safeMessageCache(messages, attempt))) return true;
  }
  return storageJsonSet(key, []);
}

function messageListSignature(messages) {
  if (!Array.isArray(messages) || !messages.length) return '0';
  const last = messages.at(-1) || {};
  const middle = messages[Math.floor(messages.length / 2)] || {};
  const checksum = messages.reduce((sum, message) => (
    sum
    + Number(message.orderSeq || message.seq || 0)
    + String(message.text || '').length
    + (message.pending ? 17 : 0)
    + (message.streaming ? 31 : 0)
    + (message.failed ? 47 : 0)
  ), 0);
  return [
    messages.length,
    checksum,
    middle.id || middle.clientMessageId || middle.orderSeq || middle.seq || '',
    last.id || '',
    last.clientMessageId || '',
    last.orderSeq || last.seq || '',
    last.role || '',
    last.at || '',
    String(last.text || '').length,
    last.pending ? 'p' : '',
    last.streaming ? 's' : '',
    last.failed ? 'f' : ''
  ].join(':');
}

function mergeFetchedMessages(currentMessages, fetchedMessages, page = {}) {
  const incoming = Array.isArray(fetchedMessages) ? fetchedMessages : [];
  if (page?.compactTurns !== true) return mergeMessages(currentMessages, incoming);
  const compactRanges = incoming
    .map((message) => message.turnSummary)
    .filter((summary) => summary && summary.full === false && Number(summary.startSeq || 0) > 0)
    .map((summary) => ({
      startSeq: Number(summary.startSeq || 0),
      endSeq: Number(summary.endSeq || summary.startSeq || 0)
    }));
  if (!compactRanges.length) return mergeMessages(currentMessages, incoming);
  const reduced = (currentMessages || []).filter((message) => {
    const seq = Number(message.orderSeq || message.seq || 0);
    if (!seq) return true;
    return !compactRanges.some((range) => seq > range.startSeq && seq <= range.endSeq);
  });
  return mergeMessages(reduced, incoming);
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
  return DEFAULT_RENDERED_TURNS;
}

function maxHistoryLimit() {
  return MAX_LOCAL_MESSAGES;
}

function sessionRenderedTurnLimit(sessionId = state.activeId) {
  return Math.min(maxHistoryLimit(), Math.max(DEFAULT_RENDERED_TURNS, Number(state.turnRenderLimits.get(sessionId) || 0)));
}

function expandRenderedTurnLimit(sessionId, count) {
  if (!sessionId || !Number.isFinite(count) || count <= 0) return;
  const current = sessionRenderedTurnLimit(sessionId);
  state.turnRenderLimits.set(sessionId, Math.min(maxHistoryLimit(), current + count));
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
    totalTurns: Number(page?.totalTurns ?? current.totalTurns ?? 0),
    loadedTurns: Number(page?.loadedTurns ?? countMessageTurns(state.messages.get(sessionId) || [])),
    turnLimit: Number(page?.turnLimit || current.turnLimit || firstPageLimit()),
    compactTurns: options.preserveOffset && page?.compactTurns === false
      ? current.compactTurns === true
      : page?.compactTurns === undefined
      ? current.compactTurns === true
      : page?.compactTurns === true || page?.compactTurns === 'true' || page?.compactTurns === 1,
    latestFull: options.preserveOffset && page?.latestFull === false
      ? current.latestFull === true
      : page?.latestFull === undefined
      ? current.latestFull === true
      : page?.latestFull === true || page?.latestFull === 'true' || page?.latestFull === 1,
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
    && page?.compactTurns === true
    && page?.turnLimit === firstPageLimit()
    && countMessageTurns(messages) >= firstPageLimit();
}

function countMessageTurns(messages) {
  if (!Array.isArray(messages) || !messages.length) return 0;
  return messages.reduce((count, message, index) => (
    count + (index === 0 || message.role === 'user' ? 1 : 0)
  ), 0);
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
      saveMessageCacheWithFallback(key, parsed);
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
  markConnectionOnline();
  return data;
}

function markConnectionOnline() {
  if (state.online === true) return;
  state.online = true;
  renderActive({ messages: false });
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

function setDrawerPanel(panel) {
  state.drawerPanel = panel === 'skills' ? 'skills' : 'sessions';
  const skillsActive = state.drawerPanel === 'skills';
  el.drawerSessionsButton.classList.toggle('active', !skillsActive);
  el.skillManagerButton.classList.toggle('active', skillsActive);
  el.drawerSessionsButton.setAttribute('aria-selected', String(!skillsActive));
  el.skillManagerButton.setAttribute('aria-selected', String(skillsActive));
  el.drawerSessionsPanel.classList.toggle('active', !skillsActive);
  el.drawerSkillsPanel.classList.toggle('active', skillsActive);
  if (skillsActive) {
    loadSkills().catch((error) => {
      el.drawerSkillList.textContent = error.message || '加载失败';
    });
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
      button.innerHTML = `
        <span>${escapeHtml(cwd)}</span>
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

function renderSessionButton(session) {
  const row = document.createElement('div');
  row.className = 'session-entry';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = `session-item ${session.id === state.activeId ? 'active' : ''} ${session.source === 'codex' ? 'external' : ''} ${session.trashedAt ? 'trashed' : ''}`.trim();
  button.innerHTML = `
    <strong>${escapeHtml(session.title)}</strong>
    <span>${escapeHtml(session.trashedAt ? '回收站' : session.source === 'codex' ? '全局 Codex' : session.status || 'idle')} · ${escapeHtml(formatTime(session.trashedAt || session.updatedAt))}</span>
    <span>${escapeHtml(session.cwd || '')}</span>
  `;
  if (!session.trashedAt) button.addEventListener('click', () => selectSession(session.id));

  if (session.trashedAt) {
    row.classList.add('trashed');
    const restoreButton = document.createElement('button');
    restoreButton.type = 'button';
    restoreButton.className = 'session-restore-button';
    restoreButton.textContent = '还';
    restoreButton.setAttribute('aria-label', `还原会话 ${session.title || session.id}`);
    restoreButton.addEventListener('click', (event) => {
      event.stopPropagation();
      restoreSession(session);
    });

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'session-delete-button';
    deleteButton.textContent = '删';
    deleteButton.setAttribute('aria-label', `永久删除会话 ${session.title || session.id}`);
    deleteButton.addEventListener('click', (event) => {
      event.stopPropagation();
      deleteSession(session);
    });

    row.append(button, restoreButton, deleteButton);
    return row;
  }

  const forkButton = document.createElement('button');
  forkButton.type = 'button';
  forkButton.className = 'session-fork-button';
  forkButton.textContent = '分';
  forkButton.setAttribute('aria-label', `Fork 会话 ${session.title || session.id}`);
  forkButton.addEventListener('click', (event) => {
    event.stopPropagation();
    forkSession(session);
  });

  const renameButton = document.createElement('button');
  renameButton.type = 'button';
  renameButton.className = 'session-rename-button';
  renameButton.textContent = '改';
  renameButton.setAttribute('aria-label', `重命名会话 ${session.title || session.id}`);
  renameButton.addEventListener('click', (event) => {
    event.stopPropagation();
    renameSession(session);
  });

  const deleteButton = document.createElement('button');
  deleteButton.type = 'button';
  deleteButton.className = 'session-delete-button';
  deleteButton.textContent = '删';
  deleteButton.setAttribute('aria-label', `删除会话 ${session.title || session.id}`);
  deleteButton.addEventListener('click', (event) => {
    event.stopPropagation();
    deleteSession(session);
  });

  row.append(button, forkButton, renameButton, deleteButton);
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
      restoreAnchor: options.restoreAnchor || null,
      scrollToTop: options.scrollToTop === true
    });
  }
  else {
    updateQueuePanel();
    updateRunIndicator();
    if (options.stickToBottom === true && isRunning && shouldFollowNewMessage(session.id)) settleMessagesToBottom();
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
  for (const node of el.messagePane.querySelectorAll('.message, .conversation-turn')) {
    const rect = node.getBoundingClientRect();
    if (rect.bottom < paneTop) continue;
    return {
      turnId: node.dataset.turnId || '',
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
  const nodes = [...el.messagePane.querySelectorAll('.message, .conversation-turn')];
  const target = nodes.find((node) => {
    const ids = (node.dataset.messageIds || '').split(',').filter(Boolean);
    return (anchor.turnId && node.dataset.turnId === anchor.turnId)
      || (anchor.id && (node.dataset.messageId === anchor.id || ids.includes(anchor.id)))
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
  const existingTurns = new Map([...el.messagePane.querySelectorAll(
    `.conversation-turn[data-session-id="${CSS.escape(sessionId || '')}"]`
  )].map((node) => [node.dataset.turnId, node]));
  const nodes = [];
  const olderControl = renderOlderMessagesControl(sessionId);
  if (olderControl) nodes.push(olderControl);
  if (state.showStarredOnly && !messages.length) {
    nodes.push(renderFavoriteEmpty());
  }

  const restoreScroll = (finalChunk = false) => {
    if (!finalChunk) return;
    if (state.userScrolledDuringRender) {
      releaseProgrammaticMessageScroll(renderScrollToken);
      return;
    }
    if (options.scrollToTop) {
      setProgrammaticMessageScrollTop(0);
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

  const turns = groupMessagesIntoTurns(sessionId, messages);
  for (const turn of turns) {
    const signature = conversationTurnSignature(turn);
    const existing = existingTurns.get(turn.id);
    if (existing?.dataset.turnSignature === signature) {
      nodes.push(existing);
      continue;
    }
    const node = renderConversationTurn(sessionId, turn);
    node.dataset.turnSignature = signature;
    nodes.push(node);
  }
  if (renderJobId !== state.renderJobId || state.activeId !== sessionId) {
    if (renderJobId === state.renderJobId) state.renderingMessages = false;
    releaseProgrammaticMessageScroll(renderScrollToken);
    return;
  }
  el.messagePane.replaceChildren(...nodes);
  pruneTurnDomTracking(sessionId);
  updateQueuePanel();
  updateRunIndicator();
  restoreScroll(true);
  if (renderJobId === state.renderJobId) state.renderingMessages = false;
  messageScheduler.flushRender();
}

function renderOlderMessagesControl(sessionId) {
  if (state.showStarredOnly) return null;
  const page = state.messagePages.get(sessionId);
  if (!page?.hasMore) return null;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'older-messages-button';
  const shown = countMessageTurns(displayMessages(sessionId));
  const total = Number(page.totalTurns || 0);
  button.textContent = page.loading ? '加载中...' : '加载更早';
  button.title = total ? `当前显示 ${shown} 轮，共 ${total} 轮` : `当前显示 ${shown} 轮`;
  button.setAttribute('aria-label', page.loading ? '正在加载更早消息' : `${button.title}，加载更早消息`);
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
  const displayable = state.showStarredOnly ? filtered : messagesForConversationTurns(filtered);
  const visible = state.showStarredOnly ? displayable : visibleMessagesForSession(sessionId, displayable);
  return mergeDisplayMessages(visible);
}

function isQueuedUserMessage(message) {
  return message?.role === 'user' && (message.runState === 'queued' || message.delivery === 'queued');
}

function messagesForConversationTurns(messages) {
  return (messages || []).filter((message) => !isQueuedUserMessage(message));
}

function isConversationMessage(message) {
  return Boolean(message && !isQueuedUserMessage(message));
}

function visibleMessagesForSession(sessionId, messages) {
  if (!Array.isArray(messages) || !messages.length) return [];
  const limit = sessionRenderedTurnLimit(sessionId);
  const turns = splitMessagesIntoTurns(messages);
  return turns.slice(-limit).flat();
}

function turnDomKey(sessionId, turnId) {
  return `${sessionId || 'global'}::${turnId || ''}`;
}

function moveKeyToEnd(list, key) {
  const index = list.indexOf(key);
  if (index >= 0) list.splice(index, 1);
  list.push(key);
}

function removeKey(list, key) {
  const index = list.indexOf(key);
  if (index >= 0) list.splice(index, 1);
}

function pruneTurnDomTracking(sessionId) {
  const liveKeys = new Set([...el.messagePane.querySelectorAll(
    `.conversation-turn[data-session-id="${CSS.escape(sessionId || '')}"]`
  )].map((node) => turnDomKey(sessionId, node.dataset.turnId)));
  state.expandedTurnOrder = state.expandedTurnOrder.filter((key) => !key.startsWith(`${sessionId || 'global'}::`) || liveKeys.has(key));
  state.collapsedTurnBodyOrder = state.collapsedTurnBodyOrder.filter((key) => !key.startsWith(`${sessionId || 'global'}::`) || liveKeys.has(key));
}

function groupMessagesIntoTurns(sessionId, messages) {
  if (state.showStarredOnly) {
    return messages.map((message, index) => createConversationTurn(sessionId, [message], index, false));
  }
  const turns = splitMessagesIntoTurns(messages).map((turnMessages, index) => ({ messages: turnMessages, index }));
  const conversationTurns = turns.map((turn, index) => createConversationTurn(sessionId, turn.messages, index, true));
  autoCollapsePreviousTurns(sessionId, conversationTurns);
  keepLiveTurnExpanded(sessionId, conversationTurns);
  enforceTurnCollapseLimit(sessionId, conversationTurns);
  return conversationTurns;
}

function splitMessagesIntoTurns(messages) {
  const turns = [];
  let current = null;
  for (const message of messages || []) {
    if (!current || message.role === 'user') {
      current = [];
      turns.push(current);
    }
    current.push(message);
  }
  return turns;
}

function createConversationTurn(sessionId, messages, index, defaultCollapsed) {
  const userMessage = messages.find((message) => message.role === 'user') || messages[0] || {};
  const summary = userMessage.turnSummary || {};
  const startSeq = Number(summary.startSeq || userMessage.orderSeq || userMessage.seq || 0);
  const turn = {
    id: conversationTurnId(messages, index),
    index,
    messages,
    defaultCollapsed,
    startSeq,
    endSeq: Number(summary.endSeq || messages.at(-1)?.orderSeq || messages.at(-1)?.seq || startSeq || 0),
    full: summary.full === true || (summary.full !== false && messages.length > 1) || !summary.startSeq,
    messageCount: Number(summary.messageCount || messages.length || 0),
    replyCount: Number(summary.replyCount ?? messages.filter((message) => message.role === 'assistant').length),
    toolCount: Number(summary.toolCount ?? messages.filter((message) => message.role === 'tool').length)
  };
  const states = loadTurnCollapseStates(sessionId);
  turn.collapsed = typeof states[turn.id] === 'boolean' ? states[turn.id] : defaultCollapsed;
  return turn;
}

function enforceTurnCollapseLimit(sessionId, turns) {
  const expanded = turns.filter((turn) => !turn.collapsed);
  if (expanded.length <= MAX_EXPANDED_TURNS) return;
  const states = loadTurnCollapseStates(sessionId);
  let changed = false;
  for (const turn of expanded.slice(0, -MAX_EXPANDED_TURNS)) {
    turn.collapsed = true;
    if (states[turn.id] !== true) {
      states[turn.id] = true;
      changed = true;
    }
  }
  if (!changed) return;
  state.turnCollapseStates.set(sessionId, states);
  scheduleTurnCollapseSave(sessionId);
}

function keepLiveTurnExpanded(sessionId, turns) {
  const latest = turns.at(-1);
  if (!latest) return;
  const session = state.sessions.find((item) => item.id === sessionId);
  const hasLiveMessage = latest.messages.some((message) => (
    ['submitted', 'running', 'stopping'].includes(message.runState)
    || ['submitted', 'running', 'stopping'].includes(message.delivery)
    || ['running', 'stopping'].includes(message.status)
    || message.streaming === true
  ));
  if (!isSessionRunning(session) && !hasLiveMessage) return;
  latest.collapsed = false;
}

function conversationTurnId(messages, index) {
  const userMessage = messages.find((message) => message.role === 'user') || messages[0] || {};
  const key = messageCollapseId(userMessage)
    || userMessage.id
    || userMessage.seq
    || userMessage.orderSeq
    || userMessage.at
    || index;
  return `turn:${key}`;
}

function conversationTurnSignature(turn) {
  const statePart = turn.collapsed ? 'c' : 'e';
  const messagePart = turn.messages.map((message) => [
    message.clientMessageId || message.id || message.seq || message.orderSeq || message.at || '',
    message.role || '',
    message.runState || '',
    message.delivery || '',
    message.status || '',
    message.streaming ? '1' : '',
    message.starred ? '1' : '',
    message.pending ? '1' : '',
    message.failed ? '1' : '',
    String(message.text || '').length,
    String(message.text || '').slice(0, 80),
    String(message.text || '').slice(-80),
    message.images?.length || 0
  ].join(':')).join('|');
  return `${statePart}:${turn.index}:${turn.startSeq}:${turn.endSeq}:${turn.messageCount}:${turn.replyCount}:${turn.toolCount}:${messagePart}`;
}

function renderConversationTurn(sessionId, turn) {
  const section = document.createElement('section');
  section.className = `conversation-turn${turn.collapsed ? ' collapsed' : ''}`;
  section.dataset.sessionId = sessionId;
  section.dataset.turnId = turn.id;
  section.dataset.turnIndex = String(turn.index + 1);
  section.dataset.turnStartSeq = String(turn.startSeq || '');

  const summary = document.createElement('button');
  summary.type = 'button';
  summary.className = 'turn-summary-button';
  summary.setAttribute('aria-expanded', turn.collapsed ? 'false' : 'true');
  summary.innerHTML = `
    <span class="turn-toggle-icon" aria-hidden="true">${turn.collapsed ? '▸' : '▾'}</span>
    <span class="turn-summary-text">${escapeHtml(summarizeTurn(turn))}</span>
  `;
  summary.addEventListener('click', () => {
    const collapsed = !section.classList.contains('collapsed');
    setTurnCollapsed(sessionId, turn.id, collapsed);
    setTurnExpandedState(sessionId, section, turn, !collapsed, { animate: !collapsed });
    if (!collapsed) hydrateTurnIfNeeded(sessionId, section, turn).catch(() => {});
  });
  section.append(summary);

  if (!turn.collapsed) {
    attachTurnBody(sessionId, section, turn);
    moveKeyToEnd(state.expandedTurnOrder, turnDomKey(sessionId, turn.id));
  }
  return section;
}

function createTurnBody(turn) {
  const body = document.createElement('div');
  body.className = 'turn-body';
  for (const message of turn.messages) {
    body.append(messageView.renderMessage(message, { animate: false }));
  }
  return body;
}

function attachTurnBody(sessionId, section, turn, options = {}) {
  let body = section.querySelector(':scope > .turn-body');
  if (!body) body = createTurnBody(turn);
  body.classList.toggle('turn-body-animate', options.animate === true);
  body.hidden = false;
  if (body.parentElement !== section) section.append(body);
  const key = turnDomKey(sessionId, turn.id);
  removeKey(state.collapsedTurnBodyOrder, key);
  moveKeyToEnd(state.expandedTurnOrder, key);
  enforceExpandedTurnDomLimit(sessionId, key);
}

function detachTurnBody(sessionId, section, turn) {
  const body = section.querySelector(':scope > .turn-body');
  if (!body) return;
  body.hidden = true;
  const key = turnDomKey(sessionId, turn.id);
  removeKey(state.expandedTurnOrder, key);
  moveKeyToEnd(state.collapsedTurnBodyOrder, key);
  pruneCollapsedTurnBodies();
}

function setTurnExpandedState(sessionId, section, turn, expanded, options = {}) {
  section.classList.toggle('collapsed', !expanded);
  const button = section.querySelector('.turn-summary-button');
  const icon = section.querySelector('.turn-toggle-icon');
  if (button) button.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  if (icon) icon.textContent = expanded ? '▾' : '▸';
  if (expanded) attachTurnBody(sessionId, section, turn, options);
  else detachTurnBody(sessionId, section, turn);
}

function findTurnSection(sessionId, turnId) {
  return el.messagePane.querySelector(
    `.conversation-turn[data-session-id="${CSS.escape(sessionId || '')}"][data-turn-id="${CSS.escape(turnId || '')}"]`
  );
}

function findDisplayedTurn(sessionId, turnId) {
  const turns = splitMessagesIntoTurns(displayMessages(sessionId))
    .map((messages, index) => createConversationTurn(sessionId, messages, index, true));
  return turns.find((turn) => turn.id === turnId) || null;
}

function findTurnBySeqRange(sessionId, sourceTurn) {
  const startSeq = Number(sourceTurn?.startSeq || 0);
  if (!startSeq) return null;
  const endSeq = Number(sourceTurn?.endSeq || 0);
  const turns = splitMessagesIntoTurns(loadMessages(sessionId));
  const index = turns.findIndex((messages) => {
    const userMessage = messages.find((message) => message.role === 'user') || messages[0] || {};
    const summary = userMessage.turnSummary || {};
    const userSeq = Number(summary.startSeq || userMessage.orderSeq || userMessage.seq || 0);
    return userSeq === startSeq;
  });
  if (index < 0) return null;
  const messages = turns[index].filter((message) => {
    const seq = Number(message.orderSeq || message.seq || 0);
    return !endSeq || !seq || seq <= endSeq;
  });
  return createConversationTurn(sessionId, messages.length ? messages : turns[index], index, false);
}

function enforceExpandedTurnDomLimit(sessionId, keepKey) {
  const sessionPrefix = `${sessionId || 'global'}::`;
  const sessionKeys = state.expandedTurnOrder.filter((key) => key.startsWith(sessionPrefix));
  while (sessionKeys.length > MAX_EXPANDED_TURNS) {
    const key = sessionKeys.find((candidate) => candidate !== keepKey) || sessionKeys[0];
    removeKey(state.expandedTurnOrder, key);
    removeKey(sessionKeys, key);
    const [, turnId] = key.split('::');
    const section = findTurnSection(sessionId, turnId);
    const turn = findDisplayedTurn(sessionId, turnId);
    if (!section || !turn || section.classList.contains('collapsed')) continue;
    setTurnCollapsed(sessionId, turn.id, true);
    setTurnExpandedState(sessionId, section, turn, false);
  }
}

function pruneCollapsedTurnBodies() {
  state.collapsedTurnBodyOrder = state.collapsedTurnBodyOrder.filter((key) => {
    const [sessionId, turnId] = key.split('::');
    const section = findTurnSection(sessionId, turnId);
    const body = section?.querySelector(':scope > .turn-body');
    return Boolean(section?.classList.contains('collapsed') && body?.hidden);
  });
  while (state.collapsedTurnBodyOrder.length > MAX_COLLAPSED_TURN_BODIES) {
    const key = state.collapsedTurnBodyOrder.shift();
    const [sessionId, turnId] = key.split('::');
    const body = findTurnSection(sessionId, turnId)?.querySelector(':scope > .turn-body');
    if (body?.hidden) body.remove();
  }
}

async function hydrateTurnIfNeeded(sessionId, section, turn) {
  const loadingKey = turnDomKey(sessionId, turn.id);
  if (turn.full || !turn.startSeq || state.loadingTurnIds.has(loadingKey)) return;
  state.loadingTurnIds.add(loadingKey);
  section.classList.add('loading-turn');
  try {
    const data = await api(sessionMessagesUrl(sessionId, { turnStartSeq: turn.startSeq }));
    if (data.session) mergeSessionSnapshot(data.session);
    const merged = mergeMessages(loadMessages(sessionId), data.messages || []);
    state.messages.set(sessionId, trimMessagesForStorage(merged));
    state.lastSeq.set(sessionId, lastRealSeq(merged));
    saveMessages(sessionId);
    if (state.activeId !== sessionId || section.classList.contains('collapsed')) return;
    const freshTurn = findTurnBySeqRange(sessionId, turn) || findDisplayedTurn(sessionId, turn.id);
    if (!freshTurn) return;
    const oldBody = section.querySelector(':scope > .turn-body');
    if (oldBody) oldBody.remove();
    attachTurnBody(sessionId, section, freshTurn);
    const summary = section.querySelector('.turn-summary-text');
    if (summary) summary.textContent = summarizeTurn(freshTurn);
  } finally {
    state.loadingTurnIds.delete(loadingKey);
    section.classList.remove('loading-turn');
  }
}

function autoCollapsePreviousTurns(sessionId, turns) {
  const latest = turns.at(-1);
  if (!latest) return;
  const previousLatestId = state.latestTurnIds.get(sessionId);
  state.latestTurnIds.set(sessionId, latest.id);
  if (!previousLatestId || previousLatestId === latest.id) return;
  const states = loadTurnCollapseStates(sessionId);
  let changed = false;
  for (const turn of turns) {
    if (turn.id === latest.id) continue;
    const collapsed = true;
    if (states[turn.id] !== collapsed) {
      states[turn.id] = collapsed;
      changed = true;
    }
    turn.collapsed = collapsed;
  }
  if (!changed) return;
  state.turnCollapseStates.set(sessionId, states);
  scheduleTurnCollapseSave(sessionId);
}

function summarizeTurn(turn) {
  const userMessage = turn.messages.find((message) => message.role === 'user') || turn.messages[0] || {};
  const replies = turn.replyCount || turn.messages.filter((message) => message.role === 'assistant').reduce((sum, message) => sum + (message.groupCount || 1), 0);
  const tools = turn.toolCount || turn.messages.filter((message) => message.role === 'tool').reduce((sum, message) => sum + (message.groupCount || 1), 0);
  const title = userMessage.text || '(空消息)';
  const parts = [`第 ${turn.index + 1} 轮`, title];
  if (replies) parts.push(`回复 ${replies}`);
  if (tools) parts.push(`工具 ${tools}`);
  if (userMessage.images?.length) parts.push(`图 ${userMessage.images.length}`);
  return parts.join(' · ');
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

const RUNTIME_HELP = {
  codexStatus: ['当前 Codex 子进程是否仍在执行。', '如果长期运行中但没有输出，可能是命令卡住、网络等待或状态未同步。'],
  codexPid: ['Codex 主子进程的系统进程号。', '为空表示当前没有运行中的 Codex；异常变化可能说明进程重启或已退出。'],
  codexProcessCount: ['当前 Codex 进程树中的进程数量。', '数量持续升高可能表示子命令未退出，会增加资源占用。'],
  codexMemory: ['Codex 进程树占用的常驻内存 RSS 总和。', '持续升高可能导致系统内存压力、变慢或被系统杀进程。'],
  codexCpu: ['Codex 进程树累计消耗的 CPU 时间。', '快速增长通常表示正在高强度执行；长期增长但无输出可能是死循环或重任务。'],
  codexUptime: ['当前 Codex 运行已持续的时间。', '运行过久可能意味着任务卡住、等待输入或命令没有结束。'],
  browserNetwork: ['浏览器报告的网络状态。', '显示离线时实时连接可能中断，但手机浏览器该值不一定完全可靠。'],
  browserVisibility: ['当前页面是前台可见还是后台隐藏。', '后台隐藏时浏览器可能限制定时器和连接，导致刷新延迟。'],
  browserSw: ['Service Worker 是否已接管页面缓存。', '未接管可能导致离线缓存、自动更新和资源刷新行为不稳定。'],
  browserCache: ['浏览器 Cache Storage 中的缓存包数量。', '过多可能占用存储；过少可能表示离线缓存未生效。'],
  browserStorage: ['浏览器可用存储配额及已用比例。', '接近上限会导致本地缓存、图片和消息保存失败。'],
  browserLocal: ['localStorage 当前估算占用。', '过大可能拖慢启动和同步，极端情况下写入会失败。'],
  browserMessages: ['当前会话已缓存在浏览器内存中的消息数量和后端总量。', '数量过大可能导致渲染卡顿；过小可能需要频繁回源加载。'],
  browserPage: ['当前消息分页游标和是否还有更早内容。', '异常时可能导致加载更早失效或重复拉取。'],
  serviceVersion: ['当前 Web 服务版本信息。', '版本不符合预期时，前端功能可能和后端接口不匹配。'],
  servicePid: ['Web 服务 Node 进程号。', '频繁变化表示服务反复重启，可能影响会话稳定性。'],
  serviceUptime: ['Web 服务已连续运行时间。', '过短可能说明服务刚重启；频繁归零说明不稳定。'],
  serviceSse: ['当前连接到服务的实时事件 SSE 客户端数量。', '为 0 时当前没有实时推送连接；过多会增加服务压力。'],
  serviceRunning: ['服务端记录的运行中会话数量。', '不为 0 时安全重启会排队；异常偏高表示状态可能未回收。'],
  serviceRequests: ['当前活跃请求数和累计请求数。', '活跃请求长期不降可能表示接口卡住或网络连接堆积。'],
  serviceRss: ['Web 服务进程常驻内存 RSS。', '持续增长可能表示缓存过大或内存泄漏。'],
  serviceHeap: ['Node.js 已使用的 JavaScript 堆内存。', '接近上限会导致 GC 频繁、卡顿甚至进程崩溃。'],
  contextTokens: ['最近记录的当前上下文输入 token 数。', '接近窗口上限时，Codex 可能触发压缩或遗漏更早上下文。'],
  contextWindow: ['当前模型可用的上下文窗口大小。', '过小会更早触发压缩；为 0 表示未读取到模型窗口。'],
  contextRemaining: ['估算还能放入上下文的 token 数。', '过低时长任务可能更容易丢失早期细节或自动压缩。'],
  contextPercent: ['当前上下文窗口占用比例。', '接近 100% 时继续输入可能触发压缩，响应也可能变慢。'],
  currentInput: ['当前正在执行的用户输入。', '如果这里有内容但状态未运行，说明状态同步可能异常。'],
  inputStarted: ['当前输入开始执行的时间和图片数量。', '时间过久或图片数量异常可能导致执行慢、上传失败或上下文过大。'],
  queue: ['等待当前任务结束后执行的输入数量。', '队列过长会延迟后续任务；异常不清空会造成误执行。'],
  processSummary: ['单个关联进程的 PID、状态和内存。', '状态异常或内存持续升高，可能表示命令卡住或资源泄漏。'],
  processName: ['系统报告的进程名称。', '名称不符合预期可能表示关联到了错误子进程。'],
  processCommand: ['启动该进程时的命令行。', '命令异常可能说明 Codex 或工具参数错误。'],
  processCwd: ['该进程当前工作目录。', '目录错误会导致读写文件、执行命令的位置不符合预期。'],
  runtimeChecked: ['运行时信息最后一次刷新时间。', '时间过旧说明刷新失败或页面被后台限制。'],
  serviceFooter: ['服务运行环境、监听地址和服务器磁盘剩余空间。', '磁盘不足会导致日志、缓存、上传图片和会话保存失败。'],
  browserFooter: ['浏览器本地缓存详情、JS 堆和最近缓存包。', 'JS 堆过高会造成前端卡顿；缓存异常会影响离线和更新。'],
  tokenTotal: ['Codex 已记录的累计 token 用量。', '异常过高可能表示长会话成本和上下文压力较大。'],
  tokenLast: ['最近一轮 token 用量和缓存输入量。', '最近一轮过大可能导致响应慢或更早触发压缩。']
};

function runtimeHelp(key) {
  const copy = RUNTIME_HELP[key];
  if (!copy) return '';
  const text = `含义：${copy[0]}\n异常后果：${copy[1]}`;
  return `<button class="runtime-help" type="button" data-runtime-help="${escapeHtml(text)}" aria-label="${escapeHtml(text)}" title="${escapeHtml(text)}">?</button>`;
}

function runtimeItem(label, valueHtml, helpKey) {
  return `<span>${escapeHtml(label)} ${runtimeHelp(helpKey)}<strong>${valueHtml}</strong></span>`;
}

function runtimeNote(text, helpKey) {
  return `<span class="runtime-note">${runtimeHelp(helpKey)}${escapeHtml(text)}</span>`;
}

function bindRuntimeHelp() {
  for (const button of el.runtimePanel.querySelectorAll('[data-runtime-help]')) {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      alert(button.dataset.runtimeHelp || button.title || '');
    });
  }
}

function renderTokenUsage(data) {
  const usage = data.codexUsage;
  if (!usage?.available) {
    return `
      <div class="runtime-section">
        <strong>Codex 会话</strong>
        <p>${runtimeHelp('contextTokens')}${usage?.codexSessionId ? '暂未找到 token_count 记录。' : '当前会话还没有绑定 Codex 原始会话。'}</p>
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
        ${runtimeItem('上下文', formatNumber(usage.contextTokens), 'contextTokens')}
        ${runtimeItem('窗口', formatNumber(usage.modelContextWindow), 'contextWindow')}
        ${runtimeItem('剩余', formatNumber(usage.contextRemaining), 'contextRemaining')}
        ${runtimeItem('占用', `${usage.contextPercent || 0}%`, 'contextPercent')}
      </div>
      <p>${runtimeHelp('tokenTotal')}累计 ${formatNumber(total.totalTokens)} token · 输入 ${formatNumber(total.inputTokens)} · 输出 ${formatNumber(total.outputTokens)}</p>
      ${runtimeNote(`最近一轮 ${formatNumber(last.totalTokens)} · 缓存输入 ${formatNumber(last.cachedInputTokens)} · 自动压缩剩余为估算`, 'tokenLast')}
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
        ${runtimeItem('服务', escapeHtml(service.version ? `v${service.version}` : service.name || '-'), 'serviceVersion')}
        ${runtimeItem('PID', String(service.pid || '-'), 'servicePid')}
        ${runtimeItem('启动', escapeHtml(formatDuration(service.uptimeMs || 0)), 'serviceUptime')}
        ${runtimeItem('SSE', String(service.sseClients || 0), 'serviceSse')}
        ${runtimeItem('运行', String(service.runningSessions || 0), 'serviceRunning')}
        ${runtimeItem('请求', `${service.activeRequests || 0}/${formatNumber(service.totalRequests || 0)}`, 'serviceRequests')}
        ${runtimeItem('RSS', escapeHtml(formatBytes(service.memory?.rssBytes || 0)), 'serviceRss')}
        ${runtimeItem('堆', escapeHtml(formatBytes(service.memory?.heapUsedBytes || 0)), 'serviceHeap')}
      </div>
      ${runtimeNote(`Node ${service.node || '-'} · ${service.host || '-'}:${service.port || '-'} · 磁盘 ${diskText}`, 'serviceFooter')}
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
        ${runtimeItem('网络', local.online ? '在线' : '离线', 'browserNetwork')}
        ${runtimeItem('页面', escapeHtml(local.visibility || '-'), 'browserVisibility')}
        ${runtimeItem('SW', escapeHtml(local.serviceWorker), 'browserSw')}
        ${runtimeItem('缓存', String(local.cacheNames?.length || 0), 'browserCache')}
        ${runtimeItem('存储', escapeHtml(storageRatioText(local.storageUsageBytes, local.storageQuotaBytes)), 'browserStorage')}
        ${runtimeItem('local', escapeHtml(formatBytes(local.localStorageBytes || 0)), 'browserLocal')}
        ${runtimeItem('消息', `${local.currentCachedMessages}/${local.pageTotal || 0}`, 'browserMessages')}
        ${runtimeItem('分页', `${local.pageOffset || 0}${local.pageHasMore ? '+' : ''}`, 'browserPage')}
      </div>
      ${runtimeNote(`localStorage ${local.cmcLocalStorageKeys}/${local.localStorageKeys} 项 · JS 堆 ${heapText} · ${cacheText}`, 'browserFooter')}
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
        ${runtimeItem('状态', data.running ? '运行中' : '未运行', 'codexStatus')}
        ${runtimeItem('PID', String(data.pid || '-'), 'codexPid')}
        ${runtimeItem('进程', String(data.processCount || 0), 'codexProcessCount')}
        ${runtimeItem('内存', escapeHtml(formatBytes((data.memoryKb || 0) * 1024)), 'codexMemory')}
        ${runtimeItem('CPU', escapeHtml(formatDuration(data.cpuMs || 0)), 'codexCpu')}
        ${runtimeItem('时长', escapeHtml(formatDuration(data.uptimeMs || 0)), 'codexUptime')}
      </div>
    </div>
    ${renderBrowserRuntime(local)}
    ${renderServiceRuntime(data)}
    ${renderTokenUsage(data)}
    <div class="runtime-section">
      <strong>当前输入</strong>
      <p>${runtimeHelp('currentInput')}${escapeHtml(active?.prompt || '无运行中的输入')}</p>
      ${runtimeNote(active?.startedAt ? `开始 ${formatTime(active.startedAt)} · 图片 ${active.imageCount || 0}` : '当前没有开始时间。', 'inputStarted')}
    </div>
    <div class="runtime-section">
      <strong>队列</strong>
      <p>${runtimeHelp('queue')}${data.queue?.length ? `${data.queue.length} 条等待执行` : '无排队输入'}</p>
    </div>
    <div class="runtime-process-list">
      ${processes.length ? processes.map((item) => `
        <div class="runtime-process" style="--depth:${item.depth || 0}">
          <span>${runtimeHelp('processSummary')}PID ${item.pid} · ${escapeHtml(item.state || '-')} · ${formatBytes((item.memoryKb || 0) * 1024)}</span>
          <strong>${runtimeHelp('processName')}${escapeHtml(item.name || '-')}</strong>
          <code>${runtimeHelp('processCommand')}${escapeHtml(shortCommand(item.cmdline))}</code>
          <small>${runtimeHelp('processCwd')}${escapeHtml(item.cwd || '')}</small>
        </div>
      `).join('') : '<p class="runtime-empty">没有关联的 Codex 子进程。</p>'}
    </div>
    <small class="runtime-checked">${runtimeHelp('runtimeChecked')}更新 ${escapeHtml(formatTime(data.checkedAt))}</small>
  `;
  bindRuntimeHelp();
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
  el.refreshSkillsButton.disabled = true;
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
    el.refreshSkillsButton.disabled = false;
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
  const wasConversationMessage = replacedIndex >= 0 && isConversationMessage(messages[replacedIndex]);
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
    const isVisibleConversationMessage = isConversationMessage(renderedMessage);
    if (wasConversationMessage || isVisibleConversationMessage) {
      messageScheduler.scheduleRender(sessionId, {
        stickToBottom: replacedIndex < 0 ? shouldFollowNewMessage(sessionId) : shouldStickToBottom(sessionId)
      });
    }
    renderActive({ messages: false, stickToBottom: false });
  }
}

function updateMessage(sessionId, message) {
  const messages = loadMessages(sessionId);
  const index = findMessageIndex(messages, message);
  if (index < 0) {
    upsertMessage(sessionId, message);
    return;
  }
  const wasConversationMessage = isConversationMessage(messages[index]);
  const updatedMessage = mergeMessagePair(messages[index], message);
  messages[index] = updatedMessage;
  messages.sort(compareMessages);
  state.lastSeq.set(sessionId, lastRealSeq(messages));
  messageScheduler.scheduleSave(sessionId);
  if (sessionId === state.activeId) {
    if (wasConversationMessage || isConversationMessage(updatedMessage)) {
      messageScheduler.scheduleRender(sessionId, { stickToBottom: shouldStickToBottom(sessionId) });
    }
    renderActive({ messages: false, stickToBottom: false });
  }
}

async function refreshSessions(options = {}) {
  try {
    if (options.messages !== false) {
      loadCachedSessions();
      if (state.activeId) {
        setActiveSessionId(state.activeId);
        renderSessions({ force: true });
        renderActive({ stickToBottom: true });
      }
    }
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
    loadMessages(id);
    renderActive({ stickToBottom: true });
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
    const data = await api(sessionMessagesUrl(
      id,
      options.full === true
        ? { limit: maxHistoryLimit() }
        : { turnLimit: firstPageLimit(), compactTurns: 1, latestFull: 1 }
    ));
    const session = data.session || { id };
    mergeSessionSnapshot(session);
    const cached = state.messages.get(id) || [];
    const previousSignature = messageListSignature(cached);
    const merged = options.full === true
      ? mergeMessages([], data.messages || [])
      : mergeFetchedMessages(cached, data.messages || [], data);
    const trimmed = trimMessagesForStorage(merged);
    const nextSignature = messageListSignature(trimmed);
    state.messages.set(id, trimmed);
    state.lastSeq.set(id, lastRealSeq(trimmed));
    setMessagePage(id, data, { preserveOffset: options.full !== true });
    saveSessionCache();
    saveMessages(id);
    renderSessions();
    renderActive({ messages: previousSignature !== nextSignature, stickToBottom: true });
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
  renderActive({ messages: false });
  try {
    const data = await api(sessionMessagesUrl(sessionId, {
      turnLimit: HISTORY_TURN_PAGE_SIZE,
      beforeSeq: page.beforeSeq || '',
      compactTurns: 1,
      latestFull: 1
    }));
    if (data.session) mergeSessionSnapshot(data.session);
    const loadedOlderTurns = Number(data.loadedTurns || countMessageTurns(data.messages || []));
    const merged = mergeFetchedMessages(loadMessages(sessionId), data.messages || [], data);
    state.messages.set(sessionId, trimMessagesForStorage(merged));
    state.lastSeq.set(sessionId, lastRealSeq(merged));
    expandRenderedTurnLimit(sessionId, loadedOlderTurns);
    setMessagePage(sessionId, {
      ...data,
      hasMore: data.hasMoreBefore === true && merged.length < maxHistoryLimit()
    });
    saveMessages(sessionId);
    if (state.activeId === sessionId) {
      renderSessions();
      renderActive({ stickToBottom: false, scrollToTop: true });
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
  if (!session?.codexSessionId || state.contextRefreshInFlight) return;
  state.contextRefreshInFlight = true;
  try {
    const page = state.messagePages.get(session.id);
    const currentMessages = loadMessages(session.id);
    const afterSeq = page?.latestSeq || Math.max(0, ...currentMessages.map((message) => Number(message.orderSeq || 0)).filter(Boolean));
    const data = await api(sessionMessagesUrl(session.id, { limit: REFRESH_MESSAGE_LIMIT, afterSeq }));
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
  if (!id) return;

  const after = state.lastSeq.get(id) || 0;
  const source = new EventSource(`/api/events?sessionId=${encodeURIComponent(id)}&after=${after}`);
  state.eventSource = source;

  source.addEventListener('hello', (event) => {
    markConnectionOnline();
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
  state.sessionViewMode = el.sessionViewMode.value;
  storageSet('cmc.sessionViewMode', state.sessionViewMode);
  resetSessionRenderLimit();
  renderSessions();
});

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
el.drawerSessionsButton.addEventListener('click', () => setDrawerPanel('sessions'));
el.newSessionButton.addEventListener('click', () => openModal(el.dialog));
el.skillManagerButton.addEventListener('click', () => setDrawerPanel('skills'));
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
el.refreshSkillsButton.addEventListener('click', () => {
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

el.settingsButton.addEventListener('click', () => {
  openModal(el.settingsDialog);
  selectSettingsPage('ui');
});
el.closeSettingsDialog.addEventListener('click', () => closeModal(el.settingsDialog));
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
  if (state.promptResizeHandle) return;
  state.promptResizeHandle = requestAnimationFrame(() => {
    state.promptResizeHandle = 0;
    el.promptInput.style.height = 'auto';
    const maxHeight = Math.min(Math.round(window.innerHeight * 0.28), 180);
    el.promptInput.style.height = `${Math.min(el.promptInput.scrollHeight, maxHeight)}px`;
  });
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
  if (state.eventSource && navigator.onLine === false) state.eventSource.close();
  clearInterval(state.contextRefreshTimer);
  renderActive({ messages: false });
});

document.addEventListener('visibilitychange', () => {
  clearTimeout(state.foregroundRefreshTimer);
  if (document.hidden) {
    messageScheduler.flushSaves();
    flushTurnCollapseSaves();
    return;
  }
  if (!document.hidden) {
    state.foregroundRefreshTimer = setTimeout(() => {
      if (state.activeId) connectEvents(state.activeId);
      refreshActiveContext();
    }, 600);
  }
});

window.addEventListener('pagehide', () => {
  messageScheduler.flushSaves();
  flushTurnCollapseSaves();
});

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
