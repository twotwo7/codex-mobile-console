import { createHash, randomUUID } from 'node:crypto';

export const SECRETARY_QUICK_TASKS = Object.freeze({
  focus: '检查长期记忆、当前项目和未完成任务，给出今天最值得推进的三件事，并立即开始执行第一件。',
  continue: '检查所有未完成任务、失败记录和阻塞项。自主选择当前价值最高的一项继续执行，直到得到可交付结果。',
  learn: '围绕当前目标研究最新且高质量的知识，核验来源，提炼可复用方法，并更新长期知识与技能记录。',
  audit: '检查最近的任务、工具调用和失败记录，修复可自动修复的问题，并给出精简运行报告。'
});

export const DEFAULT_SECRETARY_SETTINGS = Object.freeze({
  enabled: true,
  checkIntervalMinutes: 15,
  continuationIntervalMinutes: 30,
  learningIntervalHours: 8,
  dailyBriefTime: '08:30',
  dailyReviewTime: '21:30',
  quietStartTime: '23:30',
  quietEndTime: '07:30',
  timezone: 'Asia/Tokyo',
  maxAutonomousRunsPerDay: 24,
  proactiveLearning: true
});

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function normalizeClockTime(value, fallback) {
  const match = String(value || '').match(/^(\d{2}):(\d{2})$/);
  if (!match) return fallback;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return fallback;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function normalizeSecretarySettings(value = {}) {
  const defaults = DEFAULT_SECRETARY_SETTINGS;
  let timezone = String(value.timezone || defaults.timezone).trim().slice(0, 80);
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
  } catch {
    timezone = defaults.timezone;
  }
  return {
    enabled: value.enabled === undefined ? defaults.enabled : value.enabled === true,
    checkIntervalMinutes: clampInteger(value.checkIntervalMinutes, 1, 1440, defaults.checkIntervalMinutes),
    continuationIntervalMinutes: clampInteger(value.continuationIntervalMinutes, 5, 1440, defaults.continuationIntervalMinutes),
    learningIntervalHours: clampInteger(value.learningIntervalHours, 1, 168, defaults.learningIntervalHours),
    dailyBriefTime: normalizeClockTime(value.dailyBriefTime, defaults.dailyBriefTime),
    dailyReviewTime: normalizeClockTime(value.dailyReviewTime, defaults.dailyReviewTime),
    quietStartTime: normalizeClockTime(value.quietStartTime, defaults.quietStartTime),
    quietEndTime: normalizeClockTime(value.quietEndTime, defaults.quietEndTime),
    timezone,
    maxAutonomousRunsPerDay: clampInteger(value.maxAutonomousRunsPerDay, 0, 500, defaults.maxAutonomousRunsPerDay),
    proactiveLearning: value.proactiveLearning === undefined ? defaults.proactiveLearning : value.proactiveLearning === true
  };
}

function normalizeNotification(value = {}) {
  return {
    id: String(value.id || randomUUID()),
    at: String(value.at || new Date().toISOString()),
    type: String(value.type || 'info').slice(0, 40),
    title: String(value.title || '秘书动态').replace(/\s+/g, ' ').trim().slice(0, 120),
    body: String(value.body || '').replace(/\s+/g, ' ').trim().slice(0, 800),
    runId: String(value.runId || '').slice(0, 120),
    read: value.read === true
  };
}

function normalizeSignal(value = {}) {
  return {
    id: String(value.id || randomUUID()),
    at: String(value.at || new Date().toISOString()),
    type: String(value.type || 'external').slice(0, 80),
    title: String(value.title || '外部事件').replace(/\s+/g, ' ').trim().slice(0, 160),
    detail: String(value.detail || '').replace(/\s+/g, ' ').trim().slice(0, 1600),
    priority: ['urgent', 'high', 'normal', 'low'].includes(value.priority) ? value.priority : 'normal',
    status: ['pending', 'processing', 'completed', 'failed'].includes(value.status) ? value.status : 'pending'
  };
}

export function normalizeSecretaryControl(value = {}) {
  const scheduler = value.scheduler && typeof value.scheduler === 'object' ? value.scheduler : {};
  return {
    version: 2,
    sessionId: String(value.sessionId || ''),
    killSwitch: value.killSwitch === true,
    createdAt: String(value.createdAt || ''),
    updatedAt: String(value.updatedAt || ''),
    stoppedAt: String(value.stoppedAt || ''),
    resumedAt: String(value.resumedAt || ''),
    auditSeq: Number(value.auditSeq || 0),
    auditHead: String(value.auditHead || ''),
    lastEventAt: String(value.lastEventAt || ''),
    settings: normalizeSecretarySettings(value.settings),
    scheduler: {
      lastTickAt: String(scheduler.lastTickAt || ''),
      lastRunAt: String(scheduler.lastRunAt || ''),
      lastCompletedAt: String(scheduler.lastCompletedAt || ''),
      lastTrigger: String(scheduler.lastTrigger || ''),
      lastDailyBriefDate: String(scheduler.lastDailyBriefDate || ''),
      lastDailyReviewDate: String(scheduler.lastDailyReviewDate || ''),
      lastLearningAt: String(scheduler.lastLearningAt || ''),
      dailyRunDate: String(scheduler.dailyRunDate || ''),
      dailyRunCount: Number(scheduler.dailyRunCount || 0),
      nextCheckAt: String(scheduler.nextCheckAt || ''),
      lastError: String(scheduler.lastError || '').slice(0, 800)
    },
    notifications: (Array.isArray(value.notifications) ? value.notifications : []).slice(-120).map(normalizeNotification),
    signals: (Array.isArray(value.signals) ? value.signals : []).slice(-80).map(normalizeSignal)
  };
}

function zonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    minutes: Number(values.hour) * 60 + Number(values.minute)
  };
}

function clockMinutes(value) {
  const [hour, minute] = String(value || '00:00').split(':').map(Number);
  return hour * 60 + minute;
}

function isQuietTime(minutes, startTime, endTime) {
  const start = clockMinutes(startTime);
  const end = clockMinutes(endTime);
  if (start === end) return false;
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end;
}

function elapsedAtLeast(lastAt, milliseconds, now) {
  const last = Date.parse(lastAt || '');
  return !last || now.getTime() - last >= milliseconds;
}

export function selectSecretaryTrigger(controlValue, context = {}) {
  const control = normalizeSecretaryControl(controlValue);
  const settings = control.settings;
  const now = context.now instanceof Date ? context.now : new Date(context.now || Date.now());
  const local = zonedParts(now, settings.timezone);
  const scheduler = control.scheduler;
  const dailyRunCount = scheduler.dailyRunDate === local.date ? scheduler.dailyRunCount : 0;
  if (control.killSwitch || !settings.enabled || context.running) return null;
  if (settings.maxAutonomousRunsPerDay > 0 && dailyRunCount >= settings.maxAutonomousRunsPerDay) return null;

  const priorityOrder = { urgent: 0, high: 1, normal: 2, low: 3 };
  const pendingSignal = control.signals
    .filter((signal) => signal.status === 'pending')
    .sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority] || String(a.at).localeCompare(String(b.at)))[0];
  const quiet = isQuietTime(local.minutes, settings.quietStartTime, settings.quietEndTime);
  if (pendingSignal && (!quiet || pendingSignal.priority === 'urgent')) {
    return { type: 'event', signalId: pendingSignal.id, label: pendingSignal.title, localDate: local.date };
  }
  if (quiet) return null;

  if (
    local.minutes >= clockMinutes(settings.dailyBriefTime)
    && local.minutes < clockMinutes(settings.dailyReviewTime)
    && scheduler.lastDailyBriefDate !== local.date
  ) {
    return { type: 'daily-brief', label: '每日计划', localDate: local.date };
  }
  if (local.minutes >= clockMinutes(settings.dailyReviewTime) && scheduler.lastDailyReviewDate !== local.date) {
    return { type: 'daily-review', label: '每日回顾', localDate: local.date };
  }
  if (Number(context.pendingTaskCount || 0) > 0 && elapsedAtLeast(scheduler.lastRunAt, settings.continuationIntervalMinutes * 60_000, now)) {
    return { type: 'continue', label: '继续未完成任务', localDate: local.date };
  }
  if (settings.proactiveLearning && elapsedAtLeast(scheduler.lastLearningAt, settings.learningIntervalHours * 60 * 60_000, now)) {
    return { type: 'learn', label: '自主学习', localDate: local.date };
  }
  return null;
}

export function secretaryAutonomyPrompt(trigger, context = {}) {
  const tasks = Array.isArray(context.tasks) ? context.tasks : [];
  const taskSummary = tasks.slice(0, 8).map((task) => `- ${task.status || 'pending'} / P${task.priority ?? '-'} / ${task.title || task.id}`).join('\n');
  const base = [
    '这是秘书后台自主循环触发的任务。无需等待用户确认，直接执行并在完成后主动汇报。',
    '先读取 AGENTS.md、MEMORY.md、data/tasks.json 和 data/knowledge-index.json。',
    '执行过程中维护任务状态、下一步、完成证据和长期记忆；遇到可恢复失败要更换方法继续。',
    '不要修改或绕过控制台审计、总停止和调度器。'
  ];
  if (trigger.type === 'daily-brief') {
    base.push('生成今天的三项优先事项，立即推进价值最高的一项，并向用户发送一份简短晨报。');
  } else if (trigger.type === 'daily-review') {
    base.push('回顾今天完成、失败和未完成事项，修正任务账本，沉淀知识，并确定明天第一项行动。');
  } else if (trigger.type === 'continue') {
    base.push('选择优先级最高且可执行的未完成任务，持续推进到可验证交付；不要只返回计划。');
  } else if (trigger.type === 'learn') {
    base.push('结合当前目标主动研究最有价值的新知识，核验来源，形成可复用操作方法，并更新知识索引。');
  } else if (trigger.type === 'event') {
    base.push(`处理外部事件：${context.signal?.title || trigger.label || '未命名事件'}。`);
    if (context.signal?.detail) base.push(`事件详情：${context.signal.detail}`);
  } else {
    base.push('检查当前状态并执行最有价值的下一步。');
  }
  if (taskSummary) base.push(`当前任务摘要：\n${taskSummary}`);
  return base.join('\n\n');
}

export function createSecretaryAuditEntry(controlValue, detail = {}) {
  const control = normalizeSecretaryControl(controlValue);
  const entry = {
    id: randomUUID(),
    seq: control.auditSeq + 1,
    at: String(detail.at || new Date().toISOString()),
    type: String(detail.type || 'secretary.event').slice(0, 120),
    sessionId: String(detail.sessionId || control.sessionId || '').slice(0, 120),
    runId: String(detail.runId || '').slice(0, 120),
    messageId: String(detail.messageId || '').slice(0, 120),
    summary: String(detail.summary || detail.type || 'secretary.event').replace(/\s+/g, ' ').trim().slice(0, 1200),
    prevHash: control.auditHead
  };
  entry.hash = createHash('sha256').update(JSON.stringify(entry)).digest('hex');
  return {
    entry,
    control: {
      ...control,
      auditSeq: entry.seq,
      auditHead: entry.hash,
      lastEventAt: entry.at,
      updatedAt: entry.at
    }
  };
}

export function parseSecretaryAudit(text = '', limit = 80) {
  const lines = String(text || '').trim().split('\n').filter(Boolean);
  const entries = [];
  for (const line of lines.slice(-Math.max(1, limit))) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // A partial final line must not make the whole audit feed unreadable.
    }
  }
  return entries;
}

export function secretaryQuickPrompt(kind) {
  return SECRETARY_QUICK_TASKS[String(kind || '')] || '';
}
