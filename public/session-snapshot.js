export const SESSION_AUTHORITY_KEYS = [
  'status',
  'storedStatus',
  'statusSummary',
  'statusRevision',
  'statusUpdatedAt',
  'isRunning',
  'canStop',
  'queuedCount',
  'queue',
  'activeRun',
  'lastRun',
  'runCounts',
  'contextHealth',
  'lastSeq',
  'updatedAt',
  'activityAt'
];

export function snapshotStatusRevision(session) {
  const direct = Number(session?.statusRevision || 0);
  const summary = Number(session?.statusSummary?.revision || 0);
  return Math.max(0, direct, summary);
}

export function isStaleSessionSnapshot(current, incoming) {
  const currentRevision = snapshotStatusRevision(current);
  if (!currentRevision) return false;
  const incomingRevision = snapshotStatusRevision(incoming);
  return !incomingRevision || incomingRevision < currentRevision;
}

export function sessionSnapshotPatch(current, incoming) {
  const patch = Object.fromEntries(Object.entries(incoming || {}).filter(([, value]) => value !== undefined));
  if (!isStaleSessionSnapshot(current, incoming)) return patch;
  for (const key of SESSION_AUTHORITY_KEYS) delete patch[key];
  return patch;
}
