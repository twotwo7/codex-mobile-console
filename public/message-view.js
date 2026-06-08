import { escapeHtml, formatTime, summarizeText } from './format-utils.js?v=1';

export function createMessageView(actions) {
  function renderMessage(message, options = {}) {
    const article = document.createElement('article');
    article.className = `message ${message.role || 'system'}`;
    if (options.animate === false) article.classList.add('no-animate');
    if (message.streaming) article.classList.add('streaming');
    if (message.starred) article.classList.add('starred');
    article.dataset.seq = message.seq || '';
    article.dataset.messageId = message.id || '';
    if (message.ids) article.dataset.messageIds = message.ids.join(',');
    if (message.clientMessageId) article.dataset.clientMessageId = message.clientMessageId;
    if (message.pending) article.classList.add('pending');
    if (message.failed) article.classList.add('failed');

    const role = message.role || 'system';
    const collapsible = isCollapsibleMessage(message);
    const defaultCollapsed = isDefaultCollapsedMessage(message);
    const deferredText = collapsible && defaultCollapsed;
    const optionActions = role === 'assistant' ? extractOptionActions(message.text || '') : [];
    article.innerHTML = `
      <div class="message-head">
        <span>${escapeHtml(role)}</span>
        <span>${escapeHtml(formatTime(message.at))}</span>
      </div>
      <div class="message-summary">${escapeHtml(summarizeMessage(message))}</div>
      <pre class="message-text"${deferredText ? '' : ' data-loaded="1"'}>${deferredText ? '' : escapeHtml(message.text || '')}</pre>
    `;

    const delivery = deliveryLabel(message);
    if (delivery) {
      const status = document.createElement('span');
      status.className = `message-delivery ${message.failed ? 'failed' : message.pending ? 'pending' : message.runState || message.delivery || ''}`.trim();
      status.textContent = delivery;
      article.querySelector('.message-head').append(status);
    }

    const menu = renderMessageMenu(message);
    if (menu) article.querySelector('.message-head').append(menu);

    if (collapsible) {
      article.classList.toggle('collapsed', defaultCollapsed);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'message-toggle';
      button.textContent = defaultCollapsed ? '▸' : '▾';
      button.setAttribute('aria-label', defaultCollapsed ? '展开消息' : '折叠消息');
      button.addEventListener('click', () => {
        const collapsed = article.classList.toggle('collapsed');
        const textNode = article.querySelector('.message-text');
        if (!collapsed && textNode && !textNode.dataset.loaded) {
          textNode.textContent = message.text || '';
          textNode.dataset.loaded = '1';
        }
        button.textContent = collapsed ? '▸' : '▾';
        button.setAttribute('aria-label', collapsed ? '展开消息' : '折叠消息');
      });
      article.querySelector('.message-head').append(button);
    }

    if (message.images?.length) article.append(renderMessageImages(message.images));
    if (optionActions.length) article.append(renderOptionActions(optionActions));
    if (role === 'user') article.append(renderEditButton(message));
    return article;
  }

  function renderMessageImages(images) {
    const wrap = document.createElement('div');
    wrap.className = 'message-images';
    for (const image of images) {
      const link = document.createElement('button');
      link.type = 'button';
      link.setAttribute('aria-label', '查看图片');
      const img = document.createElement('img');
      img.src = image.url || image.dataUrl;
      img.alt = image.name || 'uploaded image';
      link.append(img);
      link.addEventListener('click', () => actions.openImageViewer(img.src, img.alt));
      wrap.append(link);
    }
    return wrap;
  }

  function renderOptionActions(optionActions) {
    const actionWrap = document.createElement('div');
    actionWrap.className = 'option-actions';
    for (const action of optionActions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'option-button';
      button.textContent = action.label;
      button.addEventListener('click', () => actions.sendPrompt(action.value));
      actionWrap.append(button);
    }
    return actionWrap;
  }

  function renderEditButton(message) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'message-edit-icon';
    button.textContent = '✏️';
    button.setAttribute('aria-label', '重新编辑这条输入');
    button.addEventListener('click', () => actions.editPrompt(message.text || '', message.elevated === true));
    return button;
  }

  function renderMessageMenu(message) {
    if (!message.text && !message.id && !message.ids?.length) return null;
    const wrap = document.createElement('div');
    wrap.className = 'message-menu';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'message-menu-button';
    button.textContent = '⋯';
    button.setAttribute('aria-label', '消息操作');
    if (message.starred) button.classList.add('starred');

    const popover = document.createElement('div');
    popover.className = 'message-menu-popover';
    popover.hidden = true;

    if (message.id || message.ids?.length) {
      const star = document.createElement('button');
      star.type = 'button';
      star.textContent = message.starred ? '取消收藏' : '收藏';
      star.addEventListener('click', () => {
        popover.hidden = true;
        actions.toggleStarred(message);
      });
      popover.append(star);
    }

    if (message.failed && message.role === 'user') {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.textContent = '重发';
      retry.addEventListener('click', () => {
        popover.hidden = true;
        actions.retryMessage(message);
      });
      popover.append(retry);
    }

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = '复制';
    copy.addEventListener('click', () => {
      popover.hidden = true;
      copyMessageText(message.text || '');
    });
    popover.append(copy);

    button.addEventListener('click', (event) => {
      event.stopPropagation();
      closeMessageMenus(wrap);
      const nextOpen = popover.hidden;
      popover.hidden = !nextOpen;
      wrap.classList.toggle('open', nextOpen);
      wrap.closest('.message')?.classList.toggle('menu-open', nextOpen);
    });
    wrap.append(button, popover);
    return wrap;
  }

  return {
    renderMessage,
    closeMessageMenus
  };
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
  const prefix = message.role === 'tool'
    ? `工具${message.groupCount > 1 ? `组 ${message.groupCount}` : ''}`
    : message.role === 'user' ? '输入' : '输出';
  const clipped = summarizeText(firstLine, 120);
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

function deliveryLabel(message) {
  if (message.failed) return '失败';
  if (message.pending) return '发送中';
  const stateLabel = message.runState || message.delivery;
  if (stateLabel === 'queued') return '已排队';
  if (stateLabel === 'submitted') return '已提交';
  if (stateLabel === 'running') return '运行中';
  if (stateLabel === 'stopping') return '停止中';
  if (stateLabel === 'completed') return '已完成';
  if (stateLabel === 'failed') return '失败';
  if (stateLabel === 'stopped') return '已停止';
  if (stateLabel === 'recovered') return '已恢复';
  if (stateLabel === 'supplement') return '已补充';
  if (stateLabel === 'sent') return '已发送';
  return '';
}

function closeMessageMenus(except) {
  for (const menu of document.querySelectorAll('.message-menu')) {
    if (menu === except) continue;
    const popover = menu.querySelector('.message-menu-popover');
    if (popover) popover.hidden = true;
    menu.classList.remove('open');
    menu.closest('.message')?.classList.remove('menu-open');
  }
}

async function copyMessageText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
}
