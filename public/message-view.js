import { escapeHtml, formatBytes, formatTime, summarizeText } from './format-utils.js?v=1';

export function createMessageView(actions) {
  function renderMessage(message, options = {}) {
    const article = document.createElement('article');
    article.className = `message ${message.role || 'system'}`;
    if (message.variant) article.classList.add(message.variant);
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
    const savedCollapsed = message.role === 'tool' ? true : actions.getMessageCollapsed?.(message);
    const defaultCollapsed = typeof savedCollapsed === 'boolean' ? savedCollapsed : isDefaultCollapsedMessage(message);
    const deferredText = collapsible && defaultCollapsed;
    article.innerHTML = `
      <div class="message-head">
        <span>${escapeHtml(role)}</span>
        <span>${escapeHtml(formatTime(message.at))}</span>
      </div>
      <div class="message-summary">${escapeHtml(summarizeMessage(message))}</div>
      <div class="message-text"${deferredText ? '' : ' data-loaded="1"'}></div>
    `;
    if (!deferredText) renderMarkdownText(article.querySelector('.message-text'), message.text || '');

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
          renderMarkdownText(textNode, message.text || '');
          textNode.dataset.loaded = '1';
        }
        button.textContent = collapsed ? '▸' : '▾';
        button.setAttribute('aria-label', collapsed ? '展开消息' : '折叠消息');
        actions.setMessageCollapsed?.(message, collapsed);
      });
      article.querySelector('.message-head').append(button);
    }

    if (message.images?.length) article.append(renderMessageImages(message.images));
    if (message.files?.length) article.append(renderMessageFiles(message.files));
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

  function renderMessageFiles(files) {
    const wrap = document.createElement('div');
    wrap.className = 'message-files';
    for (const file of files) {
      const link = document.createElement('a');
      link.className = 'message-file';
      if (file.url) {
        link.href = file.url;
        link.target = '_blank';
        link.rel = 'noopener';
        link.download = file.name || '';
      } else {
        link.classList.add('pending');
        link.setAttribute('aria-disabled', 'true');
      }
      link.innerHTML = `
        <strong>${escapeHtml(summarizeText(file.name || '文件', 42))}</strong>
        <span>${escapeHtml(formatBytes(file.size || 0))}</span>
      `;
      wrap.append(link);
    }
    return wrap;
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
  if (stateLabel === 'merged') return '已合并';
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

function renderMarkdownText(container, text) {
  if (!container) return;
  container.textContent = '';
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(/^\s*```([\w-]*)\s*$/);
    if (fence) {
      const codeLines = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      container.append(renderCodeBlock(codeLines.join('\n'), fence[1] || ''));
      continue;
    }

    if (isTableStart(lines, index)) {
      const tableLines = [lines[index], lines[index + 1]];
      index += 2;
      while (index < lines.length && isTableRow(lines[index])) {
        tableLines.push(lines[index]);
        index += 1;
      }
      container.append(renderTable(tableLines));
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      const level = Math.min(4, heading[1].length);
      const node = document.createElement(`h${level + 2}`);
      appendInlineMarkdown(node, heading[2].trim());
      container.append(node);
      index += 1;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quote = document.createElement('blockquote');
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        appendInlineMarkdown(quote, lines[index].replace(/^\s*>\s?/, ''));
        quote.append(document.createElement('br'));
        index += 1;
      }
      quote.lastChild?.remove();
      container.append(quote);
      continue;
    }

    const listMatch = line.match(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/);
    if (listMatch) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const list = document.createElement(ordered ? 'ol' : 'ul');
      while (index < lines.length && /^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(lines[index]) === true && (/^\s*\d+[.)]\s+/.test(lines[index]) === ordered)) {
        const item = document.createElement('li');
        appendInlineMarkdown(item, lines[index].replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, ''));
        list.append(item);
        index += 1;
      }
      container.append(list);
      continue;
    }

    const paragraphLines = [];
    while (index < lines.length
      && lines[index].trim()
      && !/^\s*```/.test(lines[index])
      && !isTableStart(lines, index)
      && !/^(#{1,4})\s+/.test(lines[index])
      && !/^\s*>\s?/.test(lines[index])
      && !/^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(lines[index])) {
      paragraphLines.push(lines[index]);
      index += 1;
    }
    const paragraph = document.createElement('p');
    paragraphLines.forEach((part, partIndex) => {
      if (partIndex) paragraph.append(document.createElement('br'));
      appendInlineMarkdown(paragraph, part);
    });
    container.append(paragraph);
  }
}

function appendInlineMarkdown(container, text) {
  const value = String(text || '');
  const pattern = /(\*\*[^*\n][\s\S]*?\*\*|`[^`\n]+`|\[[^\]\n]+]\((https?:\/\/[^\s)]+|\/api\/uploads\/[^)\s]+)\)|https?:\/\/[^\s<>"'`]+|\/api\/uploads\/[A-Za-z0-9%_.~!$&()*+,;=:@/-]+)/gi;
  let lastIndex = 0;
  for (const match of value.matchAll(pattern)) {
    const token = match[0];
    const start = match.index || 0;
    if (start > lastIndex) container.append(document.createTextNode(value.slice(lastIndex, start)));

    const linkMatch = token.match(/^\[([^\]\n]+)]\((.+)\)$/);
    if (linkMatch) {
      container.append(createLink(linkMatch[2], linkMatch[1]));
    } else if (token.startsWith('**') && token.endsWith('**')) {
      const strong = document.createElement('strong');
      strong.textContent = token.slice(2, -2);
      container.append(strong);
    } else if (token.startsWith('`') && token.endsWith('`')) {
      const code = document.createElement('code');
      code.textContent = token.slice(1, -1);
      container.append(code);
    } else {
      const { href, label, suffix } = normalizeLink(token);
      container.append(createLink(href, label));
      if (suffix) container.append(document.createTextNode(suffix));
    }
    lastIndex = start + token.length;
  }
  if (lastIndex < value.length) container.append(document.createTextNode(value.slice(lastIndex)));
}

function createLink(href, label) {
  const safeHref = String(href || '');
  const link = document.createElement('a');
  link.href = safeHref;
  link.textContent = label || safeHref;
  link.target = '_blank';
  link.rel = 'noopener';
  return link;
}

function renderCodeBlock(code, language) {
  const pre = document.createElement('pre');
  const node = document.createElement('code');
  if (language) node.dataset.lang = language;
  node.textContent = code;
  pre.append(node);
  return pre;
}

function renderTable(lines) {
  const wrap = document.createElement('div');
  wrap.className = 'message-table-wrap';
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const tbody = document.createElement('tbody');
  const header = document.createElement('tr');
  for (const cell of splitTableRow(lines[0])) {
    const th = document.createElement('th');
    appendInlineMarkdown(th, cell);
    header.append(th);
  }
  thead.append(header);
  for (const rowLine of lines.slice(2)) {
    const row = document.createElement('tr');
    for (const cell of splitTableRow(rowLine)) {
      const td = document.createElement('td');
      appendInlineMarkdown(td, cell);
      row.append(td);
    }
    tbody.append(row);
  }
  table.append(thead, tbody);
  wrap.append(table);
  return wrap;
}

function splitTableRow(line) {
  return String(line || '')
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function isTableStart(lines, index) {
  return isTableRow(lines[index]) && isTableSeparator(lines[index + 1]);
}

function isTableRow(line) {
  return String(line || '').includes('|');
}

function isTableSeparator(line) {
  const cells = splitTableRow(line);
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function normalizeLink(raw) {
  let label = String(raw || '');
  let suffix = '';
  while (label && /[.,;:!?，。；：！？）\])]/.test(label.at(-1))) {
    suffix = label.at(-1) + suffix;
    label = label.slice(0, -1);
  }
  return {
    href: label.startsWith('/api/uploads/') ? label : label,
    label,
    suffix
  };
}
