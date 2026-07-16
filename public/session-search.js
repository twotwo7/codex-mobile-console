export function normalizeSearchText(value = '') {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function compileTextSearch(query = '') {
  const normalized = normalizeSearchText(query);
  const tokens = normalized ? normalized.split(' ') : [];
  return {
    active: tokens.length > 0,
    matches(searchText = '') {
      if (!tokens.length) return true;
      const candidate = normalizeSearchText(searchText);
      return tokens.every((token) => candidate.includes(token));
    }
  };
}

export function createSearchTextCache() {
  const cache = new WeakMap();
  return (subject, values = []) => {
    const parts = values.map((value) => String(value || ''));
    const signature = parts.join('\0');
    if (!subject || typeof subject !== 'object') return normalizeSearchText(parts.join(' '));
    const current = cache.get(subject);
    if (current?.signature === signature) return current.text;
    const text = normalizeSearchText(parts.join(' '));
    cache.set(subject, { signature, text });
    return text;
  };
}
