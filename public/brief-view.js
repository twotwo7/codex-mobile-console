const STATUS_ONLY_MARKERS = [
  'Codex run finished.',
  'Codex run stopped.',
  'Starting next queued prompt.',
  'Stop requested.',
  'Recovered stale run state',
  'Failed to start Codex',
  'Codex exited with code'
];

export function isStatusOnlyMessage(text) {
  const value = String(text || '');
  return STATUS_ONLY_MARKERS.some((marker) => value.includes(marker));
}

export function isConclusionMessage(message) {
  if (message?.role !== 'assistant') return false;
  const text = String(message.text || '').trim();
  return Boolean(text) && !isStatusOnlyMessage(text);
}

export function isCodexOutputMessage(message) {
  if (!['assistant', 'tool'].includes(message?.role || '')) return false;
  return String(message.text || '').trim().length > 0;
}

export function buildBriefRounds(messages) {
  const rounds = [];
  let current = null;

  const pushCurrent = () => {
    if (current?.user || current?.conclusion || current?.outputCount) rounds.push(current);
  };

  for (const message of messages || []) {
    if (message.role === 'user') {
      pushCurrent();
      current = {
        user: message,
        conclusion: null,
        outputCount: 0,
        firstSeq: message.orderSeq || message.seq || 0,
        lastSeq: message.orderSeq || message.seq || 0
      };
      continue;
    }

    if (!current) {
      current = {
        user: null,
        conclusion: null,
        outputCount: 0,
        firstSeq: message.orderSeq || message.seq || 0,
        lastSeq: message.orderSeq || message.seq || 0
      };
    }

    current.lastSeq = message.orderSeq || message.seq || current.lastSeq;
    if (isCodexOutputMessage(message)) current.outputCount += 1;
    if (isConclusionMessage(message)) current.conclusion = message;
  }
  pushCurrent();
  return rounds;
}

export function compactBriefMessages(messages) {
  const compact = [];
  for (const round of buildBriefRounds(messages)) {
    if (round.user) compact.push(round.user);
    if (round.conclusion) compact.push(round.conclusion);
  }
  return compact;
}

export function oldestMessageOrderSeq(messages) {
  let oldest = 0;
  for (const message of messages || []) {
    const seq = Number(message?.orderSeq || 0);
    if (seq > 0 && (!oldest || seq < oldest)) oldest = seq;
  }
  return oldest;
}
