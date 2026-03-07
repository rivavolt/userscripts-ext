function matchesUrl(patterns, url) {
  if (!url) return false;
  for (const pattern of patterns) {
    const re = pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\\\*/g, '.*');
    if (new RegExp('^' + re + '$').test(url)) return true;
  }
  return false;
}

function renderScript(script, container) {
  const row = document.createElement('div');
  row.className = 'script-row';

  const info = document.createElement('div');
  info.className = 'script-info';

  const name = document.createElement('div');
  name.className = 'script-name';
  name.textContent = script.name;

  const matches = document.createElement('div');
  matches.className = 'script-matches';
  matches.textContent = (script.matches || []).join(', ');

  info.appendChild(name);
  info.appendChild(matches);

  const toggle = document.createElement('input');
  toggle.type = 'checkbox';
  toggle.checked = script.enabled;
  toggle.addEventListener('change', () => {
    chrome.runtime.sendMessage({
      type: 'toggleScript',
      id: script.id,
      enabled: toggle.checked,
    });
  });

  row.appendChild(info);
  row.appendChild(toggle);
  container.appendChild(row);
}

async function render() {
  const { scriptData = {} } = await chrome.storage.local.get('scriptData');
  const container = document.getElementById('scripts');
  container.innerHTML = '';

  const scripts = Object.entries(scriptData)
    .filter(([id]) => id !== '_error')
    .map(([id, info]) => ({ id, ...info }))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (scripts.length === 0) {
    const err = scriptData._error;
    container.textContent = err ? err.name : 'No scripts loaded';
    return;
  }

  // get current tab URL
  let tabUrl = null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabUrl = tab?.url;
  } catch (e) {}

  const matching = [];
  const other = [];
  for (const script of scripts) {
    if (tabUrl && matchesUrl(script.matches || [], tabUrl)) {
      matching.push(script);
    } else {
      other.push(script);
    }
  }

  if (matching.length > 0) {
    const header = document.createElement('div');
    header.className = 'section-header';
    header.textContent = `This page (${matching.length})`;
    container.appendChild(header);
    for (const s of matching) renderScript(s, container);
  }

  if (other.length > 0) {
    const header = document.createElement('div');
    header.className = 'section-header';
    header.textContent = matching.length > 0 ? `Other (${other.length})` : `All scripts (${scripts.length})`;
    container.appendChild(header);
    for (const s of other) renderScript(s, container);
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.scriptData) render();
});

render();
