const STATUS_FINGERPRINT_KEYS = [
  'status',
  'running',
  'canStop',
  'queueCount',
  'activeRunId',
  'lastRunStatus'
];

function statusFingerprint(summary = {}) {
  return JSON.stringify(STATUS_FINGERPRINT_KEYS.map((key) => summary[key] ?? null));
}

export function versionSessionStatus(session, summary, now = () => new Date().toISOString(), fingerprintExtra = '') {
  const fingerprint = `${statusFingerprint(summary)}\0${String(fingerprintExtra || '')}`;
  if (session.statusFingerprint !== fingerprint) {
    session.statusRevision = Math.max(0, Number(session.statusRevision || 0)) + 1;
    session.statusUpdatedAt = now();
    session.statusFingerprint = fingerprint;
  }
  return {
    ...summary,
    revision: Number(session.statusRevision || 0),
    updatedAt: session.statusUpdatedAt || ''
  };
}
