const ARRAY_KEYS = new Set([
  'match', 'include', 'exclude', 'exclude-match',
  'grant', 'require', 'resource', 'connect',
]);

export function parseMetadata(code) {
  const startIdx = code.indexOf('// ==UserScript==');
  const endIdx = code.indexOf('// ==/UserScript==');
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return null;

  const block = code.substring(startIdx + 17, endIdx);
  const metadata = {};

  for (const line of block.split('\n')) {
    const m = line.match(/^\/\/\s+@([\w:-]+)(?:\s+(.*))?$/);
    if (!m) continue;

    const key = m[1];
    const value = (m[2] || '').trim();

    // skip localized variants like @name:ja
    if (key.includes(':')) continue;

    if (ARRAY_KEYS.has(key)) {
      if (!metadata[key]) metadata[key] = [];
      if (value) metadata[key].push(value);
    } else {
      metadata[key] = value || true;
    }
  }

  return metadata;
}
