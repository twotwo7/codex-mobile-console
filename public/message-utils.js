function messageKey(message) {
  if (message.clientMessageId) return `client:${message.clientMessageId}`;
  if (message.id) return `id:${message.id}`;
  if (message.seq) return `seq:${message.seq}`;
  return `${message.role || ''}\0${message.at || ''}\0${String(message.text || '').slice(0, 120)}`;
}

function comparableMessageText(message) {
  return String(message?.text || '').replace(/\s+/g, ' ').trim();
}

function messageTimeMs(message) {
  const value = Date.parse(message?.at || '');
  return Number.isFinite(value) ? value : 0;
}

function isCodexSource(message) {
  return message?.source === 'codex';
}

function sameCrossSourceContent(left, right) {
  if (!left || !right) return false;
  if ((left.role || '') !== (right.role || '')) return false;
  const text = comparableMessageText(left);
  if (!text || text !== comparableMessageText(right)) return false;
  if (isCodexSource(left) === isCodexSource(right) && !isCodexSource(left)) return false;
  const leftAt = messageTimeMs(left);
  const rightAt = messageTimeMs(right);
  if (!leftAt || !rightAt) return true;
  return Math.abs(leftAt - rightAt) <= 5 * 60 * 1000;
}

export function mergeMessagePair(current, incoming) {
  const preferCurrent = !isCodexSource(current) && isCodexSource(incoming);
  const base = preferCurrent ? incoming : current;
  const overlay = preferCurrent ? current : incoming;
  const next = { ...base, ...overlay };
  const currentImages = current.images || [];
  const incomingImages = incoming.images || [];
  const currentFiles = current.files || [];
  const incomingFiles = incoming.files || [];
  next.images = currentImages.length >= incomingImages.length ? currentImages : incomingImages;
  next.files = currentFiles.length >= incomingFiles.length ? currentFiles : incomingFiles;
  next.starred = current.starred === true || incoming.starred === true;
  if (incoming.id || incoming.seq) {
    next.pending = false;
    next.failed = false;
  }
  return next;
}

export function findMessageIndex(messages, message) {
  const key = messageKey(message);
  const direct = messages.findIndex((item) => messageKey(item) === key);
  if (direct >= 0) return direct;
  return messages.findIndex((item) => sameCrossSourceContent(item, message));
}

export function mergeMessages(existing, incoming) {
  const out = [];
  for (const message of [...(existing || []), ...(incoming || [])]) {
    const index = findMessageIndex(out, message);
    const next = index >= 0 ? mergeMessagePair(out[index], message) : { ...message };
    if (message.id || message.seq) {
      next.pending = false;
      next.failed = false;
    }
    if (index >= 0) out[index] = next;
    else out.push(next);
  }
  return out.sort(compareMessages);
}

export function compareMessages(a, b) {
  const aTime = messageTimeMs(a);
  const bTime = messageTimeMs(b);
  if (aTime && bTime && aTime !== bTime) return aTime - bTime;
  if (aTime && !bTime) return -1;
  if (!aTime && bTime) return 1;
  const aSeq = Number(a.seq || 0);
  const bSeq = Number(b.seq || 0);
  if (aSeq > 0 && bSeq > 0) return aSeq - bSeq;
  if (aSeq || bSeq) return aSeq - bSeq;
  return messageKey(a).localeCompare(messageKey(b));
}

export function lastRealSeq(messages) {
  return Math.max(0, ...messages.map((message) => Number(message.seq || 0)).filter((seq) => seq > 0));
}
