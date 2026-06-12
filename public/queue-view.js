import { escapeHtml, formatBytes, summarizeText } from './format-utils.js?v=1';

export function createQueueView(actions) {
  const selectedIds = new Set();

  function renderQueuePanel(session) {
    const panel = document.createElement('div');
    panel.className = 'queue-panel';
    panel.dataset.queuePanel = '1';
    const queue = session.queue || [];
    const currentIds = new Set(queue.map(queueItemId));
    for (const id of [...selectedIds]) {
      if (!currentIds.has(id)) selectedIds.delete(id);
    }
    const canMerge = (session.queue || []).length > 1;
    panel.innerHTML = `
      <div class="queue-head">
        <strong>待执行 ${session.queue.length} 条</strong>
        <div class="queue-head-actions">
          <span data-queue-select-summary>等待当前任务结束后执行</span>
          ${canMerge ? '<button class="queue-merge-button" type="button" aria-label="合并队列输入" title="合并队列">合并</button>' : ''}
        </div>
      </div>
    `;
    panel.querySelector('.queue-merge-button')?.addEventListener('click', () => {
      const ids = selectedIds.size >= 2 ? [...selectedIds] : [];
      if (ids.length) selectedIds.clear();
      actions.mergeQueuedPrompts(ids);
    });
    for (const item of queue) {
      panel.append(renderQueueItem(item, panel, canMerge));
    }
    updateMergeState(panel, queue.length);
    return panel;
  }

  function queueItemId(item) {
    return item.id || item.clientMessageId || item.messageId || '';
  }

  function updateMergeState(panel, queueLength) {
    const selectedCount = selectedIds.size;
    const button = panel.querySelector('.queue-merge-button');
    const summary = panel.querySelector('[data-queue-select-summary]');
    if (summary) {
      summary.textContent = selectedCount
        ? `已选 ${selectedCount} 条，至少 2 条可合并`
        : '等待当前任务结束后执行';
    }
    if (button) {
      button.textContent = selectedCount === 1 ? '再选1条' : selectedCount >= 2 ? '合并选中' : '合并全部';
      button.disabled = selectedCount === 1 || queueLength < 2;
      button.title = selectedCount === 1 ? '至少选择 2 条才能合并' : selectedCount >= 2 ? '合并选中的排队输入' : '合并全部排队输入';
    }
  }

  function renderQueueItem(item, panel, canMerge) {
    const row = document.createElement('div');
    row.className = 'queue-item';
    if (!canMerge) row.classList.add('no-select');
    const id = queueItemId(item);
    const imageText = item.imageCount ? ` · 图片 ${item.imageCount}` : '';
    const fileText = item.fileCount ? ` · 文件 ${item.fileCount}` : '';
    row.innerHTML = `
      ${canMerge ? `<label class="queue-select" title="选择用于合并">
        <input type="checkbox" aria-label="选择这条排队输入用于合并" ${selectedIds.has(id) ? 'checked' : ''}>
      </label>` : ''}
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
    row.querySelector('.queue-select input')?.addEventListener('change', (event) => {
      if (event.target.checked) selectedIds.add(id);
      else selectedIds.delete(id);
      updateMergeState(panel, panel.querySelectorAll('.queue-item').length);
    });
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
