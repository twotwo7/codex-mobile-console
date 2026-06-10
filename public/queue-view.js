import { escapeHtml, formatBytes, summarizeText } from './format-utils.js?v=1';

export function createQueueView(actions) {
  function renderQueuePanel(session) {
    const panel = document.createElement('div');
    panel.className = 'queue-panel';
    panel.dataset.queuePanel = '1';
    const canMerge = (session.queue || []).length > 1;
    panel.innerHTML = `
      <div class="queue-head">
        <strong>待执行 ${session.queue.length} 条</strong>
        <div class="queue-head-actions">
          <span>等待当前任务结束后执行</span>
          ${canMerge ? '<button class="queue-merge-button" type="button" aria-label="合并所有剩余排队输入" title="合并队列">合并</button>' : ''}
        </div>
      </div>
    `;
    panel.querySelector('.queue-merge-button')?.addEventListener('click', () => actions.mergeQueuedPrompts());
    for (const item of session.queue || []) {
      panel.append(renderQueueItem(item));
    }
    return panel;
  }

  function renderQueueItem(item) {
    const row = document.createElement('div');
    row.className = 'queue-item';
    const imageText = item.imageCount ? ` · 图片 ${item.imageCount}` : '';
    const fileText = item.fileCount ? ` · 文件 ${item.fileCount}` : '';
    row.innerHTML = `
      <span>${escapeHtml(`${summarizeText(item.displayPrompt || item.prompt || '', 64)}${imageText}${fileText}`)}</span>
      <div class="queue-images"></div>
      <div class="queue-files"></div>
      <button class="queue-action-button" type="button" aria-label="置顶这条排队输入" title="置顶">↑</button>
      <button class="queue-action-button" type="button" aria-label="编辑这条排队输入" title="编辑">✎</button>
      <button class="queue-cancel-button" type="button" aria-label="取消这条排队输入">×</button>
    `;

    const imageWrap = row.querySelector('.queue-images');
    for (const image of item.images || []) {
      imageWrap.append(renderQueueImage(image));
    }
    const fileWrap = row.querySelector('.queue-files');
    for (const file of item.files || []) {
      fileWrap.append(renderQueueFile(file));
    }
    const [topButton, editButton] = row.querySelectorAll('.queue-action-button');
    topButton.addEventListener('click', () => actions.topQueuedPrompt(item.id));
    editButton.addEventListener('click', () => actions.editQueuedPrompt(item));
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

  function renderQueueFile(file) {
    const link = document.createElement('a');
    link.className = 'queue-file-link';
    link.href = file.url || '#';
    link.target = '_blank';
    link.rel = 'noopener';
    link.title = `${file.name || '文件'} · ${formatBytes(file.size || 0)}`;
    link.textContent = '📎';
    return link;
  }

  return {
    renderQueuePanel
  };
}
