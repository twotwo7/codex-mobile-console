export function createSingleFlight() {
  const inFlight = new Map();

  return function runSingleFlight(key, task) {
    const normalizedKey = String(key || '');
    const existing = inFlight.get(normalizedKey);
    if (existing) return existing;

    const operation = Promise.resolve()
      .then(task)
      .finally(() => {
        if (inFlight.get(normalizedKey) === operation) inFlight.delete(normalizedKey);
      });
    inFlight.set(normalizedKey, operation);
    return operation;
  };
}

export function createSerialExecutor() {
  let tail = Promise.resolve();

  return function runSerial(task) {
    const operation = tail.then(task, task);
    tail = operation.catch(() => {});
    return operation;
  };
}
