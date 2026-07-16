const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

function elementFromNode(node) {
  if (!node) return null;
  return node.nodeType === ELEMENT_NODE ? node : node.parentElement;
}

function selectableRootFromNode(node, messagePane) {
  const element = elementFromNode(node);
  if (!element || !messagePane?.contains(element)) return null;
  const direct = element.closest('.message-text, .message-summary');
  if (direct && messagePane.contains(direct)) return direct;
  const message = element.closest('.message');
  if (!message || !messagePane.contains(message)) return null;
  return message.querySelector('.message-text[data-loaded="1"], .message-text, .message-summary');
}

function cleanupClipboardFragment(container) {
  container.querySelectorAll('button, input, textarea, select, .code-copy-button, .code-copy-hint').forEach((node) => node.remove());
  container.querySelectorAll('[class]').forEach((node) => node.removeAttribute('class'));
  container.querySelectorAll('[style], [data-loaded], [aria-label], [role]').forEach((node) => {
    node.removeAttribute('style');
    node.removeAttribute('data-loaded');
    node.removeAttribute('aria-label');
    node.removeAttribute('role');
  });
}

function clipboardTextFromFragment(container, documentRef) {
  const probe = documentRef.createElement('div');
  probe.style.position = 'fixed';
  probe.style.left = '-99999px';
  probe.style.top = '0';
  probe.style.width = '680px';
  probe.style.whiteSpace = 'normal';
  probe.append(container.cloneNode(true));
  documentRef.body.append(probe);
  const text = (probe.innerText || probe.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
  probe.remove();
  return text;
}

function normalizeMarkdownText(text) {
  return String(text || '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function markdownFromChildren(node, context = {}) {
  return [...(node.childNodes || [])].map((child) => markdownFromNode(child, context)).join('');
}

function markdownTable(table) {
  const rows = [...table.querySelectorAll('tr')].map((row) => [...row.children].map((cell) => normalizeMarkdownText(markdownFromChildren(cell)).replace(/\|/g, '\\|')));
  if (!rows.length) return '';
  const width = Math.max(...rows.map((row) => row.length));
  const fill = (row) => [...row, ...Array(Math.max(0, width - row.length)).fill('')];
  const output = [
    `| ${fill(rows[0]).join(' | ')} |`,
    `| ${Array(width).fill('---').join(' | ')} |`
  ];
  for (const row of rows.slice(1)) output.push(`| ${fill(row).join(' | ')} |`);
  return `${output.join('\n')}\n\n`;
}

function markdownList(list, ordered) {
  return [...list.children]
    .filter((item) => item.tagName?.toLowerCase() === 'li')
    .map((item, index) => {
      const prefix = ordered ? `${index + 1}. ` : '- ';
      const body = normalizeMarkdownText(markdownFromChildren(item));
      return `${prefix}${body.replace(/\n/g, `\n${' '.repeat(prefix.length)}`)}`;
    })
    .join('\n') + '\n\n';
}

function markdownFromNode(node, context = {}) {
  if (!node) return '';
  if (node.nodeType === TEXT_NODE) return node.nodeValue || '';
  if (node.nodeType !== ELEMENT_NODE) return '';
  const tag = node.tagName.toLowerCase();
  if (tag === 'br') return '\n';
  if (tag === 'strong' || tag === 'b') return `**${markdownFromChildren(node, context).trim()}**`;
  if (tag === 'em' || tag === 'i') return `*${markdownFromChildren(node, context).trim()}*`;
  if (tag === 'code') return context.inPre ? node.textContent || '' : `\`${node.textContent || ''}\``;
  if (tag === 'pre') return `\`\`\`\n${node.textContent || ''}\n\`\`\`\n\n`;
  if (/^h[1-6]$/.test(tag)) return `${'#'.repeat(Number(tag.slice(1)))} ${normalizeMarkdownText(markdownFromChildren(node, context))}\n\n`;
  if (tag === 'p') return `${normalizeMarkdownText(markdownFromChildren(node, context))}\n\n`;
  if (tag === 'blockquote') {
    const text = normalizeMarkdownText(markdownFromChildren(node, context));
    return `${text.split('\n').map((line) => `> ${line}`).join('\n')}\n\n`;
  }
  if (tag === 'ul' || tag === 'ol') return markdownList(node, tag === 'ol');
  if (tag === 'table') return markdownTable(node);
  if (tag === 'a') {
    const href = node.getAttribute('href') || '';
    const label = normalizeMarkdownText(markdownFromChildren(node, context)) || href;
    return !href || href === label ? label : `[${label}](${href})`;
  }
  if (tag === 'img') return node.getAttribute('alt') || '';
  if (['thead', 'tbody', 'tr', 'th', 'td'].includes(tag)) return markdownFromChildren(node, context);
  const text = markdownFromChildren(node, context);
  return ['div', 'section', 'article'].includes(tag) ? `${normalizeMarkdownText(text)}\n\n` : text;
}

export function markdownTextFromFragment(container) {
  return normalizeMarkdownText(markdownFromChildren(container));
}

export function clipboardPayloadFromSelection(selection, root, documentRef = document) {
  if (!selection?.rangeCount || !root) return null;
  try {
    const scoped = selection.getRangeAt(0).cloneRange();
    if (!root.contains(scoped.startContainer)) scoped.setStart(root, 0);
    if (!root.contains(scoped.endContainer)) {
      if (root.lastChild) scoped.setEndAfter(root.lastChild);
      else scoped.setEnd(root, root.childNodes.length);
    }
    const wrap = documentRef.createElement('div');
    wrap.append(scoped.cloneContents());
    cleanupClipboardFragment(wrap);
    return {
      text: markdownTextFromFragment(wrap) || clipboardTextFromFragment(wrap, documentRef),
      html: wrap.innerHTML.trim()
    };
  } catch {
    return null;
  }
}

export function installMessageCopyGuard({ messagePane, documentRef = document, windowRef = window } = {}) {
  if (!messagePane || !documentRef?.addEventListener) return () => {};
  const handleCopy = (event) => {
    if (event.target?.closest?.('input, textarea, [contenteditable="true"]')) return;
    if (!event.clipboardData) return;
    const selection = windowRef.getSelection?.();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return;
    const root = selectableRootFromNode(selection.anchorNode, messagePane)
      || selectableRootFromNode(selection.focusNode, messagePane)
      || selectableRootFromNode(event.target, messagePane);
    if (!root) return;
    const payload = clipboardPayloadFromSelection(selection, root, documentRef);
    const text = payload?.text || (root.innerText || root.textContent || '').trim();
    if (!text) return;
    event.preventDefault();
    event.clipboardData.setData('text/plain', text);
    if (payload?.html) event.clipboardData.setData('text/html', payload.html);
  };
  documentRef.addEventListener('copy', handleCopy, true);
  return () => documentRef.removeEventListener('copy', handleCopy, true);
}
