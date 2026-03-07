async function render() {
  const { scriptData = {} } = await chrome.storage.local.get('scriptData');
  const container = document.getElementById('scripts');
  container.innerHTML = '';

  const scripts = Object.entries(scriptData)
    .map(([id, info]) => ({ id, ...info }))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (scripts.length === 0) {
    container.textContent = 'No scripts loaded';
    return;
  }

  for (const script of scripts) {
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
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.scriptData) render();
});

render();
