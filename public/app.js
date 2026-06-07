const storedExpandedCwds = (() => {
  try {
    const value = JSON.parse(localStorage.getItem('cmc.expandedCwds') || '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
})();

const state = {
  sessions: [],
  activeId: localStorage.getItem('cmc.activeId') || '',
  sessionViewMode: localStorage.getItem('cmc.sessionViewMode') || 'recent',
  theme: localStorage.getItem('cmc.theme') || 'graphite',
  historyLimit: localStorage.getItem('cmc.historyLimit') || '500',
  elevated: localStorage.getItem('cmc.elevated') === '1',
  directoryPath: '/root/Projects',
  expandedCwds: new Set(storedExpandedCwds),
  messages: new Map(),
  lastSeq: new Map(),
  eventSource: null,
  contextRefreshTimer: null,
  contextRefreshInFlight: false,
  online: navigator.onLine
};

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
  sessionList: document.querySelector('#sessionList'),
  newSessionButton: document.querySelector('#newSessionButton'),
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
  elevatedRun: document.querySelector('#elevatedRun'),
  stopButton: document.querySelector('#stopButton'),
  sendButton: document.querySelector('#sendButton'),
  themeSelect: document.querySelector('#themeSelect'),
  historyLimitInput: document.querySelector('#historyLimitInput'),
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
  commandDialog: document.querySelector('#commandDialog'),
  closeCommandDialog: document.querySelector('#closeCommandDialog'),
  commandList: document.querySelector('#commandList')
};

applyTheme(state.theme);
el.themeSelect.value = state.theme;
el.historyLimitInput.value = state.historyLimit;
el.elevatedRun.checked = state.elevated;
el.sessionViewMode.value = state.sessionViewMode;

function cacheKey(id) {
  return `cmc.messages.${id}`;
}

function saveSessionCache() {
  localStorage.setItem('cmc.sessions', JSON.stringify(state.sessions));
}

function saveExpandedCwds() {
  localStorage.setItem('cmc.expandedCwds', JSON.stringify([...state.expandedCwds]));
}

function loadCachedSessions() {
  try {
    state.sessions = JSON.parse(localStorage.getItem('cmc.sessions') || '[]');
  } catch {
    state.sessions = [];
  }
}

function saveMessages(id) {
  localStorage.setItem(cacheKey(id), JSON.stringify(state.messages.get(id) || []));
}

function loadMessages(id) {
  if (state.messages.has(id)) return state.messages.get(id);
  try {
    const messages = JSON.parse(localStorage.getItem(cacheKey(id)) || '[]');
    state.messages.set(id, messages);
    state.lastSeq.set(id, Math.max(0, ...messages.map((m) => m.seq || 0)));
    return messages;
  } catch {
    state.messages.set(id, []);
    state.lastSeq.set(id, 0);
    return [];
  }
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
    throw error;
  }
  return data;
}

function setAuthView(isAuthed) {
  el.loginView.hidden = isAuthed;
  el.appView.hidden = !isAuthed;
}

function setDrawer(open) {
  el.sessionDrawer.classList.toggle('open', open);
  el.drawerScrim.hidden = !open;
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
  el.connectionBadge.textContent = text;
  el.connectionBadge.className = `connection-badge ${mode}`.trim();
}

function formatTime(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  return date.toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit', month: 'numeric', day: 'numeric' });
}

function renderSessions() {
  el.sessionList.innerHTML = '';

  const sessions = [...state.sessions].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  const visible = state.sessionViewMode === 'recent' ? sessions.slice(0, 20) : sessions;

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
      el.sessionList.append(section);
    }
    return;
  }

  for (const session of visible) el.sessionList.append(renderSessionButton(session));
}

function renderSessionButton(session) {
  const row = document.createElement('div');
  row.className = 'session-entry';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = `session-item ${session.id === state.activeId ? 'active' : ''} ${session.source === 'codex' ? 'external' : ''}`.trim();
  button.innerHTML = `
    <strong>${escapeHtml(session.title)}</strong>
    <span>${escapeHtml(session.source === 'codex' ? '全局 Codex' : session.status || 'idle')} · ${escapeHtml(formatTime(session.updatedAt))}</span>
    <span>${escapeHtml(session.cwd || '')}</span>
  `;
  button.addEventListener('click', () => selectSession(session.id));

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

  row.append(button, renameButton, deleteButton);
  return row;
}

function renderActive() {
  const session = state.sessions.find((item) => item.id === state.activeId);
  const isRunning = session && (session.status === 'running' || session.status === 'stopping');
  el.emptyState.hidden = Boolean(session);
  el.messagePane.hidden = !session;
  el.promptInput.disabled = !session;
  el.sendButton.disabled = !session || isRunning;
  el.stopButton.hidden = !isRunning;
  el.stopButton.disabled = !session || session.status === 'stopping';

  if (!session) {
    el.activeTitle.textContent = 'Codex Console';
    el.activeMeta.textContent = '未选择会话';
    setBadge(state.online ? '在线' : '离线', state.online ? 'online' : '');
    return;
  }

  el.activeTitle.textContent = session.title;
  el.activeMeta.textContent = session.cwd || '';
  setBadge(isRunning ? session.status === 'stopping' ? '停止中' : '运行中' : state.online ? '在线' : '离线', isRunning ? 'running' : state.online ? 'online' : '');
  renderMessages(session.id);
}

function getActiveSession() {
  return state.sessions.find((item) => item.id === state.activeId);
}

function renderMessages(sessionId) {
  const messages = loadMessages(sessionId);
  el.messagePane.innerHTML = '';
  for (const message of messages) {
    el.messagePane.append(renderMessage(message));
  }
  requestAnimationFrame(() => {
    el.messagePane.scrollTop = el.messagePane.scrollHeight;
  });
}

function renderMessage(message) {
  const article = document.createElement('article');
  article.className = `message ${message.role || 'system'}`;
  article.dataset.seq = message.seq || '';
  const role = message.role || 'system';
  const collapsible = isCollapsibleMessage(message);
  const defaultCollapsed = isDefaultCollapsedMessage(message);
  const actions = role === 'assistant' ? extractOptionActions(message.text || '') : [];
  article.innerHTML = `
    <div class="message-head">
      <span>${escapeHtml(role)}</span>
      <span>${escapeHtml(formatTime(message.at))}</span>
    </div>
    <div class="message-summary">${escapeHtml(summarizeMessage(message))}</div>
    <pre class="message-text">${escapeHtml(message.text || '')}</pre>
  `;
  if (collapsible) {
    article.classList.toggle('collapsed', defaultCollapsed);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'message-toggle';
    button.textContent = defaultCollapsed ? '展开' : '折叠';
    button.addEventListener('click', () => {
      const collapsed = article.classList.toggle('collapsed');
      button.textContent = collapsed ? '展开' : '折叠';
    });
    article.querySelector('.message-head').append(button);
  }
  if (actions.length) {
    const actionWrap = document.createElement('div');
    actionWrap.className = 'option-actions';
    for (const action of actions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'option-button';
      button.textContent = action.label;
      button.addEventListener('click', () => sendPrompt(action.value));
      actionWrap.append(button);
    }
    article.append(actionWrap);
  }
  if (role === 'user') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'message-edit-icon';
    button.textContent = '✏️';
    button.setAttribute('aria-label', '重新编辑这条输入');
    button.addEventListener('click', () => editPrompt(message.text || '', message.elevated === true));
    article.append(button);
  }
  return article;
}

function renderCommandList() {
  el.commandList.innerHTML = '';
  for (const command of CODEX_COMMANDS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'command-item';
    button.innerHTML = `
      <strong>${escapeHtml(command.name)}</strong>
      <span>${escapeHtml(command.detail)}</span>
    `;
    button.addEventListener('click', () => {
      el.promptInput.value = command.value;
      autoSizePrompt();
      closeModal(el.commandDialog);
      el.promptInput.focus();
    });
    el.commandList.append(button);
  }
}

function isCollapsibleMessage(message) {
  return ['user', 'assistant', 'tool'].includes(message.role || '');
}

function isDefaultCollapsedMessage(message) {
  const text = String(message.text || '');
  return message.role === 'tool' || text.includes('```') || text.length > 3000;
}

function summarizeMessage(message) {
  const text = String(message.text || '').replaceAll('```', '').trim();
  const firstLine = text.split('\n').map((line) => line.trim()).find(Boolean) || '(空消息)';
  const prefix = message.role === 'tool' ? '工具' : message.role === 'user' ? '输入' : '输出';
  const clipped = firstLine.length > 120 ? `${firstLine.slice(0, 120)}...` : firstLine;
  return `${prefix} · ${clipped}`;
}

function extractOptionActions(text) {
  const actions = [];
  const seen = new Set();
  const lines = String(text).split('\n');
  for (const line of lines) {
    const match = line.trim().match(/^(?:选项\s*)?([1-9][0-9]?|[A-Za-z])[\.\)、:：]\s*(.{2,80})$/);
    if (!match) continue;
    const key = match[1];
    const label = `${key}. ${match[2].trim()}`;
    if (seen.has(label)) continue;
    seen.add(label);
    actions.push({ label, value: key });
    if (actions.length >= 6) break;
  }
  return actions;
}

function upsertMessage(sessionId, message) {
  const messages = loadMessages(sessionId);
  if (messages.some((item) => item.seq === message.seq)) return;
  messages.push(message);
  messages.sort((a, b) => (a.seq || 0) - (b.seq || 0));
  state.lastSeq.set(sessionId, Math.max(state.lastSeq.get(sessionId) || 0, message.seq || 0));
  saveMessages(sessionId);

  if (message.status) {
    state.sessions = state.sessions.map((item) => item.id === sessionId ? { ...item, status: message.status, updatedAt: message.at || item.updatedAt } : item);
    saveSessionCache();
    renderSessions();
  }

  if (sessionId === state.activeId) {
    el.messagePane.append(renderMessage(message));
    el.messagePane.scrollTop = el.messagePane.scrollHeight;
    renderActive();
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

async function refreshSessions() {
  try {
    const data = await api('/api/sessions');
    state.sessions = data.sessions || [];
    saveSessionCache();
    const firstWebSession = state.sessions.find((item) => item.source !== 'codex');
    if (!state.activeId && firstWebSession) state.activeId = firstWebSession.id;
    if (state.activeId && !state.sessions.some((item) => item.id === state.activeId)) {
      state.activeId = firstWebSession?.id || '';
    }
    localStorage.setItem('cmc.activeId', state.activeId);
    renderSessions();
    renderActive();
    if (state.activeId) await loadSession(state.activeId);
  } catch (error) {
    if (error.status === 401) throw error;
    loadCachedSessions();
    renderSessions();
    renderActive();
  }
}

window.cmcAfterLogin = async function cmcAfterLogin() {
  setAuthView(true);
  await refreshSessions();
};

async function loadSession(id) {
  try {
    const data = await api(`/api/sessions/${id}?limit=${encodeURIComponent(state.historyLimit)}`);
    const session = data.session;
    state.sessions = state.sessions.map((item) => item.id === id ? session : item);
    state.messages.set(id, data.messages || []);
    state.lastSeq.set(id, Math.max(0, ...(data.messages || []).map((m) => m.seq || 0)));
    saveSessionCache();
    saveMessages(id);
    renderSessions();
    renderActive();
    connectEvents(id);
    startContextRefreshLoop();
  } catch {
    loadMessages(id);
    renderActive();
    connectEvents(id);
    startContextRefreshLoop();
  }
}

async function refreshActiveContext() {
  const session = getActiveSession();
  if (!session?.codexSessionId || !state.online || state.contextRefreshInFlight) return;
  state.contextRefreshInFlight = true;
  try {
    const data = await api(`/api/sessions/${session.id}?limit=${encodeURIComponent(state.historyLimit)}`);
    const nextMessages = data.messages || [];
    const currentMessages = loadMessages(session.id);
    const currentLast = currentMessages.at(-1);
    const nextLast = nextMessages.at(-1);
    const changed = currentMessages.length !== nextMessages.length
      || currentLast?.at !== nextLast?.at
      || currentLast?.text !== nextLast?.text;
    state.sessions = state.sessions.map((item) => item.id === session.id ? data.session : item);
    if (changed) {
      state.messages.set(session.id, nextMessages);
      state.lastSeq.set(session.id, Math.max(0, ...nextMessages.map((m) => m.seq || 0)));
      saveSessionCache();
      saveMessages(session.id);
      if (state.activeId === session.id) {
        renderSessions();
        renderActive();
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

  source.addEventListener('hello', () => {
    state.online = true;
    renderActive();
  });

  source.addEventListener('message', (event) => {
    upsertMessage(id, JSON.parse(event.data));
  });

  source.onerror = () => {
    source.close();
    if (state.eventSource === source) state.eventSource = null;
    setBadge('重连中');
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
  state.activeId = id;
  localStorage.setItem('cmc.activeId', id);
  setDrawer(false);
  renderSessions();
  renderActive();
  await loadSession(id);
}

async function importExternalSession(codexSessionId) {
  try {
    const data = await api('/api/codex-sessions/import', {
      method: 'POST',
      body: JSON.stringify({ codexSessionId })
    });
    state.sessions = state.sessions.filter((item) => item.codexSessionId !== codexSessionId || item.source !== 'codex');
    state.sessions.unshift(data.session);
    state.activeId = data.session.id;
    localStorage.setItem('cmc.activeId', state.activeId);
    saveSessionCache();
    setDrawer(false);
    renderSessions();
    await loadSession(state.activeId);
  } catch (error) {
    alert(error.message || '导入失败');
  }
}

async function deleteSession(session) {
  const deletesCodex = Boolean(session.codexSessionId);
  const label = deletesCodex
    ? '真实删除这个 Codex 原始会话文件？这会从 /root/.codex/sessions 删除历史，无法从本应用恢复。'
    : '删除这个会话在本应用里的记录？';
  if (!confirm(label)) return;
  try {
    await api(`/api/sessions/${encodeURIComponent(session.id)}`, {
      method: 'DELETE',
      body: JSON.stringify({ deleteCodex: deletesCodex })
    });
    state.sessions = state.sessions.filter((item) => item.id !== session.id);
    if (state.activeId === session.id) {
      state.activeId = state.sessions.find((item) => item.source !== 'codex')?.id || '';
      localStorage.setItem('cmc.activeId', state.activeId);
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
    state.sessions = state.sessions.map((item) => item.id === session.id ? { ...item, ...(data.session || {}), title: nextTitle } : item);
    if (state.activeId === session.id) {
      el.activeTitle.textContent = nextTitle;
    }
    saveSessionCache();
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

async function sendPrompt(rawPrompt, opts = {}) {
  const prompt = String(rawPrompt || '').trim();
  if (!prompt || !state.activeId) return;
  if (!opts.keepInput) el.promptInput.value = '';
  autoSizePrompt();
  const elevated = Boolean(el.elevatedRun.checked);
  try {
    const data = await api(`/api/sessions/${state.activeId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ prompt, elevated })
    });
    state.sessions = state.sessions.map((item) => item.id === state.activeId ? data.session : item);
    renderSessions();
    renderActive();
  } catch (error) {
    upsertMessage(state.activeId, {
      seq: Date.now(),
      at: new Date().toISOString(),
      role: 'system',
      text: error.message || '发送失败'
    });
  }
}

async function stopCurrentRun() {
  if (!state.activeId) return;
  el.stopButton.disabled = true;
  try {
    const data = await api(`/api/sessions/${state.activeId}/stop`, { method: 'POST' });
    if (data.session) {
      state.sessions = state.sessions.map((item) => item.id === state.activeId ? data.session : item);
      renderSessions();
      renderActive();
    }
  } catch (error) {
    upsertMessage(state.activeId, {
      seq: Date.now(),
      at: new Date().toISOString(),
      role: 'system',
      text: error.message || '停止失败'
    });
  }
}

function editPrompt(text, elevated) {
  el.promptInput.value = text;
  el.elevatedRun.checked = Boolean(elevated);
  autoSizePrompt();
  el.promptInput.focus();
}

el.promptForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  await sendPrompt(el.promptInput.value);
});

el.promptInput.addEventListener('keydown', (event) => {
  if (event.isComposing || event.key !== 'Enter') return;
  autoSizePrompt();
});

el.stopButton.addEventListener('click', stopCurrentRun);

el.themeSelect.addEventListener('change', () => {
  state.theme = el.themeSelect.value;
  localStorage.setItem('cmc.theme', state.theme);
  applyTheme(state.theme);
});

el.historyLimitInput.addEventListener('change', async () => {
  const value = Math.max(0, Math.min(5000, Number(el.historyLimitInput.value || 500)));
  state.historyLimit = String(Number.isFinite(value) ? value : 500);
  el.historyLimitInput.value = state.historyLimit;
  localStorage.setItem('cmc.historyLimit', state.historyLimit);
  if (state.activeId) await loadSession(state.activeId);
});

el.elevatedRun.addEventListener('change', () => {
  state.elevated = el.elevatedRun.checked;
  localStorage.setItem('cmc.elevated', state.elevated ? '1' : '0');
});

el.sessionViewMode.addEventListener('change', () => {
  state.sessionViewMode = el.sessionViewMode.value;
  localStorage.setItem('cmc.sessionViewMode', state.sessionViewMode);
  renderSessions();
});

el.newSessionForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(el.newSessionForm);
  const payload = Object.fromEntries(form.entries());
  try {
    const data = await api('/api/sessions', { method: 'POST', body: JSON.stringify(payload) });
    state.sessions.unshift(data.session);
    state.activeId = data.session.id;
    localStorage.setItem('cmc.activeId', state.activeId);
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
el.newSessionButton.addEventListener('click', () => openModal(el.dialog));
el.commandButton.addEventListener('click', () => {
  renderCommandList();
  openModal(el.commandDialog);
});
el.closeCommandDialog.addEventListener('click', () => closeModal(el.commandDialog));
el.settingsButton.addEventListener('click', () => openModal(el.settingsDialog));
el.closeSettingsDialog.addEventListener('click', () => closeModal(el.settingsDialog));
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
  const maxHeight = Math.min(Math.round(window.innerHeight * 0.4), 320);
  el.promptInput.style.height = `${Math.min(el.promptInput.scrollHeight, maxHeight)}px`;
}

el.promptInput.addEventListener('input', autoSizePrompt);

window.addEventListener('online', () => {
  state.online = true;
  refreshSessions().catch(() => {});
  if (state.activeId) connectEvents(state.activeId);
  startContextRefreshLoop();
});

window.addEventListener('offline', () => {
  state.online = false;
  if (state.eventSource) state.eventSource.close();
  clearInterval(state.contextRefreshTimer);
  renderActive();
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshActiveContext();
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

async function boot() {
  loadCachedSessions();
  setAuthView(false);
  try {
    await api('/api/me');
    setAuthView(true);
    await refreshSessions();
  } catch {
    if (!navigator.onLine && state.sessions.length) {
      setAuthView(true);
      renderSessions();
      renderActive();
    } else {
      setAuthView(false);
    }
  }
}

boot();
