import { escapeHtml, summarizeText } from './format-utils.js?v=1';

export function createQueueView(actions) {
  function renderQueuePanel(session) {
    const panel = document.createElement('div');
    panel.className = 'queue-panel';
    panel.dataset.queuePanel = '1';
    panel.innerHTML = `<div class="queue-head"><strong>待执行 ${session.queue.length} 条</strong><span>点 ↪ 补当前会话</span></div>`;
    for (const item of session.queue || []) {
      panel.append(renderQueueItem(item));
    }
    return panel;
  }

  function renderQueueItem(item) {
    const row = document.createElement('div');
    row.className = 'queue-item';
    row.innerHTML = `
      <span>${escapeHtml(`${summarizeText(item.displayPrompt || item.prompt || '', 64)}${item.imageCount ? ` · 图片 ${item.imageCount}` : ''}`)}</span>
      <div class="queue-images"></div>
      <button class="queue-supplement-button" type="button" aria-label="把这条排队输入直接补充到当前会话" title="补充到当前会话">↪</button>
      <button class="queue-cancel-button" type="button" aria-label="取消这条排队输入">×</button>
    `;

    const imageWrap = row.querySelector('.queue-images');
    for (const image of item.images || []) {
      imageWrap.append(renderQueueImage(image));
    }
    row.querySelector('.queue-supplement-button').addEventListener('click', () => actions.supplementQueuedPrompt(item.id));
    row.querySelector('.queue-cancel-button').addEventListener('click', () => actions.cancelQueuedPrompt(item.id));
    return row;
  }

  function renderQueueImage(image) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'queue-image-button';
    button.setAttribute('aria-label', '查看排队图片');
    button.innerHTML = `<img src="${escapeHtml(image.url)}" alt="${escapeHtml(image.name || 'queued image')}">`;
    button.addEventListener('click', () => actions.openImageViewer(image.url, image.name || '排队图片'));
    return button;
  }

  return {
    renderQueuePanel
  };
}
