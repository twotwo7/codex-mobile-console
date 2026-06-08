import { escapeHtml, formatTime } from './format-utils.js?v=1';

export function createSkillView({ commands, el, getSkills, insertPromptText, openModal, closeModal }) {
  function renderCommandList() {
    el.commandList.innerHTML = '';
    for (const command of commands) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'command-item';
      button.innerHTML = `
        <strong>${escapeHtml(command.name)}</strong>
        <span>${escapeHtml(command.detail)}</span>
      `;
      button.addEventListener('click', () => {
        el.promptInput.value = command.value;
        el.promptInput.dispatchEvent(new Event('input', { bubbles: true }));
        closeModal(el.commandDialog);
        el.promptInput.focus();
      });
      el.commandList.append(button);
    }
  }

  function filteredSkills(queryValue) {
    const query = String(queryValue || '').trim().toLowerCase();
    return getSkills().filter((skill) => {
      const summaryText = [
        skill.summary?.title,
        skill.summary?.overview,
        ...(skill.summary?.bullets || [])
      ].filter(Boolean).join(' ');
      const haystack = `${skill.name} ${skill.title} ${skill.description} ${skill.source} ${summaryText}`.toLowerCase();
      return !query || haystack.includes(query);
    });
  }

  function renderSkillListInto(list, skills, onSelect) {
    list.innerHTML = '';
    if (!skills.length) {
      list.innerHTML = '<p class="skill-empty">没有匹配的 skill</p>';
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const skill of skills) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'skill-item';
      const summary = skill.summary?.overview || skill.description || skill.shortDescription || skill.title || '暂无说明';
      const status = skill.summaryStatus === 'ready' ? '已总结' : skill.source || '';
      item.innerHTML = `
        <span class="skill-row"><strong>$${escapeHtml(skill.name)}</strong><em>${escapeHtml(status)}</em></span>
        <span>${escapeHtml(summary)}</span>
      `;
      item.addEventListener('click', () => onSelect(skill));
      fragment.append(item);
    }
    list.append(fragment);
  }

  function renderSkillList() {
    renderSkillListInto(el.skillList, filteredSkills(el.skillSearch.value), (skill) => {
      insertPromptText(`$${skill.name} `);
      closeModal(el.skillDialog);
    });
  }

  function renderDrawerSkillList() {
    renderSkillListInto(el.drawerSkillList, filteredSkills(el.drawerSkillSearch.value), openSkillDetail);
  }

  function renderSkillViews() {
    renderSkillList();
    renderDrawerSkillList();
  }

  function renderSkillSummaryBlock(skill) {
    if (skill.summary && typeof skill.summary === 'object') {
      const bullets = Array.isArray(skill.summary.bullets) ? skill.summary.bullets : [];
      return `
        <section class="skill-detail-section">
          <h3>AI 中文总结</h3>
          <strong>${escapeHtml(skill.summary.title || skill.title || skill.name)}</strong>
          <p>${escapeHtml(skill.summary.overview || '暂无总结')}</p>
          ${bullets.length ? `<ul>${bullets.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : ''}
          <small>${escapeHtml(skill.summaryUpdatedAt ? `更新 ${formatTime(skill.summaryUpdatedAt)}` : '等待后台总结')}</small>
        </section>
      `;
    }
    return `
      <section class="skill-detail-section">
        <h3>AI 中文总结</h3>
        <p>${escapeHtml(skill.summaryStatus === 'pending' ? '等待后台异步总结。' : '暂无总结。')}</p>
      </section>
    `;
  }

  function openSkillDetail(skill) {
    if (!skill) return;
    el.skillDetailTitle.textContent = `$${skill.name}`;
    const nativeDescription = skill.description || skill.shortDescription || skill.title || '这个 skill 暂无原生介绍。';
    const status = skill.summaryStatus === 'ready'
      ? '已总结'
      : skill.summaryStatus === 'pending'
        ? '待总结'
        : skill.summaryStatus || '未知';
    el.skillDetailBody.innerHTML = `
      ${renderSkillSummaryBlock(skill)}
      <section class="skill-detail-section">
        <h3>原生介绍</h3>
        <p>${escapeHtml(nativeDescription)}</p>
      </section>
      <section class="skill-detail-section compact">
        <h3>版本信息</h3>
        <div class="skill-detail-grid">
          <span>来源</span><strong>${escapeHtml(skill.source || '-')}</strong>
          <span>状态</span><strong>${escapeHtml(status)}</strong>
          <span>更新</span><strong>${escapeHtml(formatTime(skill.updatedAt) || '-')}</strong>
          <span>Hash</span><strong>${escapeHtml(String(skill.hash || '').slice(0, 12) || '-')}</strong>
        </div>
      </section>
    `;
    openModal(el.skillDetailDialog);
  }

  function skillStatusText(data = {}) {
    const scanned = data.lastScanAt ? `扫描 ${formatTime(data.lastScanAt)}` : '尚未完成扫描';
    const scan = data.scanStatus && data.scanStatus !== 'idle' ? ` · ${data.scanStatus}` : '';
    const summary = data.summaryStatus && !['idle', 'disabled'].includes(data.summaryStatus) ? ` · 总结 ${data.summaryStatus}` : '';
    const count = Number.isFinite(Number(data.skills?.length)) ? ` · ${data.skills.length} 个` : '';
    const error = data.scanError || data.summaryError;
    return `${scanned}${count}${scan}${summary}${error ? ` · ${error}` : ''}`;
  }

  function renderSkillStatus(data = {}) {
    const text = skillStatusText(data);
    if (el.skillStatus) el.skillStatus.textContent = text;
    if (el.drawerSkillStatus) el.drawerSkillStatus.textContent = text;
  }

  return {
    renderCommandList,
    renderDrawerSkillList,
    renderSkillList,
    renderSkillStatus,
    renderSkillViews
  };
}
