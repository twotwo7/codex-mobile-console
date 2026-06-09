function messageKey(message) {
  if (message.clientMessageId) return `client:${message.clientMessageId}`;
  if (message.id) return `id:${message.id}`;
  if (message.seq) return `seq:${message.seq}`;
  if (message.orderSeq) return `order:${message.orderSeq}`;
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
  next.images = mergeImages(currentImages, incomingImages);
  next.starred = current.starred === true || incoming.starred === true;
  if (incoming.id || incoming.seq || incoming.orderSeq) {
    next.pending = false;
    next.failed = false;
  }
  return next;
}

function imagePersistenceScore(image) {
  return (image?.url ? 8 : 0)
    + (image?.fileName ? 4 : 0)
    + (image?.path ? 2 : 0)
    + (image?.dataUrl || image?.data ? 1 : 0);
}

function mergeImages(currentImages, incomingImages) {
  const max = Math.max(currentImages.length, incomingImages.length);
  const out = [];
  for (let index = 0; index < max; index += 1) {
    const current = currentImages[index];
    const incoming = incomingImages[index];
    if (!current) {
      if (incoming) out.push(incoming);
      continue;
    }
    if (!incoming) {
      out.push(current);
      continue;
    }
    out.push(imagePersistenceScore(incoming) >= imagePersistenceScore(current)
      ? { ...current, ...incoming }
      : { ...incoming, ...current });
  }
  return out;
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
    if (message.id || message.seq || message.orderSeq) {
      next.pending = false;
      next.failed = false;
    }
    if (index >= 0) out[index] = next;
    else out.push(next);
  }
  return out.sort(compareMessages);
}

export function compareMessages(a, b) {
  const aOrder = Number(a.orderSeq || 0);
  const bOrder = Number(b.orderSeq || 0);
  if (aOrder > 0 && bOrder > 0) return aOrder - bOrder;
  const aSeq = Number(a.seq || 0);
  const bSeq = Number(b.seq || 0);
  if (aSeq > 0 && bSeq > 0) return aSeq - bSeq;
  if (aOrder || bOrder) return aOrder - bOrder;
  if (aSeq || bSeq) return aSeq - bSeq;
  const aTime = messageTimeMs(a);
  const bTime = messageTimeMs(b);
  if (aTime && bTime && aTime !== bTime) return aTime - bTime;
  if (aTime && !bTime) return -1;
  if (!aTime && bTime) return 1;
  return messageKey(a).localeCompare(messageKey(b));
}

export function lastRealSeq(messages) {
  return Math.max(0, ...messages.map((message) => Number(message.seq || 0)).filter((seq) => seq > 0));
}
