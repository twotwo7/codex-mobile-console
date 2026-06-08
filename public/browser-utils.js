export function storageGet(key, fallback = '') {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

export function storageSet(key, value) {
  try {
    localStorage.setItem(key, String(value));
    return true;
  } catch {
    return false;
  }
}

export function storageJsonGet(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

export function storageJsonSet(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function scheduleIdle(fn, timeout = 1500) {
  if ('requestIdleCallback' in window) {
    return window.requestIdleCallback(fn, { timeout });
  }
  return window.setTimeout(fn, Math.min(timeout, 300));
}

export function cancelIdle(handle) {
  if (!handle) return;
  if ('cancelIdleCallback' in window) window.cancelIdleCallback(handle);
  else window.clearTimeout(handle);
}
