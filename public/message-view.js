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
      const src = imageSource(image);
      const img = document.createElement('img');
      const fallback = document.createElement('span');
      fallback.className = 'message-image-fallback';
      fallback.textContent = src ? '图片加载失败' : '图片已失效';
      fallback.hidden = true;
      if (src) img.src = src;
      img.alt = image.name || 'uploaded image';
      img.addEventListener('error', () => {
        img.hidden = true;
        fallback.hidden = false;
        link.classList.add('failed');
      }, { once: true });
      if (!src) {
        img.hidden = true;
        fallback.hidden = false;
        link.classList.add('failed');
      }
      link.append(img, fallback);
      link.addEventListener('click', () => {
        if (!src || link.classList.contains('failed')) return;
        actions.openImageViewer(src, img.alt);
      });
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

    if (isRetryableUserMessage(message)) {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.textContent = message.failed ? '重发' : '重试';
      retry.addEventListener('click', () => {
        popover.hidden = true;
        actions.retryMessage(message);
      });
      popover.append(retry);
    }

    if (message.role === 'assistant' && actions.canApplyGoal?.(message)) {
      const applyGoal = document.createElement('button');
      applyGoal.type = 'button';
      applyGoal.textContent = '应用到任务面板';
      applyGoal.addEventListener('click', () => {
        popover.hidden = true;
        actions.applyGoalFromMessage?.(message);
      });
      popover.append(applyGoal);
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

function isRetryableUserMessage(message) {
  if (message.role !== 'user') return false;
  if (message.failed) return true;
  const stateLabel = message.runState || message.delivery;
  return ['failed', 'stopped', 'recovered'].includes(stateLabel);
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
  let index = 0;
  let pendingText = '';

  const flushText = () => {
    if (!pendingText) return;
    container.append(document.createTextNode(pendingText));
    pendingText = '';
  };

  while (index < value.length) {
    const strongEnd = value.startsWith('**', index) ? value.indexOf('**', index + 2) : -1;
    if (strongEnd > index + 2 && !value.slice(index + 2, strongEnd).includes('\n')) {
      flushText();
      const strong = document.createElement('strong');
      strong.textContent = value.slice(index + 2, strongEnd);
      container.append(strong);
      index = strongEnd + 2;
      continue;
    }

    const codeEnd = value[index] === '`' ? value.indexOf('`', index + 1) : -1;
    if (codeEnd > index + 1 && !value.slice(index + 1, codeEnd).includes('\n')) {
      flushText();
      const code = document.createElement('code');
      code.textContent = value.slice(index + 1, codeEnd);
      container.append(code);
      index = codeEnd + 1;
      continue;
    }

    const markdownLink = parseMarkdownLink(value, index);
    if (markdownLink) {
      flushText();
      container.append(createLink(markdownLink.href, markdownLink.label));
      index = markdownLink.end;
      continue;
    }

    const autoLink = parseAngleAutolink(value, index);
    if (autoLink) {
      flushText();
      container.append(createLink(autoLink.href, autoLink.href));
      index = autoLink.end;
      continue;
    }

    const bareLink = parseBareLink(value, index);
    if (bareLink) {
      flushText();
      container.append(createLink(bareLink.href, bareLink.label));
      if (bareLink.suffix) container.append(document.createTextNode(bareLink.suffix));
      index = bareLink.end;
      continue;
    }

    pendingText += value[index];
    index += 1;
  }
  flushText();
}

function createLink(href, label) {
  const safeHref = normalizeLinkHref(href);
  const link = document.createElement('a');
  link.href = safeHref;
  link.textContent = label || safeHref;
  link.target = '_blank';
  link.rel = 'noopener';
  return link;
}

function parseMarkdownLink(value, start) {
  if (value[start] !== '[') return null;
  const labelEnd = value.indexOf(']', start + 1);
  if (labelEnd <= start + 1 || value[labelEnd + 1] !== '(') return null;
  const label = value.slice(start + 1, labelEnd);
  let cursor = labelEnd + 2;
  let href = '';
  let end = -1;

  if (value[cursor] === '<') {
    const hrefEnd = value.indexOf('>', cursor + 1);
    if (hrefEnd < 0 || value[hrefEnd + 1] !== ')') return null;
    href = value.slice(cursor + 1, hrefEnd).trim();
    end = hrefEnd + 2;
  } else {
    const hrefStart = cursor;
    let depth = 0;
    for (; cursor < value.length; cursor += 1) {
      const char = value[cursor];
      if (char === '\n') return null;
      if (char === '(') {
        depth += 1;
        continue;
      }
      if (char === ')') {
        if (depth > 0) {
          depth -= 1;
          continue;
        }
        href = value.slice(hrefStart, cursor).trim();
        end = cursor + 1;
        break;
      }
    }
  }

  href = normalizeLinkHref(href);
  if (end < 0 || !isAllowedLink(href)) return null;
  return { end, href, label };
}

function parseAngleAutolink(value, start) {
  if (value[start] !== '<') return null;
  const end = value.indexOf('>', start + 1);
  if (end < 0) return null;
  const href = normalizeLinkHref(value.slice(start + 1, end).trim());
  if (!isAllowedLink(href)) return null;
  return { end: end + 1, href };
}

function parseBareLink(value, start) {
  const rest = value.slice(start);
  if (!/^https?:\/\//i.test(rest) && !rest.startsWith('/api/uploads/')) return null;
  let end = start;
  while (end < value.length && !/[\s<>"'`]/.test(value[end])) end += 1;
  const { href, label, suffix } = normalizeBareLink(value.slice(start, end));
  if (!isAllowedLink(href)) return null;
  return { end, href, label, suffix };
}

function renderCodeBlock(code, language) {
  const wrap = document.createElement('div');
  wrap.className = 'code-block-wrap';
  const pre = document.createElement('pre');
  const node = document.createElement('code');
  if (language) node.dataset.lang = language;
  node.textContent = code;
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'code-copy-button';
  copy.setAttribute('aria-label', '复制代码');
  copy.title = '复制代码';
  const hint = document.createElement('span');
  hint.className = 'code-copy-hint';
  hint.textContent = '已复制';
  hint.setAttribute('role', 'status');
  hint.setAttribute('aria-live', 'polite');
  copy.addEventListener('click', async () => {
    await copyMessageText(code);
    copy.classList.add('copied');
    hint.classList.add('show');
    copy.setAttribute('aria-label', '已复制');
    copy.title = '已复制';
    setTimeout(() => {
      copy.classList.remove('copied');
      hint.classList.remove('show');
      copy.setAttribute('aria-label', '复制代码');
      copy.title = '复制代码';
    }, 1200);
  });
  pre.append(node);
  wrap.append(pre, copy, hint);
  return wrap;
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

function normalizeBareLink(raw) {
  let label = normalizeLinkHref(raw);
  let suffix = '';
  while (label && shouldTrimLinkTail(label)) {
    suffix = label.at(-1) + suffix;
    label = label.slice(0, -1);
  }
  return {
    href: label.startsWith('/api/uploads/') ? label : label,
    label,
    suffix
  };
}

function normalizeLinkHref(value) {
  let href = String(value || '').trim();
  if (href.startsWith('<') && href.endsWith('>')) href = href.slice(1, -1).trim();
  return href;
}

function isAllowedLink(href) {
  return /^https?:\/\//i.test(href || '') || String(href || '').startsWith('/api/uploads/');
}

function shouldTrimLinkTail(value) {
  const char = value.at(-1);
  if (!char) return false;
  if (/[.,;:!?，。；：！？>]/.test(char)) return true;
  if (char === ')') return countChar(value, ')') > countChar(value, '(');
  if (char === ']') return countChar(value, ']') > countChar(value, '[');
  return false;
}

function countChar(value, char) {
  return [...String(value || '')].filter((item) => item === char).length;
}

function imageSource(image) {
  if (!image) return '';
  const direct = image.url || image.dataUrl || image.data;
  if (direct) return direct;
  const fileName = image.fileName || String(image.path || '').split('/').pop();
  if (!/^[a-f0-9-]+\.[a-z0-9]{1,12}$/i.test(fileName || '')) return '';
  return `/api/uploads/${encodeURIComponent(fileName)}`;
}
