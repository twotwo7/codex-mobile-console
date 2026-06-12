import { createMessageScheduler } from './message-scheduler.js?v=2';
import { cancelIdle, scheduleIdle, storageGet, storageJsonGet, storageJsonSet, storageSet } from './browser-utils.js?v=1';
import { createConnectionState } from './connection-state.js?v=1';
import { escapeHtml, formatBytes, formatDuration, formatNumber, formatTime, summarizeText } from './format-utils.js?v=1';
import { createFrontendEvents } from './frontend-events.js?v=1';
import { compareMessages, findMessageIndex, lastRealSeq, mergeMessagePair, mergeMessages } from './message-utils.js?v=2';
import { createMessageView } from './message-view.js?v=6';
import { createPerformanceMetrics } from './performance-metrics.js?v=1';
import { createPromptActions } from './prompt-actions.js?v=8';
import { createQueueView } from './queue-view.js?v=6';
import { createSessionStateController } from './session-state.js?v=2';
import { createSkillView } from './skill-view.js?v=3';
import { createTopbarView } from './topbar-view.js?v=1';

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
  pendingFiles: [],
  sending: false,
  directoryPath: '/root/Projects',
  expandedCwds: new Set(storedExpandedCwds),
  messages: new Map(),
  messagePages: new Map(),
  messageRenderLimits: new Map(),
  messageCollapseStates: new Map(),
  lastSeq: new Map(),
  eventSource: null,
  eventConnectionStatus: 'closed',
  frontendEvents: [],
  lastEventAt: '',
  lastContextRefreshAt: '',
  lastSessionSnapshotAt: '',
  contextRefreshTimer: null,
  contextRefreshInFlight: false,
  foregroundRefreshTimer: null,
  promptAutoSizeFrame: 0,
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
  skillDialogMode: 'quick',
  installPromptEvent: null,
  installStatus: ''
};

let sessionState;
let topbarView;
const connectionState = createConnectionState({ online: state.online });

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
const APP_ASSET_VERSION = '121';
const SW_CACHE_VERSION = 'codex-console-v138';

const frontendEvents = createFrontendEvents({
  limit: 50,
  storage: localStorage,
  storageKey: 'cmc.frontendEvents',
  onChange: (events) => {
    state.frontendEvents = events;
  }
});
state.frontendEvents = frontendEvents.snapshot();
const performanceMetrics = createPerformanceMetrics();

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
  topMoreButton: document.querySelector('#topMoreButton'),
  topMoreMenu: document.querySelector('#topMoreMenu'),
  favoritesButton: document.querySelector('#favoritesButton'),
  runtimeButton: document.querySelector('#runtimeButton'),
  installAppButton: document.querySelector('#installAppButton'),
  attachmentButton: document.querySelector('#attachmentButton'),
  attachmentMenu: document.querySelector('#attachmentMenu'),
  imageButton: document.querySelector('#imageButton'),
  imageInput: document.querySelector('#imageInput'),
  fileButton: document.querySelector('#fileButton'),
  fileInput: document.querySelector('#fileInput'),
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
  installAppSettingsButton: document.querySelector('#installAppSettingsButton'),
  installAppStatus: document.querySelector('#installAppStatus'),
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
  queueEditDialog: document.querySelector('#queueEditDialog'),
  queueEditForm: document.querySelector('#queueEditForm'),
  queueEditInput: document.querySelector('#queueEditInput'),
  queueEditMeta: document.querySelector('#queueEditMeta'),
  queueEditError: document.querySelector('#queueEditError'),
  cancelQueueEdit: document.querySelector('#cancelQueueEdit'),
  discardQueueEdit: document.querySelector('#discardQueueEdit'),
  saveQueueEdit: document.querySelector('#saveQueueEdit'),
  imageViewer: document.querySelector('#imageViewer'),
  closeImageViewer: document.querySelector('#closeImageViewer'),
  imageViewerImg: document.querySelector('#imageViewerImg')
};

topbarView = createTopbarView({
  el,
  getOnline: () => state.online,
  isSessionRunning: (session) => sessionState ? sessionState.isSessionRunning(session) : false,
  updateFavoritesButton
});

sessionState = createSessionStateController({
  getActiveId: () => state.activeId,
  getSessions: () => state.sessions,
  setSessions: (sessions) => {
    state.sessions = sessions;
  },
  saveSessionCache,
  onActiveSessionChange: (session) => {
    mirrorConnectionState(connectionState.markSessionSnapshot());
    topbarView.renderActiveStatus(session);
  },
  onSessionChange: () => {
    mirrorConnectionState(connectionState.markSessionSnapshot());
  }
});

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
  editQueuedPromptText: openQueueEditDialog,
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
  mergeQueuedPrompts: promptActions.mergeQueuedPrompts,
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
    retryImages: (message.retryImages || []).map(({ data, dataUrl, ...image }) => image),
    files: (message.files || []).map(({ data, dataUrl, ...file }) => file),
    retryFiles: []
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

function mirrorConnectionState(snapshot = connectionState.snapshot()) {
  state.online = snapshot.online;
  state.eventConnectionStatus = snapshot.eventConnectionStatus;
  state.lastEventAt = snapshot.lastEventAt;
  state.lastContextRefreshAt = snapshot.lastContextRefreshAt;
  state.lastSessionSnapshotAt = snapshot.lastSessionSnapshotAt;
  return snapshot;
}

function recordFrontendEvent(type, detail = '', level = 'info') {
  return frontendEvents.record(type, detail, level);
}

function setActiveSessionId(id = '') {
  const previous = state.activeId || '';
  state.activeId = id || '';
  storageSet('cmc.activeId', state.activeId);
  if (previous !== state.activeId) recordFrontendEvent('session.switch', state.activeId || 'none');
  return state.activeId;
}

function setAuthView(isAuthed) {
  el.loginView.hidden = isAuthed;
  el.appView.hidden = !isAuthed;
}

function isStandaloneApp() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

function installGuidanceText() {
  const ua = navigator.userAgent || '';
  if (/iPhone|iPad|iPod/i.test(ua)) {
    return '当前浏览器不能直接弹出安装框。请用 Safari 打开本站，点底部分享按钮，然后选择“添加到主屏幕”。';
  }
  if (/Android/i.test(ua)) {
    return '当前浏览器暂时没有提供安装框。请点浏览器右上角菜单，然后选择“安装应用”或“添加到主屏幕”。';
  }
  return '当前浏览器暂时没有提供安装框。请在浏览器菜单里选择“安装应用”“添加到桌面”或“创建快捷方式”。';
}

function updateInstallUi() {
  const standalone = isStandaloneApp();
  const canPrompt = Boolean(state.installPromptEvent);
  const status = standalone ? '已从桌面应用模式打开。'
    : canPrompt ? '可以直接安装为桌面应用。'
      : state.installStatus || '可通过浏览器菜单添加到桌面。';
  if (el.installAppStatus) el.installAppStatus.textContent = status;
  for (const button of [el.installAppButton, el.installAppSettingsButton]) {
    if (!button) continue;
    button.disabled = standalone;
    button.textContent = standalone ? '已安装' : canPrompt ? '安装到桌面' : '查看方法';
  }
}

async function installAppToHomeScreen() {
  closeTopMoreMenu();
  if (isStandaloneApp()) {
    state.installStatus = '当前已经是桌面应用模式。';
    updateInstallUi();
    return;
  }
  if (!state.installPromptEvent) {
    state.installStatus = installGuidanceText();
    updateInstallUi();
    alert(state.installStatus);
    return;
  }
  const promptEvent = state.installPromptEvent;
  state.installPromptEvent = null;
  updateInstallUi();
  try {
    promptEvent.prompt();
    const choice = await promptEvent.userChoice;
    const outcome = choice?.outcome || 'unknown';
    state.installStatus = outcome === 'accepted' ? '安装请求已确认。' : '安装已取消。';
    recordFrontendEvent('pwa.install_prompt', outcome);
  } catch (error) {
    state.installStatus = installGuidanceText();
    recordFrontendEvent('pwa.install_failed', error.message || 'failed', 'warn');
    alert(state.installStatus);
  } finally {
    updateInstallUi();
  }
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

function setBadge(text, mode = '') {
  topbarView.setBadge(text, mode);
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

function renderActiveStatus(session = getActiveSession()) {
  topbarView.renderActiveStatus(session);
}

function renderActive(options = {}) {
  const shouldRenderMessages = options.messages !== false;
  const session = state.sessions.find((item) => item.id === state.activeId);
  el.emptyState.hidden = Boolean(session);
  el.messagePane.hidden = !session;
  el.promptInput.disabled = !session;
  el.sendButton.disabled = !session || state.sending;
  renderActiveStatus(session);

  if (!session) {
    return;
  }

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
  return sessionState.getActiveSession();
}

function isSessionRunning(session) {
  return sessionState.isSessionRunning(session);
}

function isActiveSessionRunning() {
  return sessionState.isActiveSessionRunning();
}

function applySessionStatusFromMessage(sessionId, message, messages) {
  return sessionState.applySessionStatusFromMessage(sessionId, message, messages);
}

function syncStreamingMarkers() {
  if (isActiveSessionRunning()) return;
  for (const node of el.messagePane.querySelectorAll('.message.streaming')) {
    node.classList.remove('streaming');
  }
}

function mergeSessionSnapshot(nextSession) {
  return sessionState.mergeSessionSnapshot(nextSession);
}

function renderMessages(sessionId, options = {}) {
  messageScheduler.clearRender(sessionId);
  const stickToBottom = options.stickToBottom ?? shouldStickToBottom(sessionId);
  const messages = displayMessages(sessionId);
  const renderStartedAt = performance.now();
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
      performanceMetrics.record('messages_render', performance.now() - renderStartedAt, { count: messages.length });
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
  el.imagePreviewStrip.hidden = !state.pendingImages.length && !state.pendingFiles.length;
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
  for (const file of state.pendingFiles) {
    const item = document.createElement('div');
    item.className = 'file-preview-item';
    item.innerHTML = `
      <strong title="${escapeHtml(file.name)}">${escapeHtml(summarizeText(file.name || '文件', 18))}</strong>
      <span>${escapeHtml(formatBytes(file.size || file.originalSize || 0))}</span>
      <button type="button" aria-label="移除文件">×</button>
    `;
    item.querySelector('button').addEventListener('click', () => {
      state.pendingFiles = state.pendingFiles.filter((candidate) => candidate.id !== file.id);
      renderPendingImages();
    });
    el.imagePreviewStrip.append(item);
  }
  if (state.pendingImages.length && !state.pendingFiles.length) {
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
    <span>附件 ${escapeHtml(formatBytes(data.uploadBytes))} · ${data.uploadCount || 0} 个</span>
    <span>孤儿 ${escapeHtml(formatBytes(data.orphanUploadBytes))} · ${data.orphanUploadCount || 0} 个</span>
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
  const [storageEstimate, cacheNames] = await Promise.all([
    navigator.storage?.estimate ? navigator.storage.estimate().catch(() => null) : null,
    window.caches?.keys ? caches.keys().catch(() => []) : []
  ]);
  const local = localStorageStats();
  const messages = sessionId ? loadMessages(sessionId) : [];
  const page = sessionId ? loadMessagePage(sessionId) : null;
  const active = getActiveSession();
  const connection = connectionState.snapshot();
  const performanceSnapshot = performanceMetrics.snapshot();
  const snapshot = {
    activeId: state.activeId,
    activeStatus: active?.status || '',
    activeStoredStatus: active?.storedStatus || '',
    activeIsRunning: isSessionRunning(active),
    activeCanStop: active?.canStop !== false && isSessionRunning(active) && active?.status !== 'stopping',
    activeQueuedCount: active?.queuedCount || active?.queue?.length || 0,
    appAssetVersion: APP_ASSET_VERSION,
    swCacheVersion: SW_CACHE_VERSION,
    eventConnectionStatus: connection.eventConnectionStatus,
    lastEventAt: connection.lastEventAt,
    lastContextRefreshAt: connection.lastContextRefreshAt,
    lastSessionSnapshotAt: connection.lastSessionSnapshotAt,
    frontendEventCount: state.frontendEvents.length,
    frontendEvents: state.frontendEvents.slice(0, 50),
    frontendPerformance: performanceSnapshot,
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
    pendingFiles: state.pendingFiles.length,
    renderingMessages: state.renderingMessages,
    renderedMessages: el.messagePane.querySelectorAll('.message').length,
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

function renderFrontendRuntime(local) {
  return `
    <div class="runtime-section">
      <strong>前端状态</strong>
      <div class="runtime-grid compact">
        <span>会话 <strong>${escapeHtml(local.activeId || '-')}</strong></span>
        <span>状态 <strong>${escapeHtml(local.activeStatus || '-')}</strong></span>
        <span>运行 <strong>${local.activeIsRunning ? '是' : '否'}</strong></span>
        <span>可停止 <strong>${local.activeCanStop ? '是' : '否'}</strong></span>
        <span>SSE <strong>${escapeHtml(local.eventConnectionStatus || '-')}</strong></span>
        <span>版本 <strong>${escapeHtml(local.appAssetVersion || '-')}</strong></span>
        <span>渲染 <strong>${local.renderedMessages || 0}</strong></span>
        <span>队列 <strong>${local.activeQueuedCount || 0}</strong></span>
        <span>事件 <strong>${local.frontendEventCount || 0}</strong></span>
      </div>
      <span>事件 ${escapeHtml(formatTime(local.lastEventAt) || '-')} · 主动刷新 ${escapeHtml(formatTime(local.lastContextRefreshAt) || '-')} · 状态快照 ${escapeHtml(formatTime(local.lastSessionSnapshotAt) || '-')} · SW ${escapeHtml(local.swCacheVersion)}</span>
    </div>
  `;
}

function perfText(metric) {
  if (!metric?.count) return '-';
  return `${Math.round(metric.lastMs || 0)} / ${Math.round(metric.maxMs || 0)}ms`;
}

function renderFrontendPerformance(local) {
  const metrics = local.frontendPerformance?.metrics || {};
  const renderDetail = metrics.messages_render?.detail;
  return `
    <div class="runtime-section">
      <strong>前端性能</strong>
      <div class="runtime-grid compact">
        <span>输入延迟 <strong>${escapeHtml(perfText(metrics.prompt_input_frame))}</strong></span>
        <span>输入自适应 <strong>${escapeHtml(perfText(metrics.prompt_autosize))}</strong></span>
        <span>消息渲染 <strong>${escapeHtml(perfText(metrics.messages_render))}</strong></span>
        <span>上下文刷新 <strong>${escapeHtml(perfText(metrics.context_refresh))}</strong></span>
        <span>长任务 <strong>${metrics.longtask?.count || 0}</strong></span>
        <span>最长长任务 <strong>${Math.round(metrics.longtask?.maxMs || 0)}ms</strong></span>
      </div>
      <span>数值为最近/最大耗时；最近渲染 ${escapeHtml(renderDetail?.count ? `${renderDetail.count} 条` : '-')}</span>
    </div>
  `;
}

function renderRuntimeActions() {
  return `
    <div class="runtime-actions">
      <button class="ghost-button inline" type="button" data-runtime-action="refresh">刷新状态</button>
      <button class="ghost-button inline" type="button" data-runtime-action="reconnect">重连 SSE</button>
      <button class="ghost-button inline danger" type="button" data-runtime-action="clear-cache">清前端缓存</button>
    </div>
  `;
}

function renderFrontendEvents(local) {
  const events = local.frontendEvents || [];
  return `
    <div class="runtime-section">
      <strong>前端事件</strong>
      <div class="runtime-event-list">
        ${events.length ? events.map((event) => `
          <div class="runtime-event ${escapeHtml(event.level || 'info')}">
            <span>${escapeHtml(formatTime(event.at) || '-')}</span>
            <strong>${escapeHtml(event.type || 'event')}</strong>
            <small>${escapeHtml(summarizeText(event.detail || '', 120))}</small>
          </div>
        `).join('') : '<p class="runtime-empty">暂无前端事件。</p>'}
      </div>
    </div>
  `;
}

async function clearFrontendCachesAndReload() {
  recordFrontendEvent('runtime.clear_cache', 'requested');
  try {
    const keys = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index) || '';
      if (key.startsWith('cmc.')) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
    if (window.caches?.keys) {
      const names = await caches.keys().catch(() => []);
      await Promise.all(names.filter((name) => name.startsWith('codex-console-')).map((name) => caches.delete(name)));
    }
  } finally {
    location.reload();
  }
}

function bindRuntimeActions() {
  el.runtimePanel.querySelector('[data-runtime-action="refresh"]')?.addEventListener('click', async () => {
    recordFrontendEvent('runtime.refresh', state.activeId || 'none');
    await refreshSessions({ messages: false }).catch((error) => {
      recordFrontendEvent('runtime.refresh_failed', error.message || 'failed', 'warn');
    });
    await refreshActiveContext().catch((error) => {
      recordFrontendEvent('context.refresh_failed', error.message || 'failed', 'warn');
    });
    await loadRuntimeInfo().catch(renderRuntimeError);
  });

  el.runtimePanel.querySelector('[data-runtime-action="reconnect"]')?.addEventListener('click', async () => {
    recordFrontendEvent('runtime.reconnect_sse', state.activeId || 'none');
    if (state.eventSource) {
      state.eventSource.close();
      state.eventSource = null;
    }
    mirrorConnectionState(connectionState.setEventStatus('closed'));
    if (state.activeId) connectEvents(state.activeId);
    await loadRuntimeInfo().catch(renderRuntimeError);
  });

  el.runtimePanel.querySelector('[data-runtime-action="clear-cache"]')?.addEventListener('click', () => {
    if (confirm('清理本应用前端缓存并重新加载？登录态会保留。')) {
      clearFrontendCachesAndReload();
    }
  });
}

async function renderRuntimePanel(data) {
  const active = data.activeRun;
  const processes = data.processes || [];
  const local = await browserRuntimeInfo(data.session?.id || state.activeId);
  el.runtimePanel.innerHTML = `
    ${renderRuntimeActions()}
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
    ${renderFrontendRuntime(local)}
    ${renderFrontendPerformance(local)}
    ${renderBrowserRuntime(local)}
    ${renderServiceRuntime(data)}
    ${renderTokenUsage(data)}
    ${renderFrontendEvents(local)}
    <div class="runtime-section">
      <strong>当前输入</strong>
      <p>${escapeHtml(active?.prompt || '无运行中的输入')}</p>
      <span>${escapeHtml(active?.startedAt ? `开始 ${formatTime(active.startedAt)} · 图片 ${active.imageCount || 0} · 文件 ${active.fileCount || 0}` : '')}</span>
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
  bindRuntimeActions();
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

function openQueueEditDialog(item) {
  messageView.closeMessageMenus();
  closeTopMoreMenu();
  closeAttachmentMenu();
  const current = item.displayPrompt || item.prompt || '';
  el.queueEditInput.value = current;
  el.queueEditInput.setAttribute('aria-invalid', 'false');
  el.queueEditError.textContent = '';
  const imageCount = item.imageCount || item.images?.length || 0;
  const fileCount = item.fileCount || item.files?.length || 0;
  const updateMeta = () => {
    el.queueEditMeta.textContent = `${el.queueEditInput.value.length} 字 · 图片 ${imageCount} · 文件 ${fileCount}`;
  };
  updateMeta();

  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      el.queueEditForm.removeEventListener('submit', onSubmit);
      el.queueEditDialog.removeEventListener('close', onClose);
      el.cancelQueueEdit.removeEventListener('click', onCancel);
      el.discardQueueEdit.removeEventListener('click', onCancel);
      el.queueEditInput.removeEventListener('input', onInput);
      if (el.queueEditDialog.open) closeModal(el.queueEditDialog);
      resolve(value);
    };
    const onCancel = () => finish(null);
    const onClose = () => finish(null);
    const onInput = () => {
      el.queueEditInput.setAttribute('aria-invalid', 'false');
      el.queueEditError.textContent = '';
      updateMeta();
    };
    const onSubmit = (event) => {
      event.preventDefault();
      const next = el.queueEditInput.value.trim();
      if (!next) {
        el.queueEditInput.setAttribute('aria-invalid', 'true');
        el.queueEditError.textContent = '内容不能为空。';
        el.queueEditInput.focus();
        return;
      }
      finish(next === current ? null : next);
    };

    el.queueEditForm.addEventListener('submit', onSubmit);
    el.queueEditDialog.addEventListener('close', onClose);
    el.cancelQueueEdit.addEventListener('click', onCancel);
    el.discardQueueEdit.addEventListener('click', onCancel);
    el.queueEditInput.addEventListener('input', onInput);
    openModal(el.queueEditDialog);
    requestAnimationFrame(() => {
      el.queueEditInput.focus();
      el.queueEditInput.setSelectionRange(el.queueEditInput.value.length, el.queueEditInput.value.length);
    });
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

function setTopMoreMenu(open) {
  topbarView.setTopMoreMenu(open);
}

function closeTopMoreMenu() {
  topbarView.closeTopMoreMenu();
}

function setAttachmentMenu(open) {
  el.attachmentMenu.hidden = !open;
  el.attachmentButton.setAttribute('aria-expanded', String(open));
  if (!open) {
    el.attachmentMenu.style.left = '';
    el.attachmentMenu.style.top = '';
    el.attachmentMenu.style.bottom = '';
    return;
  }
  const buttonRect = el.attachmentButton.getBoundingClientRect();
  const menuRect = el.attachmentMenu.getBoundingClientRect();
  const gap = 6;
  const width = menuRect.width || 112;
  const height = menuRect.height || 76;
  const left = Math.min(Math.max(8, buttonRect.left), Math.max(8, window.innerWidth - width - 8));
  const topAbove = buttonRect.top - height - gap;
  const top = topAbove >= 8 ? topAbove : Math.min(window.innerHeight - height - 8, buttonRect.bottom + gap);
  el.attachmentMenu.style.left = `${Math.round(left)}px`;
  el.attachmentMenu.style.top = `${Math.round(Math.max(8, top))}px`;
  el.attachmentMenu.style.bottom = 'auto';
}

function closeAttachmentMenu() {
  setAttachmentMenu(false);
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

function readGenericFile(file) {
  return new Promise((resolve, reject) => {
    if (file.size > 10 * 1024 * 1024) {
      reject(new Error('单个文件不能超过 10MB。'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      resolve({
        id: globalThis.crypto?.randomUUID ? crypto.randomUUID() : `file-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        name: file.name || 'file',
        type: file.type || 'application/octet-stream',
        data: String(reader.result || ''),
        originalSize: file.size,
        size: file.size
      });
    };
    reader.onerror = () => reject(new Error('读取文件失败。'));
    reader.readAsDataURL(file);
  });
}

async function addImageFiles(fileList) {
  const incoming = [...fileList];
  const imageFiles = incoming.filter((file) => ['image/png', 'image/jpeg', 'image/webp'].includes(file.type));
  const genericFiles = incoming.filter((file) => !['image/png', 'image/jpeg', 'image/webp'].includes(file.type));
  const images = imageFiles.slice(0, Math.max(0, 4 - state.pendingImages.length));
  const files = genericFiles.slice(0, Math.max(0, 6 - state.pendingFiles.length));
  if (!images.length && !files.length) return;
  const totalFileBytes = state.pendingFiles.reduce((sum, file) => sum + (file.size || 0), 0) + files.reduce((sum, file) => sum + file.size, 0);
  if (totalFileBytes > 24 * 1024 * 1024) {
    alert('待发送文件总大小不能超过 24MB。');
    return;
  }
  el.attachmentButton.disabled = true;
  el.attachmentButton.textContent = '处理中';
  try {
    const [nextImages, nextFiles] = await Promise.all([
      Promise.all(images.map(readImageFile)),
      Promise.all(files.map(readGenericFile))
    ]);
    state.pendingImages = [...state.pendingImages, ...nextImages].slice(0, 4);
    state.pendingFiles = [...state.pendingFiles, ...nextFiles].slice(0, 6);
    renderPendingImages();
  } catch (error) {
    alert(error.message || '添加附件失败');
  } finally {
    el.imageInput.value = '';
    el.fileInput.value = '';
    el.attachmentButton.disabled = false;
    el.attachmentButton.textContent = '附件';
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

  const sessionChanged = applySessionStatusFromMessage(sessionId, renderedMessage, messages);
  if (sessionChanged) renderSessions();

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
  const sessionChanged = applySessionStatusFromMessage(sessionId, updatedMessage, messages);
  if (sessionChanged) renderSessions();
  if (sessionId === state.activeId) {
    if (sessionChanged) renderActive({ messages: false });
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
  recordFrontendEvent('sessions.refresh_start', options.messages === false ? 'without_messages' : 'with_messages');
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
    recordFrontendEvent('sessions.refresh_ok', `count:${state.sessions.length}`);
  } catch (error) {
    recordFrontendEvent('sessions.refresh_failed', error.message || 'failed', 'warn');
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
  recordFrontendEvent('session.load_start', `${id} full:${options.full === true}`);
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
      recordFrontendEvent('session.load_cache_hit', id);
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
    recordFrontendEvent('session.load_ok', `${id} messages:${trimmed.length}`);
  } catch (error) {
    recordFrontendEvent('session.load_failed', error.message || 'failed', 'warn');
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
  if (!session?.id || !state.online || state.contextRefreshInFlight) {
    if (state.contextRefreshInFlight) recordFrontendEvent('context.refresh_skip', 'in_flight');
    return;
  }
  const refreshStartedAt = performance.now();
  state.contextRefreshInFlight = true;
  recordFrontendEvent('context.refresh_start', session.id);
  mirrorConnectionState(connectionState.markContextRefresh());
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
    const changed = nextMessages.length > 0 && (currentMessages.length !== mergedMessages.length
      || currentLast?.at !== nextLast?.at
      || currentLast?.text !== nextLast?.text);
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
    recordFrontendEvent('context.refresh_ok', `messages:${nextMessages.length} changed:${changed} session:${sessionChanged}`);
  } catch (error) {
    recordFrontendEvent('context.refresh_failed', error.message || 'failed', 'warn');
    // Keep the current cached view; the normal online handler will retry later.
  } finally {
    performanceMetrics.record('context_refresh', performance.now() - refreshStartedAt);
    state.contextRefreshInFlight = false;
  }
}

function startContextRefreshLoop() {
  clearInterval(state.contextRefreshTimer);
  const session = getActiveSession();
  if (!session?.id) return;
  state.contextRefreshTimer = setInterval(refreshActiveContext, 5000);
}

function connectEvents(id) {
  if (state.eventSource) state.eventSource.close();
  if (!id || !navigator.onLine) {
    mirrorConnectionState(connectionState.setEventStatus('closed'));
    recordFrontendEvent('sse.closed', id || 'no-session');
    return;
  }

  const after = state.lastSeq.get(id) || 0;
  const source = new EventSource(`/api/events?sessionId=${encodeURIComponent(id)}&after=${after}`);
  state.eventSource = source;
  mirrorConnectionState(connectionState.setEventStatus('connecting'));
  recordFrontendEvent('sse.connect', `${id} after:${after}`);

  source.addEventListener('hello', (event) => {
    mirrorConnectionState(connectionState.setOnline(true));
    mirrorConnectionState(connectionState.markEvent('open'));
    let sessionChanged = false;
    const data = parseEventData(event, {});
    sessionChanged = data?.session ? mergeSessionSnapshot(data.session) : false;
    recordFrontendEvent('sse.hello', `session:${sessionChanged}`);
    if (sessionChanged) renderSessions();
    renderActive({ messages: false });
  });

  source.addEventListener('message', (event) => {
    mirrorConnectionState(connectionState.markEvent('open'));
    const message = parseEventData(event);
    recordFrontendEvent('sse.message', message?.seq || message?.id || 'unknown');
    if (message) upsertMessage(id, message);
  });

  source.addEventListener('message_update', (event) => {
    mirrorConnectionState(connectionState.markEvent('open'));
    const message = parseEventData(event);
    recordFrontendEvent('sse.message_update', message?.seq || message?.id || 'unknown');
    if (message) updateMessage(id, message);
  });

  source.addEventListener('session', (event) => {
    mirrorConnectionState(connectionState.markEvent('open'));
    const session = parseEventData(event);
    if (!session) return;
    const changed = mergeSessionSnapshot(session);
    recordFrontendEvent('sse.session', `${session.id || id} changed:${changed} status:${session.status || '-'}`);
    if (changed) renderSessions();
    if (session.id === state.activeId) renderActive({ messages: false });
  });

  source.onerror = () => {
    source.close();
    if (state.eventSource === source) state.eventSource = null;
    mirrorConnectionState(connectionState.setEventStatus('reconnecting'));
    recordFrontendEvent('sse.error', id, 'warn');
    setBadge('重连中', 'busy');
    refreshActiveContext().catch(() => {});
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
  el.favoritesButton.setAttribute('aria-checked', String(state.showStarredOnly));
  el.favoritesButton.setAttribute('aria-label', state.showStarredOnly ? '显示全部消息' : '只看收藏');
  el.favoritesButton.title = state.showStarredOnly ? '显示全部消息' : '只看收藏';
  el.favoritesButton.textContent = state.showStarredOnly ? '已筛选收藏' : '只看收藏';
}

el.promptForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  await promptActions.sendPrompt(el.promptInput.value);
});

el.promptInput.addEventListener('keydown', (event) => {
  const startedAt = performance.now();
  requestAnimationFrame(() => {
    performanceMetrics.record('prompt_input_frame', performance.now() - startedAt);
  });
  if (event.isComposing || event.key !== 'Enter') return;
  autoSizePrompt();
});

document.addEventListener('click', () => {
  messageView.closeMessageMenus();
  closeTopMoreMenu();
  closeAttachmentMenu();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') messageView.closeMessageMenus();
  if (event.key === 'Escape') closeTopMoreMenu();
  if (event.key === 'Escape') closeAttachmentMenu();
  if (event.key === 'Escape' && !el.sessionActionSheet?.hidden) closeSessionActionSheet();
  if (event.key === 'Escape' && !el.imageViewer.hidden) closeImageViewer();
});

el.stopButton.addEventListener('click', stopCurrentRun);

el.topMoreButton.addEventListener('click', (event) => {
  event.stopPropagation();
  setTopMoreMenu(el.topMoreMenu.hidden);
});

el.topMoreMenu.addEventListener('click', (event) => {
  event.stopPropagation();
});

el.favoritesButton.addEventListener('click', () => {
  state.showStarredOnly = !state.showStarredOnly;
  storageSet('cmc.showStarredOnly', state.showStarredOnly ? '1' : '0');
  closeTopMoreMenu();
  renderActive();
});

el.installAppButton?.addEventListener('click', installAppToHomeScreen);
el.installAppSettingsButton?.addEventListener('click', installAppToHomeScreen);

el.attachmentButton.addEventListener('click', (event) => {
  event.stopPropagation();
  closeTopMoreMenu();
  setAttachmentMenu(el.attachmentMenu.hidden);
});

el.attachmentMenu.addEventListener('click', (event) => {
  event.stopPropagation();
});

el.imageButton.addEventListener('click', () => {
  closeAttachmentMenu();
  el.imageInput.click();
});

el.fileButton.addEventListener('click', () => {
  closeAttachmentMenu();
  el.fileInput.click();
});

el.imageInput.addEventListener('change', () => addImageFiles(el.imageInput.files || []));
el.fileInput.addEventListener('change', () => addImageFiles(el.fileInput.files || []));

el.promptInput.addEventListener('paste', (event) => {
  const files = [...(event.clipboardData?.files || [])];
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
el.runtimeButton.addEventListener('click', () => {
  closeTopMoreMenu();
  openRuntimeDialog();
});
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
  if (state.promptAutoSizeFrame) return;
  const requestedAt = performance.now();
  state.promptAutoSizeFrame = requestAnimationFrame(() => {
    const startedAt = performance.now();
    state.promptAutoSizeFrame = 0;
    el.promptInput.style.height = 'auto';
    const maxHeight = Math.min(Math.round(window.innerHeight * 0.28), 180);
    el.promptInput.style.height = `${Math.min(el.promptInput.scrollHeight, maxHeight)}px`;
    performanceMetrics.record('prompt_autosize', performance.now() - startedAt, {
      queuedMs: startedAt - requestedAt
    });
  });
}

el.promptInput.addEventListener('input', autoSizePrompt);

el.messagePane.addEventListener('scroll', () => {
  if (state.suppressScrollTracking) return;
  unlockInitialBottom();
  if (state.renderingMessages) state.userScrolledDuringRender = true;
}, { passive: true });

window.addEventListener('online', () => {
  recordFrontendEvent('page.online');
  mirrorConnectionState(connectionState.setOnline(true));
  refreshSessions({ messages: false }).catch(() => {});
  if (state.activeId) connectEvents(state.activeId);
  startContextRefreshLoop();
});

window.addEventListener('offline', () => {
  recordFrontendEvent('page.offline', '', 'warn');
  mirrorConnectionState(connectionState.setOnline(false));
  mirrorConnectionState(connectionState.setEventStatus('closed'));
  if (state.eventSource) state.eventSource.close();
  clearInterval(state.contextRefreshTimer);
  renderActive({ messages: false });
});

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  state.installPromptEvent = event;
  state.installStatus = '可以直接安装为桌面应用。';
  recordFrontendEvent('pwa.install_ready');
  updateInstallUi();
});

window.addEventListener('appinstalled', () => {
  state.installPromptEvent = null;
  state.installStatus = '已安装到桌面。';
  recordFrontendEvent('pwa.installed');
  updateInstallUi();
});

document.addEventListener('visibilitychange', () => {
  clearTimeout(state.foregroundRefreshTimer);
  if (document.hidden) {
    recordFrontendEvent('page.hidden');
    messageScheduler.flushSaves();
    return;
  }
  if (!document.hidden) {
    recordFrontendEvent('page.visible');
    state.foregroundRefreshTimer = setTimeout(() => {
      refreshActiveContext();
    }, 600);
  }
});

window.addEventListener('pagehide', () => messageScheduler.flushSaves());

function startPerformanceObservers() {
  if (!('PerformanceObserver' in window)) return;
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        performanceMetrics.record('longtask', entry.duration, { name: entry.name || 'longtask' });
      }
    });
    observer.observe({ entryTypes: ['longtask'] });
  } catch {
    // Browser support differs; runtime panel still shows the metrics we can collect.
  }
}

function registerServiceWorkerLater() {
  if (!('serviceWorker' in navigator)) return;
  scheduleIdle(() => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }, 3000);
}

async function boot() {
  updateInstallUi();
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

startPerformanceObservers();
boot();
