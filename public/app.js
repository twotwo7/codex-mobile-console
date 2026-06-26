import { createMessageScheduler } from './message-scheduler.js?v=2';
import { cancelIdle, scheduleIdle, storageGet, storageJsonGet, storageJsonSet, storageSet } from './browser-utils.js?v=1';
import { createConnectionState } from './connection-state.js?v=1';
import { escapeHtml, formatBytes, formatDuration, formatNumber, formatTime, summarizeText } from './format-utils.js?v=1';
import { createFrontendEvents } from './frontend-events.js?v=1';
import { compareMessages, findMessageIndex, lastRealSeq, mergeMessagePair, mergeMessages } from './message-utils.js?v=2';
import { createMessageView } from './message-view.js?v=17';
import { createPerformanceMetrics } from './performance-metrics.js?v=1';
import { createPromptActions } from './prompt-actions.js?v=9';
import { createQueueView } from './queue-view.js?v=6';
import { createSessionStateController } from './session-state.js?v=8';
import { createSkillView } from './skill-view.js?v=3';
import { createTopbarView } from './topbar-view.js?v=7';

const storedExpandedCwds = (() => {
  const value = storageJsonGet('cmc.expandedCwds', []);
  return Array.isArray(value) ? value : [];
})();

const state = {
  sessions: [],
  activeId: storageGet('cmc.activeId'),
  sessionViewMode: storageGet('cmc.sessionViewMode', 'recent') === 'flat' ? 'recent' : storageGet('cmc.sessionViewMode', 'recent'),
  theme: storageGet('cmc.theme', 'graphite'),
  autoFollowBottom: storageGet('cmc.autoFollowBottom', '1') === '1',
  elevated: storageGet('cmc.elevated') === '1',
  defaultRunConfig: storageJsonGet('cmc.defaultRunConfig', {}),
  showStarredOnly: storageGet('cmc.showStarredOnly') === '1',
  messageDisplayMode: storageGet('cmc.messageDisplayMode', 'full') === 'brief' ? 'brief' : 'full',
  siteMountStripCollapsed: storageGet('cmc.siteMountStripCollapsed', '1') !== '0',
  pendingImages: [],
  pendingFiles: [],
  sending: false,
  directoryPath: '/root/Projects',
  expandedCwds: new Set(storedExpandedCwds),
  expandedTags: new Set(storageJsonGet('cmc.expandedTags', [])),
  messages: new Map(),
  messagePages: new Map(),
  messageRenderLimits: new Map(),
  briefRoundLimits: new Map(),
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
  installStatus: '',
  shareMode: false,
  shareSelectedKeys: new Set(),
  shareImageBlob: null,
  shareImageUrl: ''
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
const APP_ASSET_VERSION = '172';
const SW_CACHE_VERSION = 'codex-console-v189';

const DEFAULT_RUN_CONFIG = {
  model: '',
  profile: '',
  sandbox: 'workspace-write',
  approval: 'on-request',
  reasoningEffort: '',
  addDirs: [],
  configOverrides: [],
  strictConfig: false,
  ignoreUserConfig: false,
  ignoreRules: false
};

const MODEL_OPTIONS = new Set(['', 'gpt-5.5', 'gpt-5.4', 'gpt-5.1', 'gpt-5.1-codex', 'gpt-4.1']);

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
  taskDetailDialog: document.querySelector('#taskDetailDialog'),
  closeTaskDetailDialog: document.querySelector('#closeTaskDetailDialog'),
  taskDetailBody: document.querySelector('#taskDetailBody'),
  newSessionButton: document.querySelector('#newSessionButton'),
  smartTagSessionsButton: document.querySelector('#smartTagSessionsButton'),
  skillManagerButton: document.querySelector('#skillManagerButton'),
  logoutButton: document.querySelector('#logoutButton'),
  topbar: document.querySelector('.topbar'),
  activeTitle: document.querySelector('#activeTitle'),
  activeMeta: document.querySelector('#activeMeta'),
  connectionBadge: document.querySelector('#connectionBadge'),
  emptyState: document.querySelector('#emptyState'),
  siteMountStrip: document.querySelector('#siteMountStrip'),
  messagePane: document.querySelector('#messagePane'),
  promptForm: document.querySelector('#promptForm'),
  promptInput: document.querySelector('#promptInput'),
  commandButton: document.querySelector('#commandButton'),
  topMoreButton: document.querySelector('#topMoreButton'),
  topMoreMenu: document.querySelector('#topMoreMenu'),
  sessionConfigButton: document.querySelector('#sessionConfigButton'),
  siteRegisterButton: document.querySelector('#siteRegisterButton'),
  siteRegisterDialog: document.querySelector('#siteRegisterDialog'),
  closeSiteRegisterDialog: document.querySelector('#closeSiteRegisterDialog'),
  sendLocalSitePrompt: document.querySelector('#sendLocalSitePrompt'),
  sendExternalSitePrompt: document.querySelector('#sendExternalSitePrompt'),
  topFilterButton: document.querySelector('#topFilterButton'),
  topFilterMenu: document.querySelector('#topFilterMenu'),
  favoritesButton: document.querySelector('#favoritesButton'),
  messageDisplayButton: document.querySelector('#messageDisplayButton'),
  shareCaptureButton: document.querySelector('#shareCaptureButton'),
  collapseMessagesButton: document.querySelector('#collapseMessagesButton'),
  expandMessagesButton: document.querySelector('#expandMessagesButton'),
  runtimeButton: document.querySelector('#runtimeButton'),
  attachmentButton: document.querySelector('#attachmentButton'),
  attachmentMenu: document.querySelector('#attachmentMenu'),
  imageButton: document.querySelector('#imageButton'),
  imageInput: document.querySelector('#imageInput'),
  fileButton: document.querySelector('#fileButton'),
  fileInput: document.querySelector('#fileInput'),
  imagePreviewStrip: document.querySelector('#imagePreviewStrip'),
  elevatedRun: document.querySelector('#elevatedRun'),
  defaultModelSelect: document.querySelector('#defaultModelSelect'),
  defaultModelCustomInput: document.querySelector('#defaultModelCustomInput'),
  defaultProfileInput: document.querySelector('#defaultProfileInput'),
  defaultSandboxSelect: document.querySelector('#defaultSandboxSelect'),
  defaultApprovalSelect: document.querySelector('#defaultApprovalSelect'),
  defaultReasoningEffortSelect: document.querySelector('#defaultReasoningEffortSelect'),
  defaultAddDirsInput: document.querySelector('#defaultAddDirsInput'),
  defaultConfigOverridesInput: document.querySelector('#defaultConfigOverridesInput'),
  defaultStrictConfigToggle: document.querySelector('#defaultStrictConfigToggle'),
  defaultIgnoreUserConfigToggle: document.querySelector('#defaultIgnoreUserConfigToggle'),
  defaultIgnoreRulesToggle: document.querySelector('#defaultIgnoreRulesToggle'),
  refreshCodexConfigButton: document.querySelector('#refreshCodexConfigButton'),
  codexConfigSummary: document.querySelector('#codexConfigSummary'),
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
  refreshHealthButton: document.querySelector('#refreshHealthButton'),
  systemHealthPanel: document.querySelector('#systemHealthPanel'),
  checkAppUpdateButton: document.querySelector('#checkAppUpdateButton'),
  appUpdatePanel: document.querySelector('#appUpdatePanel'),
  updateAppButton: document.querySelector('#updateAppButton'),
  rollbackAppButton: document.querySelector('#rollbackAppButton'),
  checkCodexUpgradeButton: document.querySelector('#checkCodexUpgradeButton'),
  codexUpgradePanel: document.querySelector('#codexUpgradePanel'),
  upgradeCodexButton: document.querySelector('#upgradeCodexButton'),
  refreshTagsButton: document.querySelector('#refreshTagsButton'),
  undoSmartTagsButton: document.querySelector('#undoSmartTagsButton'),
  tagManagementPanel: document.querySelector('#tagManagementPanel'),
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
  sessionConfigDialog: document.querySelector('#sessionConfigDialog'),
  sessionConfigForm: document.querySelector('#sessionConfigForm'),
  cancelSessionConfig: document.querySelector('#cancelSessionConfig'),
  sessionConfigState: document.querySelector('#sessionConfigState'),
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
  imageViewerImg: document.querySelector('#imageViewerImg'),
  sharePreviewDialog: document.querySelector('#sharePreviewDialog'),
  closeSharePreview: document.querySelector('#closeSharePreview'),
  sharePreviewBody: document.querySelector('#sharePreviewBody'),
  sharePreviewState: document.querySelector('#sharePreviewState'),
  copyShareImage: document.querySelector('#copyShareImage'),
  downloadShareImage: document.querySelector('#downloadShareImage')
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
  getShareKey,
  isShareMode: () => state.shareMode,
  isShareSelected: (message) => state.shareSelectedKeys.has(getShareKey(message)),
  openImageViewer,
  retryMessage: promptActions.retryMessage,
  setMessageCollapsed,
  toggleShareSelected,
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
state.defaultRunConfig = normalizeRunConfig(state.defaultRunConfig);
applyDefaultRunConfigToSettings();
syncSessionViewControls();
updateMessageDisplayButton();
updateCollapseActionButtons();
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

function setAllConversationMessagesCollapsed(collapsed) {
  const sessionId = state.activeId;
  if (!sessionId) return;
  const states = {
    ...(loadMessageCollapseStates(sessionId) || {})
  };
  for (const message of loadMessages(sessionId)) {
    const key = messageCollapseId(message);
    if (!key) continue;
    if (message.role === 'tool') {
      states[key] = true;
      continue;
    }
    if (['user', 'assistant'].includes(message.role || '')) {
      states[key] = collapsed === true;
    }
  }
  state.messageCollapseStates.set(sessionId, states);
  storageJsonSet(collapseStateKey(sessionId), states);
  closeTopFilterMenu();
  renderActive({
    stickToBottom: false,
    restoreAnchor: firstVisibleMessageAnchor()
  });
}

function loadMessageCollapseStates(sessionId = state.activeId || 'global') {
  if (state.messageCollapseStates.has(sessionId)) return state.messageCollapseStates.get(sessionId);
  const states = storageJsonGet(collapseStateKey(sessionId), {});
  const safeStates = states && typeof states === 'object' ? states : {};
  state.messageCollapseStates.set(sessionId, safeStates);
  return safeStates;
}

function lineList(value) {
  const items = Array.isArray(value) ? value : String(value || '').split(/\r?\n/);
  return items.map((item) => String(item || '').trim()).filter(Boolean);
}

function normalizeRunConfig(value = {}) {
  return {
    ...DEFAULT_RUN_CONFIG,
    model: String(value.model || '').trim(),
    profile: String(value.profile || '').trim(),
    sandbox: ['read-only', 'workspace-write', 'danger-full-access'].includes(value.sandbox) ? value.sandbox : DEFAULT_RUN_CONFIG.sandbox,
    approval: ['untrusted', 'on-request', 'on-failure', 'never'].includes(value.approval) ? value.approval : DEFAULT_RUN_CONFIG.approval,
    reasoningEffort: ['', 'minimal', 'low', 'medium', 'high'].includes(value.reasoningEffort) ? value.reasoningEffort : '',
    addDirs: lineList(value.addDirs),
    configOverrides: lineList(value.configOverrides),
    strictConfig: value.strictConfig === true,
    ignoreUserConfig: value.ignoreUserConfig === true,
    ignoreRules: value.ignoreRules === true
  };
}

function setModelControl(select, customInput, value = '') {
  const model = String(value || '').trim();
  if (!select) return;
  if (MODEL_OPTIONS.has(model)) {
    select.value = model;
    if (customInput) customInput.value = '';
  } else {
    select.value = 'custom';
    if (customInput) customInput.value = model;
  }
  syncModelCustomInput(select, customInput);
}

function readModelControl(select, customInput) {
  if (!select) return '';
  if (select.value === 'custom') return String(customInput?.value || '').trim();
  return String(select.value || '').trim();
}

function syncModelCustomInput(select, customInput) {
  if (!customInput) return;
  const custom = select?.value === 'custom';
  customInput.hidden = !custom;
  customInput.disabled = !custom;
  customInput.required = custom;
}

function bindModelControl(select, customInput, onChange) {
  if (!select) return;
  const handler = () => {
    syncModelCustomInput(select, customInput);
    if (onChange) onChange();
  };
  select.addEventListener('change', handler);
  customInput?.addEventListener('input', () => {
    if (onChange) onChange();
  });
  syncModelCustomInput(select, customInput);
}

function runConfigFromForm(form) {
  const data = new FormData(form);
  return normalizeRunConfig({
    model: readModelControl(form.elements.model, form.elements.modelCustom),
    profile: data.get('profile'),
    sandbox: data.get('sandbox'),
    approval: data.get('approval'),
    reasoningEffort: data.get('reasoningEffort'),
    addDirs: data.get('addDirs'),
    configOverrides: data.get('configOverrides'),
    strictConfig: data.get('strictConfig') === 'on',
    ignoreUserConfig: data.get('ignoreUserConfig') === 'on',
    ignoreRules: data.get('ignoreRules') === 'on'
  });
}

function applyRunConfigToForm(form, config = {}) {
  const value = normalizeRunConfig(config);
  if (!form) return;
  setModelControl(form.elements.model, form.elements.modelCustom, value.model);
  if (form.elements.profile) form.elements.profile.value = value.profile;
  if (form.elements.sandbox) form.elements.sandbox.value = value.sandbox;
  if (form.elements.approval) form.elements.approval.value = value.approval;
  if (form.elements.reasoningEffort) form.elements.reasoningEffort.value = value.reasoningEffort;
  if (form.elements.addDirs) form.elements.addDirs.value = value.addDirs.join('\n');
  if (form.elements.configOverrides) form.elements.configOverrides.value = value.configOverrides.join('\n');
  if (form.elements.strictConfig) form.elements.strictConfig.checked = value.strictConfig;
  if (form.elements.ignoreUserConfig) form.elements.ignoreUserConfig.checked = value.ignoreUserConfig;
  if (form.elements.ignoreRules) form.elements.ignoreRules.checked = value.ignoreRules;
}

function applyDefaultRunConfigToSettings() {
  const value = normalizeRunConfig(state.defaultRunConfig);
  setModelControl(el.defaultModelSelect, el.defaultModelCustomInput, value.model);
  if (el.defaultProfileInput) el.defaultProfileInput.value = value.profile;
  if (el.defaultSandboxSelect) el.defaultSandboxSelect.value = value.sandbox;
  if (el.defaultApprovalSelect) el.defaultApprovalSelect.value = value.approval;
  if (el.defaultReasoningEffortSelect) el.defaultReasoningEffortSelect.value = value.reasoningEffort;
  if (el.defaultAddDirsInput) el.defaultAddDirsInput.value = value.addDirs.join('\n');
  if (el.defaultConfigOverridesInput) el.defaultConfigOverridesInput.value = value.configOverrides.join('\n');
  if (el.defaultStrictConfigToggle) el.defaultStrictConfigToggle.checked = value.strictConfig;
  if (el.defaultIgnoreUserConfigToggle) el.defaultIgnoreUserConfigToggle.checked = value.ignoreUserConfig;
  if (el.defaultIgnoreRulesToggle) el.defaultIgnoreRulesToggle.checked = value.ignoreRules;
}

function readDefaultRunConfigFromSettings() {
  return normalizeRunConfig({
    model: readModelControl(el.defaultModelSelect, el.defaultModelCustomInput),
    profile: el.defaultProfileInput?.value,
    sandbox: el.defaultSandboxSelect?.value,
    approval: el.defaultApprovalSelect?.value,
    reasoningEffort: el.defaultReasoningEffortSelect?.value,
    addDirs: el.defaultAddDirsInput?.value,
    configOverrides: el.defaultConfigOverridesInput?.value,
    strictConfig: el.defaultStrictConfigToggle?.checked,
    ignoreUserConfig: el.defaultIgnoreUserConfigToggle?.checked,
    ignoreRules: el.defaultIgnoreRulesToggle?.checked
  });
}

function saveDefaultRunConfig() {
  state.defaultRunConfig = readDefaultRunConfigFromSettings();
  storageJsonSet('cmc.defaultRunConfig', state.defaultRunConfig);
  updateRunSettingsState();
}

function saveSessionCache() {
  storageJsonSet('cmc.sessions', state.sessions);
}

function saveExpandedCwds() {
  storageJsonSet('cmc.expandedCwds', [...state.expandedCwds]);
}

function saveExpandedTags() {
  storageJsonSet('cmc.expandedTags', [...state.expandedTags]);
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

function defaultBriefRoundLimit() {
  return isMobileViewport() ? 5 : 8;
}

function sessionRenderedMessageLimit(sessionId = state.activeId) {
  return Math.min(maxHistoryLimit(), Math.max(renderedMessageLimit(), Number(state.messageRenderLimits.get(sessionId) || 0)));
}

function expandRenderedMessageLimit(sessionId, count) {
  if (!sessionId || !Number.isFinite(count) || count <= 0) return;
  const current = sessionRenderedMessageLimit(sessionId);
  state.messageRenderLimits.set(sessionId, Math.min(maxHistoryLimit(), current + count));
}

function sessionBriefRoundLimit(sessionId = state.activeId) {
  return Math.max(defaultBriefRoundLimit(), Number(state.briefRoundLimits.get(sessionId) || 0));
}

function expandBriefRoundLimit(sessionId, count = 1) {
  if (!sessionId || !Number.isFinite(count) || count <= 0) return;
  const current = sessionBriefRoundLimit(sessionId);
  state.briefRoundLimits.set(sessionId, current + count);
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
    next.sessionUpdatedAt = page.session.activityAt || page.session.updatedAt || '';
    next.lastSeq = page.session.lastSeq || 0;
  } else {
    next.sessionUpdatedAt = current.sessionUpdatedAt || '';
    next.lastSeq = current.lastSeq || 0;
  }
  state.messagePages.set(sessionId, next);
  storageJsonSet(pageCacheKey(sessionId), next);
}

function isMessageCacheFresh(sessionId, session) {
  if (!(session?.activityAt || session?.updatedAt)) return false;
  const page = loadMessagePage(sessionId);
  const messages = state.messages.get(sessionId) || [];
  return Boolean(messages.length)
    && Boolean(page?.beforeSeq || messages.some((message) => message.orderSeq))
    && page?.sessionUpdatedAt === (session.activityAt || session.updatedAt)
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
    state.messageRenderLimits.delete(id);
    state.briefRoundLimits.delete(id);
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
  if (previous !== state.activeId) {
    state.shareMode = false;
    state.shareSelectedKeys.clear();
    recordFrontendEvent('session.switch', state.activeId || 'none');
  }
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
  for (const button of [el.installAppSettingsButton]) {
    if (!button) continue;
    button.disabled = standalone;
    button.textContent = standalone ? '已安装' : canPrompt ? '安装到桌面' : '查看方法';
  }
}

async function installAppToHomeScreen() {
  closeTopMenus();
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
  if (mode === 'flat') mode = 'recent';
  if (!['recent', 'tag', 'cwd', 'trash'].includes(mode)) return;
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
    .sort((a, b) => String(b.activityAt || b.updatedAt || '').localeCompare(String(a.activityAt || a.updatedAt || '')));
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

  if (state.sessionViewMode === 'tag') {
    const groups = new Map();
    for (const session of visible) {
      const tags = Array.isArray(session.tags) && session.tags.length ? session.tags : ['未分类'];
      for (const tag of tags) {
        if (!groups.has(tag)) groups.set(tag, []);
        groups.get(tag).push(session);
      }
    }
    const sortedGroups = [...groups.entries()].sort((a, b) => {
      if (a[0] === '未分类') return 1;
      if (b[0] === '未分类') return -1;
      return b[1].length - a[1].length || a[0].localeCompare(b[0]);
    });
    for (const [tag, group] of sortedGroups) {
      const section = document.createElement('section');
      section.className = 'session-group tag-group';
      const expanded = state.expandedTags.has(tag);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'session-group-toggle';
      button.setAttribute('aria-expanded', String(expanded));
      button.innerHTML = `
        <span>#${escapeHtml(tag)}</span>
        <strong>${expanded ? '收起' : '展开'} · ${group.length}</strong>
      `;
      button.addEventListener('click', () => {
        if (state.expandedTags.has(tag)) state.expandedTags.delete(tag);
        else state.expandedTags.add(tag);
        saveExpandedTags();
        renderSessions();
      });
      section.append(button);
      if (expanded) {
        const seen = new Set();
        for (const session of group) {
          if (seen.has(session.id)) continue;
          seen.add(session.id);
          section.append(renderSessionButton(session));
        }
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
  if ((session.statusSummary?.status || session.status) === 'error') return 'error';
  if (session.source === 'codex') return 'external';
  return 'idle';
}

function sessionStatusLabel(session) {
  if (session.trashedAt) return '回收站';
  if (session.statusSummary?.label) return session.statusSummary.label;
  if (isSessionRunning(session)) return session.status === 'stopping' ? '停止中' : '运行中';
  if (session.source === 'codex') return '全局 Codex';
  return session.status || 'idle';
}

function formatSessionCwd(cwd = '') {
  return cwd.replace(/^\/root\/Projects\/?/, '~/Projects/');
}

function sessionTagsHtml(session) {
  const tags = Array.isArray(session.tags) ? session.tags.slice(0, 3) : [];
  if (!tags.length) return '';
  return `<span class="session-tags">${tags.map((tag) => `<em>#${escapeHtml(tag)}</em>`).join('')}</span>`;
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
    appendSessionActionButton('任务详情', () => openTaskDetailDialog(session));
    appendSessionActionButton('重命名', () => renameSession(session));
    appendSessionActionButton('编辑标签', () => editSessionTags(session));
    if (session.source !== 'codex') appendSessionActionButton('配置', () => openSessionConfigDialog(session));
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
      <time>${escapeHtml(formatTime(session.trashedAt || session.activityAt || session.updatedAt))}</time>
    </span>
    <span class="session-meta-row">${escapeHtml(sessionStatusLabel(session))} · ${escapeHtml(formatSessionCwd(session.cwd || ''))}</span>
    ${sessionTagsHtml(session)}
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
  renderSiteMountStrip(session);
  updateMessageDisplayButton();
  updateCollapseActionButtons();
}

function renderSiteMountStrip(session = getActiveSession()) {
  if (!el.siteMountStrip) return;
  const mounts = Array.isArray(session?.siteMounts) ? session.siteMounts : [];
  if (el.topbar) el.siteMountStrip.style.setProperty('--topbar-height', `${el.topbar.offsetHeight}px`);
  el.siteMountStrip.hidden = mounts.length === 0;
  el.siteMountStrip.textContent = '';
  el.siteMountStrip.classList.toggle('collapsed', state.siteMountStripCollapsed);
  if (!mounts.length) return;

  const toggle = document.createElement('button');
  toggle.className = 'site-mount-toggle';
  toggle.type = 'button';
  toggle.textContent = state.siteMountStripCollapsed ? `站点 ${mounts.length}` : '收起站点';
  toggle.setAttribute('aria-expanded', String(!state.siteMountStripCollapsed));
  toggle.title = state.siteMountStripCollapsed ? '展开子站点导航' : '收起子站点导航';
  toggle.addEventListener('click', () => {
    state.siteMountStripCollapsed = !state.siteMountStripCollapsed;
    storageSet('cmc.siteMountStripCollapsed', state.siteMountStripCollapsed ? '1' : '0');
    renderSiteMountStrip(session);
  });
  el.siteMountStrip.append(toggle);
  if (state.siteMountStripCollapsed) return;

  for (const mount of mounts) {
    const link = document.createElement('a');
    link.className = 'site-mount-link';
    link.href = mount.url || `/sites/${mount.slug}/`;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = mount.title || mount.slug || '站点';
    link.title = link.href;
    el.siteMountStrip.append(link);
  }
}

const SITE_REGISTER_PROMPTS = {
  local: [
    '请为当前会话创建并注册一个可预览的完整 Web 服务。',
    '',
    '要求：',
    '1. 不要只生成静态目录；请创建或整理成一个能持续运行的本地 Web 服务。',
    '2. 服务必须监听 127.0.0.1 的空闲端口，不要直接监听公网地址。',
    '3. 如果项目已有启动方式，请优先使用项目自己的 npm/pnpm/python/go 等启动脚本；没有则补齐最小可运行服务。',
    '4. 页面需要能在反向代理子路径下工作：优先使用相对资源路径，或读取 X-Forwarded-Prefix；不要把资源硬编码到 /assets、/static 等根路径。',
    '5. 启动后请确认本机 http://127.0.0.1:<port>/ 可以访问。',
    '6. 找到可访问地址后，请在回复末尾输出下面这个精确格式，控制台会自动注册成 codex.ai.hehao.pro 的 /sites/<auto-slug>/ 子路径转发：',
    '<codex-site-services>',
    '[{"title":"站点名称","url":"http://127.0.0.1:3000/"}]',
    '</codex-site-services>',
    '7. 如果无法启动服务，请简短说明失败原因和缺少什么。'
  ].join('\n'),
  external: [
    '请把当前会话相关的已有 Web 访问地址注册到本会话的子站点导航页。',
    '',
    '要求：',
    '1. 从当前项目配置、部署文档、Caddy/nginx 配置、README、package scripts 或最近上下文中查找已经存在的 http/https 访问地址。',
    '2. 不要编造地址；只注册你能确认的已有域名或访问地址。',
    '3. 找到后，请在回复末尾输出下面这个精确格式，控制台会自动识别并注册：',
    '<codex-site-links>',
    '[{"title":"站点名称","url":"https://example.com/"}]',
    '</codex-site-links>',
    '4. 如果有多个地址，把它们都放进 JSON 数组；如果没有找到，请说明没有找到。'
  ].join('\n')
};

function openSiteRegisterDialog() {
  if (!state.activeId || !el.siteRegisterDialog) return;
  closeTopMenus();
  el.siteRegisterDialog.showModal();
}

function closeSiteRegisterDialog() {
  if (el.siteRegisterDialog?.open) el.siteRegisterDialog.close();
}

async function sendSiteRegisterPrompt(kind) {
  const prompt = SITE_REGISTER_PROMPTS[kind];
  if (!prompt || !state.activeId) return;
  closeSiteRegisterDialog();
  await promptActions.sendPrompt(prompt);
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
    updateShareBar();
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
  updateShareBar();
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
  let changed = sessionState.mergeSessionSnapshot(nextSession);
  if (nextSession?.view) changed = mergeSessionView(nextSession.view, nextSession.id) || changed;
  return changed;
}

function mergeSessionView(view, fallbackId = '') {
  if (!view?.session?.id && !fallbackId) return false;
  return sessionState.mergeSessionSnapshot({
    ...(view.session || {}),
    id: view.session?.id || fallbackId,
    statusSummary: view.statusSummary,
    activeRun: view.activeRun,
    lastRun: view.lastRun,
    contextHealth: view.contextHealth,
    runCounts: view.session?.runCounts,
    queuedCount: view.queueSummary?.count ?? view.session?.queuedCount,
    recentAudit: view.recentAudit,
    taskDetail: view.taskDetail
  });
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
      updateShareBar();
      restoreScroll(true);
      performanceMetrics.record('messages_render', performance.now() - renderStartedAt, { count: messages.length });
      if (renderJobId === state.renderJobId) state.renderingMessages = false;
      messageScheduler.flushRender();
    }
  };
  renderChunk();
}

function getShareKey(message) {
  if (!message) return '';
  if (message.id) return `id:${message.id}`;
  if (message.clientMessageId) return `client:${message.clientMessageId}`;
  if (message.seq) return `seq:${message.seq}`;
  return `${message.role || ''}:${message.at || ''}:${String(message.text || '').slice(0, 80)}`;
}

function shareableMessages(sessionId = state.activeId) {
  return displayMessages(sessionId).filter((message) => ['user', 'assistant', 'system'].includes(message.role || '') && !message.variant);
}

function allShareableMessages(sessionId = state.activeId) {
  return loadMessages(sessionId)
    .filter((message) => ['user', 'assistant', 'system'].includes(message.role || '') && !message.variant)
    .sort(compareMessages);
}

function selectedShareMessages() {
  const selected = new Set(state.shareSelectedKeys);
  return allShareableMessages().filter((message) => selected.has(getShareKey(message)));
}

function setShareMode(enabled) {
  state.shareMode = Boolean(enabled);
  if (!state.shareMode) state.shareSelectedKeys.clear();
  messageView.closeMessageMenus();
  closeTopMenus();
  renderActive();
}

function toggleShareSelected(message, options = {}) {
  const key = getShareKey(message);
  if (!key) return;
  if (options.enterShareMode) state.shareMode = true;
  const selected = options.selected ?? !state.shareSelectedKeys.has(key);
  if (selected) state.shareSelectedKeys.add(key);
  else state.shareSelectedKeys.delete(key);
  renderActive({ stickToBottom: false });
}

function selectRecentShareMessages(count = 6) {
  state.shareSelectedKeys.clear();
  for (const message of allShareableMessages().slice(-count)) {
    state.shareSelectedKeys.add(getShareKey(message));
  }
  renderActive({ stickToBottom: false });
}

function updateShareBar() {
  el.shareBar?.remove();
  el.shareBar = null;
  if (!state.shareMode || !state.activeId || !el.promptForm) return;
  const bar = document.createElement('div');
  bar.className = 'share-bar';
  const count = state.shareSelectedKeys.size;
  bar.innerHTML = `
    <span>已选 ${count} 条</span>
    <button type="button" data-share-action="recent">最近6条</button>
    <button type="button" data-share-action="clear">清空</button>
    <button type="button" data-share-action="cancel">取消</button>
    <button type="button" data-share-action="generate" ${count ? '' : 'disabled'}>生成长图</button>
  `;
  bar.querySelector('[data-share-action="recent"]').addEventListener('click', () => selectRecentShareMessages(6));
  bar.querySelector('[data-share-action="clear"]').addEventListener('click', () => {
    state.shareSelectedKeys.clear();
    renderActive({ stickToBottom: false });
  });
  bar.querySelector('[data-share-action="cancel"]').addEventListener('click', () => setShareMode(false));
  bar.querySelector('[data-share-action="generate"]').addEventListener('click', () => generateShareImage().catch((error) => {
    alert(error.message || '生成分享截图失败');
  }));
  el.promptForm.before(bar);
  el.shareBar = bar;
}

function shareRoleLabel(role = '') {
  if (role === 'user') return '我';
  if (role === 'assistant') return 'Codex';
  if (role === 'tool') return '工具';
  return '系统';
}

function shareText(message) {
  return String(message?.text || '')
    .replace(/```[\w-]*\n?/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function shareTokenFont(token, size = 26) {
  const weight = token.bold ? 700 : 400;
  return `${weight} ${size}px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
}

function parseShareMarkdownInline(text) {
  const tokens = [];
  const value = String(text || '');
  let index = 0;
  const pushText = (textPart, extra = {}) => {
    if (!textPart) return;
    const previous = tokens.at(-1);
    if (previous && previous.kind === (extra.kind || 'text') && previous.bold === Boolean(extra.bold)) {
      previous.text += textPart;
      return;
    }
    tokens.push({ kind: extra.kind || 'text', text: textPart, bold: Boolean(extra.bold) });
  };

  while (index < value.length) {
    if (value.startsWith('**', index)) {
      const end = value.indexOf('**', index + 2);
      if (end > index + 2) {
        pushText(value.slice(index + 2, end), { bold: true });
        index = end + 2;
        continue;
      }
    }

    if (value[index] === '`') {
      const end = value.indexOf('`', index + 1);
      if (end > index + 1) {
        pushText(value.slice(index + 1, end), { kind: 'code' });
        index = end + 1;
        continue;
      }
    }

    if (value[index] === '[') {
      const labelEnd = value.indexOf(']', index + 1);
      if (labelEnd > index + 1 && value[labelEnd + 1] === '(') {
        const hrefEnd = value.indexOf(')', labelEnd + 2);
        if (hrefEnd > labelEnd + 2) {
          pushText(value.slice(index + 1, labelEnd), { kind: 'link' });
          index = hrefEnd + 1;
          continue;
        }
      }
    }

    const bareLink = value.slice(index).match(/^https?:\/\/[^\s)）]+/i);
    if (bareLink) {
      pushText(bareLink[0], { kind: 'link' });
      index += bareLink[0].length;
      continue;
    }

    pushText(value[index]);
    index += 1;
  }
  return tokens;
}

function shareImageSource(image) {
  if (!image) return '';
  const direct = image.url || image.dataUrl || image.data;
  if (direct) return direct;
  const fileName = image.fileName || String(image.path || '').split('/').pop();
  if (!/^[a-f0-9-]+\.[a-z0-9]{1,12}$/i.test(fileName || '')) return '';
  return `/api/uploads/${encodeURIComponent(fileName)}`;
}

function splitShareTableRow(line) {
  return String(line || '')
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function isShareTableRow(line) {
  return String(line || '').includes('|');
}

function isShareTableSeparator(line) {
  const cells = splitShareTableRow(line);
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function isShareTableStart(lines, index) {
  return isShareTableRow(lines[index]) && isShareTableSeparator(lines[index + 1]);
}

function parseShareBlocks(text) {
  const blocks = [];
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  for (let index = 0; index < lines.length;) {
    if (!lines[index].trim()) {
      index += 1;
      continue;
    }

    if (isShareTableStart(lines, index)) {
      const header = splitShareTableRow(lines[index]);
      index += 2;
      const rows = [];
      while (index < lines.length && isShareTableRow(lines[index]) && lines[index].trim()) {
        const cells = splitShareTableRow(lines[index]);
        rows.push(cells);
        index += 1;
      }
      blocks.push({ type: 'table', header, rows });
      continue;
    }

    const paragraphLines = [];
    while (index < lines.length && lines[index].trim() && !isShareTableStart(lines, index)) {
      paragraphLines.push(lines[index]);
      index += 1;
    }
    if (paragraphLines.length) blocks.push({ type: 'paragraph', text: paragraphLines.join('\n') });
  }
  return blocks.length ? blocks : [{ type: 'paragraph', text: '(空消息)' }];
}

function wrapCanvasRichText(ctx, text, maxWidth, size = 26) {
  const lines = [];
  const paragraphs = String(text || '').split('\n');
  for (const paragraph of paragraphs) {
    if (!paragraph) {
      lines.push([]);
      continue;
    }
    let line = [];
    let lineWidth = 0;
    for (const token of parseShareMarkdownInline(paragraph)) {
      ctx.font = shareTokenFont(token, size);
      for (const char of [...token.text]) {
        const width = ctx.measureText(char).width;
        if (line.length && lineWidth + width > maxWidth) {
          lines.push(line);
          line = [];
          lineWidth = 0;
        }
        const previous = line.at(-1);
        if (previous && previous.kind === token.kind && previous.bold === token.bold) previous.text += char;
        else line.push({ ...token, text: char });
        lineWidth += width;
      }
    }
    if (line.length) lines.push(line);
  }
  return lines;
}

function measureShareInlineWidth(ctx, text, size = 26) {
  let width = 0;
  for (const token of parseShareMarkdownInline(text)) {
    ctx.font = shareTokenFont(token, size);
    width += ctx.measureText(token.text).width;
  }
  return width;
}

function drawCanvasRichLine(ctx, tokens, x, y, size = 26) {
  let cursor = x;
  for (const token of tokens || []) {
    ctx.font = shareTokenFont(token, size);
    ctx.fillStyle = token.kind === 'link' ? '#0b6bcb' : token.kind === 'code' ? '#1f2328' : '#22272e';
    if (token.kind === 'code') {
      const width = ctx.measureText(token.text).width;
      ctx.fillStyle = '#eee8dc';
      roundRectPath(ctx, cursor - 3, y - size + 1, width + 6, size + 5, 5);
      ctx.fill();
      ctx.fillStyle = '#1f2328';
    }
    ctx.fillText(token.text, cursor, y);
    cursor += ctx.measureText(token.text).width;
  }
}

function roundRectPath(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function loadShareImage(src) {
  return new Promise((resolve) => {
    if (!src) {
      resolve(null);
      return;
    }
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = src;
  });
}

function layoutShareTable(ctx, table, maxWidth) {
  const cellPadX = 14;
  const cellPadY = 11;
  const lineHeight = 30;
  const minColumn = 76;
  const maxColumn = 320;
  const columns = Math.max(table.header.length, ...table.rows.map((row) => row.length), 1);
  const widths = [];
  for (let column = 0; column < columns; column += 1) {
    const values = [table.header[column] || '', ...table.rows.map((row) => row[column] || '')];
    const contentWidth = Math.max(...values.map((cell) => measureShareInlineWidth(ctx, cell, 22)), 0);
    widths.push(Math.max(minColumn, Math.min(maxColumn, Math.ceil(contentWidth + cellPadX * 2))));
  }

  const naturalWidth = widths.reduce((sum, width) => sum + width, 0);
  if (naturalWidth > maxWidth) {
    const scale = maxWidth / naturalWidth;
    const floorWidth = Math.max(48, Math.floor(maxWidth / columns));
    for (let index = 0; index < widths.length; index += 1) {
      widths[index] = Math.max(floorWidth, Math.floor(widths[index] * scale));
    }
    let overflow = widths.reduce((sum, width) => sum + width, 0) - maxWidth;
    for (let index = widths.length - 1; overflow > 0 && index >= 0; index -= 1) {
      const shrink = Math.min(overflow, Math.max(0, widths[index] - 40));
      widths[index] -= shrink;
      overflow -= shrink;
    }
  }

  const tableWidth = widths.reduce((sum, width) => sum + width, 0);
  const layoutRow = (cells, header = false) => {
    const cellLayouts = [];
    let rowHeight = 0;
    for (let column = 0; column < columns; column += 1) {
      const lines = wrapCanvasRichText(ctx, cells[column] || '', Math.max(40, widths[column] - cellPadX * 2), 22).slice(0, 12);
      cellLayouts.push(lines);
      rowHeight = Math.max(rowHeight, Math.max(1, lines.length) * lineHeight + cellPadY * 2);
    }
    return { cells: cellLayouts, header, height: rowHeight };
  };

  const rows = [layoutRow(table.header, true), ...table.rows.slice(0, 40).map((row) => layoutRow(row, false))];
  return {
    type: 'table',
    widths,
    rows,
    width: tableWidth,
    height: rows.reduce((sum, row) => sum + row.height, 0)
  };
}

function layoutShareBlocks(ctx, blocks, maxWidth) {
  const layouts = [];
  let height = 0;
  for (const block of blocks) {
    if (block.type === 'table') {
      const table = layoutShareTable(ctx, block, maxWidth);
      layouts.push(table);
      height += table.height + 18;
      continue;
    }
    const lines = wrapCanvasRichText(ctx, block.text, maxWidth).slice(0, 80);
    layouts.push({ type: 'paragraph', lines, height: lines.length * 36 });
    height += lines.length * 36 + 8;
  }
  return { blocks: layouts, height: Math.max(0, height - 8) };
}

async function buildShareLayout(messages, session) {
  const width = 900;
  const margin = 38;
  const gap = 18;
  const measure = document.createElement('canvas').getContext('2d');
  const bubbleMax = width - margin * 2;
  measure.font = '28px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  const items = [];
  let y = 132;

  for (const message of messages) {
    const text = shareText(message) || '(空消息)';
    const textMax = bubbleMax - 44;
    const { blocks, height: textHeight } = layoutShareBlocks(measure, parseShareBlocks(text), textMax);
    const images = [];
    for (const image of (message.images || []).slice(0, 3)) {
      const loaded = await loadShareImage(shareImageSource(image));
      images.push({ loaded, name: image.name || '图片' });
    }
    const fileCount = (message.files || []).length;
    const imageRows = images.length ? Math.ceil(images.length / 2) : 0;
    const imageHeight = imageRows ? imageRows * 150 + (imageRows - 1) * 10 + 16 : 0;
    const fileHeight = fileCount ? 34 : 0;
    const height = 58 + textHeight + imageHeight + fileHeight + 24;
    items.push({ message, blocks, images, fileCount, x: margin, y, width: bubbleMax, height });
    y += height + gap;
  }

  const totalHeight = y + 56;
  if (totalHeight > 14000) {
    throw new Error('截图太长了，请少选一些消息后再生成。');
  }
  return { width, height: totalHeight, items, session };
}

function drawShareTable(ctx, table, x, y) {
  const lineHeight = 30;
  const cellPadX = 14;
  const cellPadY = 11;
  let rowY = y;
  ctx.lineWidth = 1;
  ctx.strokeStyle = '#d4cec0';
  for (const row of table.rows) {
    let cellX = x;
    for (let column = 0; column < table.widths.length; column += 1) {
      const cellWidth = table.widths[column];
      ctx.fillStyle = row.header ? '#eee8dc' : '#fffdf8';
      ctx.fillRect(cellX, rowY, cellWidth, row.height);
      ctx.strokeRect(cellX, rowY, cellWidth, row.height);
      let textY = rowY + cellPadY + 22;
      for (const line of row.cells[column] || []) {
        const adjusted = line.map((token) => ({ ...token, bold: row.header || token.bold }));
        drawCanvasRichLine(ctx, adjusted, cellX + cellPadX, textY, 22);
        textY += lineHeight;
      }
      cellX += cellWidth;
    }
    rowY += row.height;
  }
}

function drawShareImage(layout) {
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(layout.width * ratio);
  canvas.height = Math.floor(layout.height * ratio);
  canvas.style.width = `${layout.width}px`;
  canvas.style.height = `${layout.height}px`;
  const ctx = canvas.getContext('2d');
  ctx.scale(ratio, ratio);
  ctx.fillStyle = '#f4f1e9';
  ctx.fillRect(0, 0, layout.width, layout.height);

  ctx.fillStyle = '#1f2328';
  ctx.font = '700 32px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.fillText(layout.session?.title || 'Codex 会话', 38, 58);
  ctx.fillStyle = '#6f767d';
  ctx.font = '22px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.fillText(formatTime(new Date().toISOString()), 38, 92);

  for (const item of layout.items) {
    const isUser = item.message.role === 'user';
    const isSystem = item.message.role === 'system';
    const x = item.x;
    const y = item.y;
    ctx.fillStyle = isUser ? '#dcf7f2' : isSystem ? '#f1efe7' : '#ffffff';
    ctx.strokeStyle = isUser ? '#8fd7ca' : '#ded8ca';
    ctx.lineWidth = 2;
    roundRectPath(ctx, x, y, item.width, item.height, 18);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = isUser ? '#0b766e' : '#59636e';
    ctx.font = '700 20px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillText(shareRoleLabel(item.message.role), x + 22, y + 34);
    ctx.fillStyle = '#8a9299';
    ctx.font = '18px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    const time = formatTime(item.message.at);
    if (time) ctx.fillText(time, x + item.width - ctx.measureText(time).width - 22, y + 34);

    ctx.fillStyle = '#22272e';
    ctx.font = '26px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    let textY = y + 78;
    for (const block of item.blocks) {
      if (block.type === 'table') {
        drawShareTable(ctx, block, x + 22, textY - 26);
        textY += block.height + 18;
        continue;
      }
      for (const line of block.lines) {
        drawCanvasRichLine(ctx, line, x + 22, textY);
        textY += 36;
      }
      textY += 8;
    }

    if (item.images.length) {
      let imgX = x + 22;
      let imgY = textY + 10;
      for (const image of item.images) {
        ctx.fillStyle = '#ece7dc';
        roundRectPath(ctx, imgX, imgY, 190, 140, 12);
        ctx.fill();
        if (image.loaded) {
          const scale = Math.min(190 / image.loaded.width, 140 / image.loaded.height);
          const drawW = image.loaded.width * scale;
          const drawH = image.loaded.height * scale;
          ctx.drawImage(image.loaded, imgX + (190 - drawW) / 2, imgY + (140 - drawH) / 2, drawW, drawH);
        } else {
          ctx.fillStyle = '#7d858c';
          ctx.font = '20px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
          ctx.fillText('图片', imgX + 72, imgY + 78);
        }
        imgX += 204;
        if (imgX + 190 > x + item.width - 22) {
          imgX = x + 22;
          imgY += 150;
        }
      }
      textY += Math.ceil(item.images.length / 2) * 150 + 16;
    }

    if (item.fileCount) {
      ctx.fillStyle = '#6f767d';
      ctx.font = '20px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      ctx.fillText(`附件 ${item.fileCount} 个`, x + 22, textY + 32);
    }
  }
  return canvas;
}

async function generateShareImage() {
  const messages = selectedShareMessages();
  if (!messages.length) throw new Error('先选择要分享的消息。');
  el.sharePreviewState.textContent = '正在生成...';
  el.sharePreviewBody.innerHTML = '<div class="share-preview-loading">正在生成长图...</div>';
  openModal(el.sharePreviewDialog);
  const layout = await buildShareLayout(messages, getActiveSession());
  const canvas = drawShareImage(layout);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png', 0.95));
  if (!blob) throw new Error('生成图片失败');
  if (state.shareImageUrl) URL.revokeObjectURL(state.shareImageUrl);
  state.shareImageBlob = blob;
  state.shareImageUrl = URL.createObjectURL(blob);
  el.sharePreviewBody.innerHTML = '';
  const img = document.createElement('img');
  img.src = state.shareImageUrl;
  img.alt = '分享截图预览';
  el.sharePreviewBody.append(img);
  el.sharePreviewState.textContent = `${messages.length} 条消息 · ${formatBytes(blob.size)}`;
}

async function copyShareImage() {
  if (!state.shareImageBlob) return;
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
    el.sharePreviewState.textContent = '当前浏览器不支持复制图片，请下载后分享。';
    return;
  }
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': state.shareImageBlob })]);
  el.sharePreviewState.textContent = '已复制图片。';
}

function downloadShareImage() {
  if (!state.shareImageUrl) return;
  const link = document.createElement('a');
  link.href = state.shareImageUrl;
  link.download = `codex-share-${Date.now()}.png`;
  link.click();
}

function closeSharePreview() {
  closeModal(el.sharePreviewDialog);
}

function renderOlderMessagesControl(sessionId) {
  if (state.showStarredOnly) return null;
  const page = state.messagePages.get(sessionId);
  if (!page?.hasMore && !hasHiddenBriefRounds(sessionId)) return null;
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
  if (!state.showStarredOnly && state.messageDisplayMode === 'brief') {
    return buildBriefDisplayMessages(filtered, sessionId);
  }
  const maxRendered = sessionRenderedMessageLimit(sessionId);
  const visible = state.showStarredOnly ? filtered : filtered.slice(-maxRendered);
  return mergeDisplayMessages(visible);
}

function buildBriefDisplayMessages(messages, sessionId) {
  const rounds = buildBriefRounds(messages);
  const visibleRounds = rounds.slice(-sessionBriefRoundLimit(sessionId));
  const runningRoundIndex = isSessionRunning(getActiveSession()) && state.activeId === sessionId ? visibleRounds.length - 1 : -1;
  const out = [];
  for (let index = 0; index < visibleRounds.length; index += 1) {
    const round = visibleRounds[index];
    if (round.user) out.push(round.user);
    if (round.conclusion) out.push(round.conclusion);
    if (index === runningRoundIndex) out.push(briefProgressMessage(round, sessionId, index));
  }
  return mergeDisplayMessages(out);
}

function buildBriefRounds(messages) {
  const rounds = [];
  let current = null;

  const pushCurrent = () => {
    if (current?.user || current?.conclusion || current?.outputCount) rounds.push(current);
  };

  for (const message of messages) {
    if (message.role === 'user') {
      pushCurrent();
      current = {
        user: message,
        conclusion: null,
        outputCount: 0,
        firstSeq: message.orderSeq || message.seq || 0,
        lastSeq: message.orderSeq || message.seq || 0
      };
      continue;
    }

    if (!current) {
      current = {
        user: null,
        conclusion: null,
        outputCount: 0,
        firstSeq: message.orderSeq || message.seq || 0,
        lastSeq: message.orderSeq || message.seq || 0
      };
    }

    current.lastSeq = message.orderSeq || message.seq || current.lastSeq;
    if (isCodexOutputMessage(message)) current.outputCount += 1;
    if (isConclusionMessage(message)) current.conclusion = message;
  }
  pushCurrent();
  return rounds;
}

function hasHiddenBriefRounds(sessionId) {
  if (state.messageDisplayMode !== 'brief') return false;
  const rounds = buildBriefRounds(loadMessages(sessionId));
  return rounds.length > sessionBriefRoundLimit(sessionId);
}

function isCodexOutputMessage(message) {
  if (!['assistant', 'tool'].includes(message?.role || '')) return false;
  return String(message.text || '').trim().length > 0;
}

function isConclusionMessage(message) {
  if (message?.role !== 'assistant') return false;
  const text = String(message.text || '').trim();
  if (!text) return false;
  return !isStatusOnlyMessage(text);
}

function isStatusOnlyMessage(text) {
  return [
    'Codex run finished.',
    'Codex run stopped.',
    'Starting next queued prompt.',
    'Stop requested.',
    'Recovered stale run state',
    'Failed to start Codex',
    'Codex exited with code'
  ].some((needle) => text.includes(needle));
}

function briefProgressMessage(round, sessionId, index) {
  const count = round?.outputCount || 0;
  const text = count
    ? `处理中... 已收到 Codex 输出 ${count} 条`
    : '处理中... 等待 Codex 输出';
  return {
    id: `brief-progress-${sessionId}-${round?.firstSeq || index}`,
    seq: Number(round?.lastSeq || round?.firstSeq || index) + 0.1,
    role: 'system',
    variant: 'brief-progress',
    at: round?.conclusion?.at || round?.user?.at || '',
    text
  };
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
  const queueCount = session?.statusSummary?.queueCount ?? session?.queuedCount ?? 0;
  const waiting = queueCount ? ` · 待执行 ${queueCount} 条` : '';
  const status = session?.statusSummary?.status || session?.status;
  const label = status === 'stopping'
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

function renderSystemHealth(data = {}) {
  if (!el.systemHealthPanel) return;
  const service = data.service || {};
  const storage = data.storage || {};
  const sessions = data.sessions || {};
  const disk = storage.disk;
  const diskText = disk ? `${formatBytes(disk.freeBytes)} / ${formatBytes(disk.totalBytes)}` : '未知';
  const warnings = Array.isArray(data.warnings) ? data.warnings : [];
  el.systemHealthPanel.innerHTML = `
    <span>服务 <strong>${data.ok ? '正常' : '需关注'}</strong></span>
    <span>运行 <strong>${sessions.running || 0}</strong></span>
    <span>队列 <strong>${sessions.queuedMessages || 0}</strong></span>
    <span>失败 Run <strong>${sessions.failedRuns || 0}</strong></span>
    <span>SSE <strong>${service.sseClients || 0}</strong></span>
    <span>内存 <strong>${escapeHtml(formatBytes(service.memory?.rssBytes || 0))}</strong></span>
    <span>磁盘 <strong>${escapeHtml(diskText)}</strong></span>
    <span>启动 <strong>${escapeHtml(formatDuration(service.uptimeMs || 0))}</strong></span>
    ${warnings.length ? `<p>${warnings.map((item) => escapeHtml(item)).join('<br>')}</p>` : '<p>未发现需要立即处理的异常。</p>'}
  `;
}

async function loadSystemHealth() {
  if (!el.systemHealthPanel) return;
  el.systemHealthPanel.textContent = '加载中...';
  const data = await api('/api/system/health');
  renderSystemHealth(data);
  if (data.app) renderAppUpdate(data.app);
  if (data.upgradeTask) renderCodexUpgrade({ upgradeTask: data.upgradeTask });
}

function renderAppUpdate(data = {}) {
  if (!el.appUpdatePanel) return;
  const git = data.git || {};
  const latest = data.latest || {};
  const task = data.updateTask || null;
  const rollback = data.rollback || null;
  const target = latest.target || task?.target || '';
  const status = task
    ? `${task.type === 'rollback' ? '回滚' : '升级'} ${task.status || '-'}${task.step ? ` · ${task.step}` : ''}`
    : latest.updateAvailable ? '有更新' : latest.checkedAt ? '已是最新' : '未检查';
  const warnings = [
    git.dirty ? '本地有未提交改动，自动升级会被阻止。' : '',
    ...(latest.warnings || []),
    task?.error || ''
  ].filter(Boolean);
  el.rollbackAppButton.disabled = !rollback?.commit || task?.status === 'running';
  el.updateAppButton.disabled = task?.status === 'running';
  el.appUpdatePanel.innerHTML = `
    <div class="maintenance-grid">
      <span>版本 <strong>${escapeHtml(data.version || '-')}</strong></span>
      <span>Commit <strong>${escapeHtml(git.shortCommit || '-')}</strong></span>
      <span>分支 <strong>${escapeHtml(git.branch || '-')}</strong></span>
      <span>状态 <strong>${escapeHtml(status)}</strong></span>
      <span>目标 <strong>${escapeHtml(target || latest.latestTag || latest.latestRemoteCommit?.slice(0, 12) || '-')}</strong></span>
      <span>回滚 <strong>${escapeHtml(rollback?.shortCommit || '-')}</strong></span>
    </div>
    <p>控制台升级只处理本应用代码；会阻止运行中的 Codex 任务和本地未提交改动。</p>
    ${warnings.length ? `<p>${warnings.map((item) => escapeHtml(item)).join('<br>')}</p>` : ''}
  `;
}

async function loadAppVersion() {
  if (!el.appUpdatePanel) return;
  el.appUpdatePanel.textContent = '读取中...';
  renderAppUpdate(await api('/api/app/version'));
}

async function checkAppUpdate() {
  if (!el.appUpdatePanel) return;
  el.appUpdatePanel.textContent = '检查中...';
  renderAppUpdate(await api('/api/app/update-check'));
}

async function updateApp() {
  if (!confirm('将从 GitHub 拉取并升级本控制台。运行中的 Codex 任务或本地未提交改动会阻止升级。确认继续？')) return;
  el.updateAppButton.disabled = true;
  try {
    const data = await api('/api/app/update', { method: 'POST' });
    renderAppUpdate({ updateTask: data.task });
    setBadge('控制台升级已开始', 'busy');
  } finally {
    el.updateAppButton.disabled = false;
  }
}

async function rollbackApp() {
  if (!confirm('回滚到上次升级前的控制台版本？运行中的 Codex 任务会阻止回滚。')) return;
  el.rollbackAppButton.disabled = true;
  try {
    const data = await api('/api/app/rollback', { method: 'POST' });
    renderAppUpdate({ updateTask: data.task });
    setBadge('控制台回滚已开始', 'busy');
  } finally {
    el.rollbackAppButton.disabled = false;
  }
}

function renderCodexUpgrade(data = {}) {
  if (!el.codexUpgradePanel) return;
  const task = data.upgradeTask || data.task || null;
  const current = data.currentVersion || task?.currentVersion || '';
  const latest = data.latestVersion || task?.after?.currentVersion || '';
  const updateText = data.updateAvailable ? '有新版' : current && latest ? '已是最新' : '待检查';
  const taskText = task
    ? `任务 ${task.status || '-'}${task.finishedAt ? ` · ${formatTime(task.finishedAt)}` : ''}`
    : '没有升级任务';
  el.codexUpgradePanel.innerHTML = `
    <div class="maintenance-grid">
      <span>当前 <strong>${escapeHtml(current || data.currentText || '未知')}</strong></span>
      <span>最新 <strong>${escapeHtml(latest || '未知')}</strong></span>
      <span>状态 <strong>${escapeHtml(updateText)}</strong></span>
      <span>任务 <strong>${escapeHtml(taskText)}</strong></span>
    </div>
    <p>升级会修改全局 Codex CLI，可能影响所有会话的输出格式；运行中任务存在时会阻止升级。</p>
    ${data.currentError ? `<p>${escapeHtml(data.currentError)}</p>` : ''}
    ${data.latestError ? `<p>${escapeHtml(data.latestError)}</p>` : ''}
  `;
}

async function checkCodexUpgrade() {
  if (!el.codexUpgradePanel) return;
  el.codexUpgradePanel.textContent = '检查中...';
  const data = await api('/api/codex/upgrade-check');
  renderCodexUpgrade(data);
}

async function upgradeCodex() {
  if (!confirm('升级会修改全局 Codex CLI，并在完成后安全重启本服务。确认继续？')) return;
  el.upgradeCodexButton.disabled = true;
  try {
    const data = await api('/api/codex/upgrade', { method: 'POST' });
    renderCodexUpgrade(data);
    setBadge('升级已开始', 'busy');
  } finally {
    el.upgradeCodexButton.disabled = false;
  }
}

function applyTagManagementData(data = {}) {
  if (Array.isArray(data.sessions)) {
    state.sessions = data.sessions;
    saveSessionCache();
    renderSessions({ force: true });
    renderActive({ messages: false });
  }
  renderTagManagement(data);
}

function renderTagManagement(data = {}) {
  if (!el.tagManagementPanel) return;
  const tags = Array.isArray(data.tags) ? data.tags : [];
  el.undoSmartTagsButton.disabled = !data.lastSnapshotAt;
  if (!tags.length) {
    el.tagManagementPanel.innerHTML = '<p class="maintenance-empty">还没有标签。</p>';
    return;
  }
  el.tagManagementPanel.innerHTML = tags.map((item) => `
    <div class="tag-management-row">
      <div>
        <strong>#${escapeHtml(item.tag)}</strong>
        <span>${item.count || 0} 个 · Web ${item.webCount || 0} · Codex ${item.codexCount || 0}</span>
      </div>
      <div>
        <button class="ghost-button inline" type="button" data-tag-action="rename" data-tag="${escapeHtml(item.tag)}">改名</button>
        <button class="ghost-button inline" type="button" data-tag-action="merge" data-tag="${escapeHtml(item.tag)}">合并</button>
        <button class="ghost-button inline danger" type="button" data-tag-action="delete" data-tag="${escapeHtml(item.tag)}">删除</button>
      </div>
    </div>
  `).join('');
  for (const button of el.tagManagementPanel.querySelectorAll('[data-tag-action]')) {
    button.addEventListener('click', () => runTagAction(button.dataset.action, button.dataset.tag));
  }
}

async function loadTagManagement() {
  if (!el.tagManagementPanel) return;
  el.tagManagementPanel.textContent = '加载中...';
  applyTagManagementData(await api('/api/tags'));
}

async function runTagAction(action, tag) {
  const label = action === 'rename' ? '改名为' : action === 'merge' ? '合并到' : '删除';
  let target = '';
  if (action === 'rename' || action === 'merge') {
    target = prompt(`把 #${tag} ${label}：`, '');
    if (target === null) return;
    target = parseSessionTagsInput(target)[0] || '';
    if (!target) return alert('请输入有效标签。');
  } else if (!confirm(`从所有会话中删除 #${tag}？`)) {
    return;
  }
  const data = await api('/api/tags/action', {
    method: 'POST',
    body: JSON.stringify({ action, tag, toTag: target })
  });
  applyTagManagementData(data);
  setBadge(`已更新 ${data.changed || 0} 个`, 'ok');
}

async function undoSmartTags() {
  if (!confirm('撤销上次智能分类前的标签快照？')) return;
  const data = await api('/api/sessions/tags/undo', { method: 'POST' });
  applyTagManagementData(data);
  setBadge('已撤销智能分类', 'ok');
}

async function loadMaintenancePage() {
  const results = await Promise.allSettled([
    loadSystemHealth(),
    loadAppVersion(),
    loadTagManagement()
  ]);
  if (results[0].status === 'rejected' && el.systemHealthPanel) {
    el.systemHealthPanel.textContent = results[0].reason?.detail || results[0].reason?.message || '健康检查失败';
  }
  if (results[1].status === 'rejected' && el.appUpdatePanel) {
    el.appUpdatePanel.textContent = results[1].reason?.detail || results[1].reason?.message || '版本读取失败';
  }
  if (results[2].status === 'rejected' && el.tagManagementPanel) {
    el.tagManagementPanel.textContent = results[2].reason?.detail || results[2].reason?.message || '标签加载失败';
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
        <span>运行 <strong>${service.runningSessions || 0}</strong></span>
        <span>SSE <strong>${service.sseClients || 0}</strong></span>
        <span>RSS <strong>${escapeHtml(formatBytes(service.memory?.rssBytes || 0))}</strong></span>
        <span>磁盘 <strong>${escapeHtml(diskText)}</strong></span>
      </div>
      <span>Node ${escapeHtml(service.node || '-')} · ${escapeHtml(service.host || '-')}:${service.port || '-'} · 请求 ${service.activeRequests || 0}/${formatNumber(service.totalRequests || 0)}</span>
    </div>
  `;
}

function renderBrowserRuntime(local) {
  return `
    <div class="runtime-section">
      <strong>浏览器本地</strong>
      <div class="runtime-grid compact">
        <span>网络 <strong>${local.online ? '在线' : '离线'}</strong></span>
        <span>页面 <strong>${escapeHtml(local.visibility || '-')}</strong></span>
        <span>SW <strong>${escapeHtml(local.serviceWorker)}</strong></span>
        <span>local <strong>${escapeHtml(formatBytes(local.localStorageBytes || 0))}</strong></span>
        <span>存储 <strong>${escapeHtml(storageRatioText(local.storageUsageBytes, local.storageQuotaBytes))}</strong></span>
        <span>本页 <strong>${local.currentCachedMessages}/${local.pageTotal || 0}</strong></span>
        <span>缓存页 <strong>${local.pageOffset || 0}${local.pageHasMore ? '+' : ''}</strong></span>
      </div>
      <span>localStorage ${local.cmcLocalStorageKeys}/${local.localStorageKeys} 项</span>
    </div>
  `;
}

function renderSessionRuntime(data, local) {
  const session = data.session || {};
  const summary = data.statusSummary || session.statusSummary || {};
  const health = data.contextHealth || session.contextHealth || summary.contextHealth || {};
  const active = data.harness?.activeRun || data.activeRun;
  const queueCount = Array.isArray(data.queue) ? data.queue.length : 0;
  return `
    <div class="runtime-section">
      <strong>当前会话</strong>
      <div class="runtime-grid compact">
        <span>状态 <strong>${escapeHtml(summary.label || (data.running ? '运行中' : '空闲'))}</strong></span>
        <span>队列 <strong>${summary.queueCount ?? queueCount}</strong></span>
        <span>上下文 <strong>${escapeHtml(health.label || '未知')}</strong></span>
        <span>SSE <strong>${escapeHtml(local.eventConnectionStatus || '-')}</strong></span>
        <span>版本 <strong>${escapeHtml(local.appAssetVersion || '-')}</strong></span>
      </div>
      <p>${escapeHtml(active?.promptSummary || active?.prompt || '当前没有运行中的输入')}</p>
      <span>${escapeHtml(active?.startedAt ? `开始 ${formatTime(active.startedAt)} · 图片 ${active.attachments?.imageCount ?? active.imageCount ?? 0} · 文件 ${active.attachments?.fileCount ?? active.fileCount ?? 0}` : '等待下一次发送')}</span>
    </div>
  `;
}

function renderHarnessRuntime(data) {
  const harness = data.harness || {};
  const active = harness.activeRun;
  const recentRuns = harness.recentRuns || [];
  const recentAudit = harness.recentAudit || [];
  const runRows = recentRuns.slice(-5).reverse().map((run) => `
    <span>${escapeHtml(run.status || '-')} <strong>${escapeHtml(run.errorCode || run.promptSummary || run.id || '-')}</strong></span>
  `).join('');
  const auditRows = recentAudit.slice(-5).reverse().map((event) => `
    <span>${escapeHtml(event.type || '-')} <strong>${escapeHtml(event.summary || '-')}</strong></span>
  `).join('');
  return `
    <div class="runtime-section">
      <strong>Harness 状态</strong>
      <div class="runtime-grid compact">
        <span>当前 Run <strong>${escapeHtml(active?.status || '无')}</strong></span>
        <span>输出 <strong>${active?.outputCount || 0}</strong></span>
        <span>工具 <strong>${active?.toolCount || 0}</strong></span>
        <span>事件 <strong>${active?.eventCount || 0}</strong></span>
        ${active?.errorCode ? `<span>失败 <strong>${escapeHtml(active.errorCode)}</strong></span>` : ''}
      </div>
      ${active?.errorSummary ? `<p>${escapeHtml(active.errorSummary)}</p>` : ''}
      ${runRows ? `<div class="runtime-grid compact">${runRows}</div>` : '<span>暂无历史 run。</span>'}
      ${auditRows ? `<div class="runtime-grid compact">${auditRows}</div>` : ''}
    </div>
  `;
}

function renderRuntimeActions() {
  return `
    <div class="runtime-actions">
      <button class="ghost-button inline" type="button" data-runtime-action="refresh">刷新状态</button>
      <button class="ghost-button inline" type="button" data-runtime-action="reconnect">重连 SSE</button>
      <button class="ghost-button inline danger" type="button" data-runtime-action="clear-cache">清缓存</button>
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
  const processes = data.processes || [];
  const local = await browserRuntimeInfo(data.session?.id || state.activeId);
  el.runtimePanel.innerHTML = `
    ${renderRuntimeActions()}
    ${renderSessionRuntime(data, local)}
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
    ${renderTokenUsage(data)}
    ${renderHarnessRuntime(data)}
    ${renderServiceRuntime(data)}
    ${renderBrowserRuntime(local)}
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

async function fetchRuntimeInfo(session = getActiveSession()) {
  if (!session?.id) return null;
  const data = await api(`/api/sessions/${encodeURIComponent(session.id)}/runtime`);
  if (data.view) mergeSessionView(data.view, session.id);
  if (data.session && mergeSessionSnapshot(data.session)) {
    renderSessions();
    renderActive({ messages: false });
  }
  return data;
}

function renderTaskEvent(event = {}) {
  const label = event.type || event.status || event.name || 'event';
  const detail = event.summary || event.message || event.error || event.code || '';
  return `
    <li>
      <span>${escapeHtml(formatTime(event.at || event.time || event.createdAt))}</span>
      <strong>${escapeHtml(label)}</strong>
      ${detail ? `<em>${escapeHtml(summarizeText(detail, 96))}</em>` : ''}
    </li>
  `;
}

function taskContinuationText(data = {}) {
  const session = data.session || getActiveSession() || {};
  const harness = data.harness || {};
  const task = session.taskDetail || data.taskDetail || {};
  const run = harness.activeRun || task.run || session.lastRun || {};
  const failure = task.failure || (run.errorSummary ? { code: run.errorCode || '', summary: run.errorSummary } : null);
  const parts = [
    '请从旧会话继续完成任务。你现在处在一个新的 Codex 会话中，请先恢复上下文，再继续推进。',
    '',
    `旧会话：${session.title || session.id || '未命名会话'}`,
    `工作目录：${session.cwd || '(未知)'}`,
    session.codexSessionId ? `旧 Codex 会话 ID：${session.codexSessionId}` : '',
    '',
    run.promptSummary ? `最近任务输入：\n${run.promptSummary}` : '',
    failure ? `最近失败：${failure.code || 'unknown'}\n${failure.summary || ''}` : '',
    '',
    '请先用简短清单复述你将如何续接，然后继续执行。'
  ].filter(Boolean);
  return parts.join('\n');
}

function renderTaskDetailPanel(data = {}) {
  const session = data.session || getActiveSession() || {};
  const summary = data.statusSummary || session.statusSummary || {};
  const task = session.taskDetail || data.taskDetail || {};
  const harness = data.harness || {};
  const run = harness.activeRun || task.run || session.activeRun || session.lastRun || null;
  const events = task.recentEvents || harness.recentAudit || session.recentAudit || [];
  const failure = task.failure || (run?.errorSummary ? { code: run.errorCode || '', summary: run.errorSummary } : null);
  const contextHealth = data.contextHealth || session.contextHealth || summary.contextHealth || {};
  const canContinue = Boolean(session?.id && session.source !== 'codex');

  el.taskDetailBody.innerHTML = `
    <section class="task-detail-section">
      <strong>当前任务</strong>
      <div class="runtime-grid compact">
        <span>状态 <strong>${escapeHtml(summary.label || session.status || '-')}</strong></span>
        <span>队列 <strong>${summary.queueCount ?? session.queuedCount ?? 0}</strong></span>
        <span>上下文 <strong>${escapeHtml(contextHealth.label || '未知')}</strong></span>
        <span>运行 <strong>${escapeHtml(run?.status || '无')}</strong></span>
      </div>
      <p>${escapeHtml(run?.promptSummary || '当前没有正在执行或最近失败的任务摘要。')}</p>
    </section>
    ${failure ? `
      <section class="task-detail-section danger">
        <strong>失败信息</strong>
        <p>${escapeHtml([failure.code, failure.summary].filter(Boolean).join(' · ') || '最近任务失败。')}</p>
      </section>
    ` : ''}
    <section class="task-detail-section">
      <strong>最近事件</strong>
      ${events.length ? `<ol class="task-event-list">${events.slice(-8).reverse().map(renderTaskEvent).join('')}</ol>` : '<p>暂无事件。</p>'}
    </section>
    <div class="runtime-actions">
      <button class="ghost-button inline" type="button" data-task-action="refresh">刷新</button>
      <button class="ghost-button inline" type="button" data-task-action="continue"${canContinue ? '' : ' disabled'}>新会话继续</button>
      <button class="ghost-button inline" type="button" data-task-action="copy">复制续接提示</button>
    </div>
  `;

  el.taskDetailBody.querySelector('[data-task-action="refresh"]')?.addEventListener('click', () => openTaskDetailDialog(session));
  el.taskDetailBody.querySelector('[data-task-action="copy"]')?.addEventListener('click', async () => {
    const prompt = taskContinuationText({ ...data, session });
    await navigator.clipboard?.writeText(prompt).catch(() => {});
  });
  el.taskDetailBody.querySelector('[data-task-action="continue"]')?.addEventListener('click', async () => {
    await continueTaskInNewSession({ ...data, session });
  });
}

async function openTaskDetailDialog(session = getActiveSession()) {
  if (!session?.id || !el.taskDetailDialog || !el.taskDetailBody) return;
  openModal(el.taskDetailDialog);
  el.taskDetailBody.textContent = '加载中...';
  try {
    const data = await fetchRuntimeInfo(session);
    renderTaskDetailPanel(data || { session });
  } catch (error) {
    el.taskDetailBody.innerHTML = `
      <section class="task-detail-section danger">
        <strong>任务详情加载失败</strong>
        <p>${escapeHtml(error.message || '暂时无法获取任务详情。')}</p>
      </section>
      <div class="runtime-actions">
        <button class="ghost-button inline" type="button" data-task-action="retry">重试</button>
      </div>
    `;
    el.taskDetailBody.querySelector('[data-task-action="retry"]')?.addEventListener('click', () => openTaskDetailDialog(session));
  }
}

function closeTaskDetailDialog() {
  closeModal(el.taskDetailDialog);
}

async function continueTaskInNewSession(data = {}) {
  const source = data.session || getActiveSession();
  if (!source?.id) return;
  const prompt = taskContinuationText(data);
  const payload = {
    title: `${source.title || 'Codex session'} 续接`,
    cwd: source.cwd || '/root/Projects',
    ...normalizeRunConfig(source)
  };
  const buttons = [...el.taskDetailBody.querySelectorAll('button')];
  buttons.forEach((button) => {
    button.disabled = true;
  });
  try {
    const created = await api('/api/sessions', { method: 'POST', body: JSON.stringify(payload) });
    if (created.session) {
      state.sessions.unshift(created.session);
      mergeSessionSnapshot(created.session);
      setActiveSessionId(created.session.id);
      saveSessionCache();
      renderSessions();
      renderActive({ messages: false });
      closeTaskDetailDialog();
      await loadSession(created.session.id);
      await promptActions.sendPrompt(prompt, { keepInput: true });
    }
  } catch (error) {
    buttons.forEach((button) => {
      button.disabled = false;
    });
    alert(error.message || '新会话继续失败');
    renderSessions();
    renderActive({ messages: false });
  }
}

function openQueueEditDialog(item) {
  messageView.closeMessageMenus();
  closeTopMenus();
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
  const data = await fetchRuntimeInfo(session);
  await renderRuntimePanel(data);
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
  el.topMoreMenu?.closest?.('.topbar')?.classList.toggle('menu-open', Boolean(open));
}

function closeTopMoreMenu() {
  topbarView.closeTopMoreMenu();
  el.topMoreMenu?.closest?.('.topbar')?.classList.remove('menu-open');
}

function setTopFilterMenu(open) {
  topbarView.setTopFilterMenu(open);
  el.topFilterMenu?.closest?.('.topbar')?.classList.toggle('menu-open', Boolean(open));
}

function closeTopFilterMenu() {
  topbarView.closeTopFilterMenu();
  el.topFilterMenu?.closest?.('.topbar')?.classList.remove('menu-open');
}

function closeTopMenus() {
  topbarView.closeTopMenus();
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
  const config = normalizeRunConfig(state.defaultRunConfig);
  const inherited = [];
  if (!config.model) inherited.push('模型');
  if (!config.reasoningEffort) inherited.push('推理强度');
  const parts = [
    el.elevatedRun.checked ? '提权默认开启' : '提权默认关闭',
    config.model ? `模型覆盖 ${config.model}` : '模型跟随本机 Codex',
    config.profile ? `Profile ${config.profile}` : '不指定 Profile',
    config.reasoningEffort ? `推理覆盖 ${config.reasoningEffort}` : '',
    `沙箱 ${config.sandbox}`,
    `审批 ${config.approval}`,
    config.addDirs.length ? `额外目录 ${config.addDirs.length}` : '',
    config.configOverrides.length ? `-c 覆盖 ${config.configOverrides.length}` : '',
    config.strictConfig ? '严格配置' : '',
    config.ignoreUserConfig ? '忽略本机配置' : '',
    config.ignoreRules ? '忽略规则' : ''
  ].filter(Boolean);
  el.runSettingsState.innerHTML = `
    <strong>新建会话默认：</strong>${escapeHtml(parts.join(' · '))}
    ${inherited.length ? `<br><span>空值会继承：${escapeHtml(inherited.join('、'))}。</span>` : ''}
  `;
}

function renderCodexConfigSummary(data = null) {
  if (!el.codexConfigSummary) return;
  if (!data) {
    el.codexConfigSummary.textContent = '加载中...';
    return;
  }
  const values = data.values || {};
  const rows = [
    ['模型', values.model || '未设置'],
    ['Provider', values.modelProvider || '未设置'],
    ['推理', values.reasoningEffort || '未设置'],
    ['审批', values.approvalPolicy || '未设置'],
    ['沙箱', values.sandboxMode || '未设置'],
    ['响应存储', values.disableResponseStorage === '' ? '未设置' : values.disableResponseStorage === 'true' ? '关闭' : '开启'],
    ['Profile', data.profiles?.length ? data.profiles.join(', ') : '无']
  ];
  el.codexConfigSummary.innerHTML = `
    <div class="codex-config-grid">
      ${rows.map(([label, value]) => `
        <span>${escapeHtml(label)} <strong>${escapeHtml(value)}</strong></span>
      `).join('')}
    </div>
    <small>${data.exists ? `读取 ${escapeHtml(data.configPath || '')}` : '没有找到 config.toml，将使用 Codex 内置默认值。'}</small>
  `;
}

async function loadCodexConfigSummary() {
  if (!el.codexConfigSummary) return;
  renderCodexConfigSummary(null);
  try {
    renderCodexConfigSummary(await api('/api/codex/config'));
  } catch (error) {
    el.codexConfigSummary.innerHTML = `
      <small>${escapeHtml(error.status === 404 ? '服务端更新后会显示本机 Codex 配置；当前仍可编辑本应用默认覆盖项。' : error.message || '读取 Codex 配置失败')}</small>
    `;
  }
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
    if (state.messageDisplayMode === 'brief') {
      messageScheduler.scheduleRender(sessionId, { stickToBottom });
      if (sessionChanged) renderActive({ messages: false });
      return;
    }
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
    if (state.messageDisplayMode === 'brief') {
      messageScheduler.scheduleRender(sessionId, { stickToBottom: shouldStickToBottom(sessionId) });
      if (sessionChanged) renderActive({ messages: false });
      return;
    }
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
    for (const session of state.sessions) {
      if (session.view?.session) mergeSessionView(session.view, session.id);
    }
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
    if (data.view) mergeSessionView(data.view, id);
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
  if (!session || page?.loading || state.loadingOlder) return;
  if (state.messageDisplayMode === 'brief' && hasHiddenBriefRounds(sessionId)) {
    expandBriefRoundLimit(sessionId, 1);
    renderActive({ stickToBottom: false, restoreAnchor: firstVisibleMessageAnchor() });
    return;
  }
  if (!page?.hasMore) return;
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
    if (state.messageDisplayMode === 'brief') expandBriefRoundLimit(sessionId, 1);
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
    if (data?.view) sessionChanged = mergeSessionView(data.view, data.sessionId || id);
    if (data?.session) sessionChanged = mergeSessionSnapshot(data.session) || sessionChanged;
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
    let changed = session.view ? mergeSessionView(session.view, session.id || id) : false;
    changed = mergeSessionSnapshot(session) || changed;
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

function parseSessionTagsInput(value) {
  return [...new Set(String(value || '')
    .split(/[,\s，、]+/)
    .map((tag) => tag.trim().replace(/^#/, '').slice(0, 18))
    .filter(Boolean))]
    .slice(0, 8);
}

async function editSessionTags(session) {
  if (!session?.id) return;
  const current = (session.tags || []).join(' ');
  const value = prompt('编辑标签，多个标签用空格或逗号分隔。', current);
  if (value === null) return;
  try {
    const data = await api(`/api/sessions/${encodeURIComponent(session.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ tags: parseSessionTagsInput(value) })
    });
    if (data.session) mergeSessionSnapshot(data.session);
    renderSessions({ force: true });
    renderActive({ messages: false });
  } catch (error) {
    alert(error.message || '标签保存失败');
  }
}

async function inferSessionTags() {
  if (!confirm('根据会话标题、目录、状态和任务信息自动生成一波分类标签？已有标签会尽量保留。')) return;
  try {
    setBadge('打标签中', 'busy');
    const data = await api('/api/sessions/tags/infer', { method: 'POST' });
    if (Array.isArray(data.sessions)) {
      state.sessions = data.sessions;
      saveSessionCache();
    }
    state.sessionViewMode = 'tag';
    storageSet('cmc.sessionViewMode', state.sessionViewMode);
    syncSessionViewControls();
    renderSessions({ force: true });
    renderActive({ messages: false });
    setBadge(`已标记 ${data.count || state.sessions.length} 个`, 'ok');
  } catch (error) {
    alert(error.message || '智能打标签失败');
    setBadge('打标签失败', 'error');
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

function openSessionConfigDialog(session) {
  if (!session?.id || !el.sessionConfigDialog || !el.sessionConfigForm) return;
  if (session.source === 'codex') {
    alert('全局 Codex 历史会话不能在控制台里修改运行模型。请 Fork 成本应用会话后再配置。');
    return;
  }
  el.sessionConfigForm.dataset.sessionId = session.id;
  applyRunConfigToForm(el.sessionConfigForm, session);
  el.sessionConfigState.textContent = '保存后下一次发送生效。';
  openModal(el.sessionConfigDialog);
}

function openActiveSessionConfigDialog() {
  closeTopMoreMenu();
  const session = getActiveSession();
  if (!session) {
    alert('请先选择一个会话。');
    return;
  }
  openSessionConfigDialog(session);
}

async function saveSessionConfig(event) {
  event.preventDefault();
  const sessionId = el.sessionConfigForm?.dataset.sessionId || '';
  if (!sessionId) return;
  el.sessionConfigState.textContent = '保存中...';
  try {
    const config = runConfigFromForm(el.sessionConfigForm);
    const data = await api(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ config })
    });
    if (data.session) mergeSessionSnapshot(data.session);
    saveSessionCache();
    renderSessions();
    renderActive({ messages: false });
    el.sessionConfigState.textContent = '已保存，下一次发送生效。';
    closeModal(el.sessionConfigDialog);
  } catch (error) {
    el.sessionConfigState.textContent = error.message || '保存失败';
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

function updateMessageDisplayButton() {
  const brief = state.messageDisplayMode === 'brief';
  el.messageDisplayButton.classList.toggle('active', brief);
  el.messageDisplayButton.setAttribute('aria-checked', String(brief));
  el.messageDisplayButton.setAttribute('aria-label', brief ? '当前为结论视图，点击切回完整视图' : '当前为完整视图，点击切到结论视图');
  el.messageDisplayButton.title = brief ? '当前显示用户输入和 Codex 结论' : '隐藏过程，只看输入和结论';
  el.messageDisplayButton.textContent = brief ? '结论视图开启' : '结论视图';
}

function updateCollapseActionButtons() {
  const disabled = !state.activeId;
  el.collapseMessagesButton.disabled = disabled;
  el.expandMessagesButton.disabled = disabled;
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
  closeTopMenus();
  closeAttachmentMenu();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') messageView.closeMessageMenus();
  if (event.key === 'Escape') closeTopMenus();
  if (event.key === 'Escape') closeAttachmentMenu();
  if (event.key === 'Escape' && !el.sessionActionSheet?.hidden) closeSessionActionSheet();
  if (event.key === 'Escape' && !el.imageViewer.hidden) closeImageViewer();
  if (event.key === 'Escape' && el.sharePreviewDialog?.open) closeSharePreview();
  if (event.key === 'Escape' && el.siteRegisterDialog?.open) closeSiteRegisterDialog();
});

el.stopButton.addEventListener('click', stopCurrentRun);

el.topMoreButton.addEventListener('click', (event) => {
  event.stopPropagation();
  setTopMoreMenu(el.topMoreMenu.hidden);
});

el.topMoreMenu.addEventListener('click', (event) => {
  event.stopPropagation();
});

el.sessionConfigButton?.addEventListener('click', (event) => {
  event.stopPropagation();
  openActiveSessionConfigDialog();
});

el.siteRegisterButton?.addEventListener('click', (event) => {
  event.stopPropagation();
  openSiteRegisterDialog();
});

el.closeSiteRegisterDialog?.addEventListener('click', closeSiteRegisterDialog);
el.sendLocalSitePrompt?.addEventListener('click', () => sendSiteRegisterPrompt('local'));
el.sendExternalSitePrompt?.addEventListener('click', () => sendSiteRegisterPrompt('external'));

el.topFilterButton.addEventListener('click', (event) => {
  event.stopPropagation();
  setTopFilterMenu(el.topFilterMenu.hidden);
});

el.topFilterMenu.addEventListener('click', (event) => {
  event.stopPropagation();
});

el.favoritesButton.addEventListener('click', () => {
  state.showStarredOnly = !state.showStarredOnly;
  storageSet('cmc.showStarredOnly', state.showStarredOnly ? '1' : '0');
  closeTopFilterMenu();
  renderActive();
});

el.messageDisplayButton.addEventListener('click', () => {
  state.messageDisplayMode = state.messageDisplayMode === 'brief' ? 'full' : 'brief';
  storageSet('cmc.messageDisplayMode', state.messageDisplayMode);
  closeTopFilterMenu();
  updateMessageDisplayButton();
  renderActive({ stickToBottom: shouldFollowNewMessage(state.activeId) });
});

el.shareCaptureButton?.addEventListener('click', async () => {
  closeTopMoreMenu();
  if (!allShareableMessages().length && state.activeId) {
    await loadSession(state.activeId, { full: true, showLoading: false });
  }
  if (!allShareableMessages().length) {
    alert('当前会话还没有可分享的消息。');
    return;
  }
  state.shareMode = true;
  if (!state.shareSelectedKeys.size) selectRecentShareMessages(4);
  else renderActive({ stickToBottom: false });
});

el.smartTagSessionsButton?.addEventListener('click', inferSessionTags);

el.collapseMessagesButton.addEventListener('click', () => {
  setAllConversationMessagesCollapsed(true);
});

el.expandMessagesButton.addEventListener('click', () => {
  setAllConversationMessagesCollapsed(false);
});

el.installAppSettingsButton?.addEventListener('click', installAppToHomeScreen);

el.attachmentButton.addEventListener('click', (event) => {
  event.stopPropagation();
  closeTopMenus();
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
  const payload = {
    title: form.get('title'),
    cwd: form.get('cwd'),
    ...runConfigFromForm(el.newSessionForm)
  };
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
el.closeTaskDetailDialog?.addEventListener('click', closeTaskDetailDialog);
el.drawerSessionsButton.addEventListener('click', () => setDrawerPanel('sessions'));
el.newSessionButton.addEventListener('click', () => {
  applyRunConfigToForm(el.newSessionForm, state.defaultRunConfig);
  openModal(el.dialog);
});
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
el.refreshCodexConfigButton?.addEventListener('click', loadCodexConfigSummary);
el.runtimeButton.addEventListener('click', () => {
  closeTopMenus();
  openRuntimeDialog();
});
el.closeRuntimeDialog.addEventListener('click', closeRuntimeDialog);
el.cancelSessionConfig?.addEventListener('click', () => closeModal(el.sessionConfigDialog));
el.sessionConfigForm?.addEventListener('submit', saveSessionConfig);
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
  } else if (page === 'run') {
    updateRunSettingsState();
    loadCodexConfigSummary();
  } else if (page === 'maintenance') {
    loadMaintenancePage().catch((error) => {
      if (el.systemHealthPanel) el.systemHealthPanel.textContent = error.message || '加载失败';
      if (el.tagManagementPanel) el.tagManagementPanel.textContent = error.message || '加载失败';
    });
  }
}

for (const tab of el.settingsTabs) {
  tab.addEventListener('click', () => selectSettingsPage(tab.dataset.settingsTab));
}
[
  el.defaultProfileInput,
  el.defaultSandboxSelect,
  el.defaultApprovalSelect,
  el.defaultReasoningEffortSelect,
  el.defaultAddDirsInput,
  el.defaultConfigOverridesInput,
  el.defaultStrictConfigToggle,
  el.defaultIgnoreUserConfigToggle,
  el.defaultIgnoreRulesToggle
].filter(Boolean).forEach((node) => {
  node.addEventListener('change', saveDefaultRunConfig);
  if (node.tagName === 'TEXTAREA' || node.tagName === 'INPUT') node.addEventListener('input', saveDefaultRunConfig);
});
bindModelControl(el.defaultModelSelect, el.defaultModelCustomInput, saveDefaultRunConfig);
bindModelControl(el.newSessionForm?.elements.model, el.newSessionForm?.elements.modelCustom);
bindModelControl(el.sessionConfigForm?.elements.model, el.sessionConfigForm?.elements.modelCustom);
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
el.refreshHealthButton?.addEventListener('click', () => loadSystemHealth().catch((error) => {
  el.systemHealthPanel.textContent = error.detail || error.message || '刷新失败';
}));
el.checkAppUpdateButton?.addEventListener('click', () => checkAppUpdate().catch((error) => {
  el.appUpdatePanel.textContent = error.detail || error.message || '检查失败';
}));
el.updateAppButton?.addEventListener('click', () => updateApp().catch((error) => {
  el.appUpdatePanel.textContent = error.detail || error.message || '升级启动失败';
}));
el.rollbackAppButton?.addEventListener('click', () => rollbackApp().catch((error) => {
  el.appUpdatePanel.textContent = error.detail || error.message || '回滚启动失败';
}));
el.checkCodexUpgradeButton?.addEventListener('click', () => checkCodexUpgrade().catch((error) => {
  el.codexUpgradePanel.textContent = error.detail || error.message || '检查失败';
}));
el.upgradeCodexButton?.addEventListener('click', () => upgradeCodex().catch((error) => {
  el.codexUpgradePanel.textContent = error.detail || error.message || '升级启动失败';
}));
el.refreshTagsButton?.addEventListener('click', () => loadTagManagement().catch((error) => {
  el.tagManagementPanel.textContent = error.detail || error.message || '刷新失败';
}));
el.undoSmartTagsButton?.addEventListener('click', () => undoSmartTags().catch((error) => {
  el.tagManagementPanel.textContent = error.detail || error.message || '撤销失败';
}));
el.closeImageViewer.addEventListener('click', closeImageViewer);
el.imageViewer.addEventListener('click', (event) => {
  if (event.target === el.imageViewer) closeImageViewer();
});
el.closeSharePreview?.addEventListener('click', closeSharePreview);
el.copyShareImage?.addEventListener('click', () => copyShareImage().catch((error) => {
  el.sharePreviewState.textContent = error.message || '复制失败';
}));
el.downloadShareImage?.addEventListener('click', downloadShareImage);
el.sharePreviewDialog?.addEventListener('close', () => {
  el.sharePreviewBody.innerHTML = '';
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
      button.className = `directory-item${entry.symlink ? ' symlink' : ''}`;
      button.textContent = entry.symlink ? `↪ ${entry.name}` : entry.name;
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
