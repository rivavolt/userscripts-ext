import { parseMetadata } from './metadata.js';

const NATIVE_HOST = 'com.userscripts.host';
const STORAGE_KEY = 'scriptData';
const STATE_KEY = 'scriptStates';

const registry = new Map(); // id -> {content, metadata, requireCode, enabled}
const requireCache = new Map(); // url -> code
let port = null;
let reconnectTimer = null;
let syncIds = null; // track IDs during initial sync

// --- Native messaging ---

function connect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  try {
    port = chrome.runtime.connectNative(NATIVE_HOST);
  } catch (e) {
    console.error('Failed to connect to native host:', e);
    scheduleReconnect();
    return;
  }

  syncIds = new Set();
  port.onMessage.addListener(handleMessage);
  port.onDisconnect.addListener(() => {
    console.error('Native host disconnected:', chrome.runtime.lastError?.message);
    port = null;
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  if (!reconnectTimer) {
    reconnectTimer = setTimeout(connect, 5000);
  }
}

// --- Message handling ---

async function handleMessage(msg) {
  switch (msg.type) {
    case 'added':
    case 'changed':
      if (syncIds) syncIds.add(msg.id);
      await handleScriptUpdate(msg.id, msg.content);
      break;
    case 'removed':
      await handleScriptRemoved(msg.id);
      break;
    case 'ready':
      await cleanupStaleScripts();
      syncIds = null;
      break;
  }
}

async function handleScriptUpdate(id, content) {
  const metadata = parseMetadata(content);
  if (!metadata) {
    console.error(`Failed to parse metadata for ${id}`);
    return;
  }

  const requireCode = await fetchRequires(metadata.require || []);

  const { [STATE_KEY]: states = {} } = await chrome.storage.local.get(STATE_KEY);
  const enabled = states[id] !== false;

  registry.set(id, { content, metadata, requireCode, enabled });
  await persistMeta();

  if (!enabled) return;
  await registerWithChrome(id, content, metadata, requireCode);
}

async function handleScriptRemoved(id) {
  registry.delete(id);
  await persistMeta();

  try {
    await chrome.userScripts.unregister({ ids: [id] });
  } catch (e) {
    // might not be registered (was disabled)
  }
}

async function cleanupStaleScripts() {
  const registered = await chrome.userScripts.getScripts();
  const knownIds = new Set(registry.keys());
  const staleIds = registered.map(s => s.id).filter(id => !knownIds.has(id));

  if (staleIds.length > 0) {
    await chrome.userScripts.unregister({ ids: staleIds });
  }
}

// --- @require fetching ---

async function fetchRequires(urls) {
  const results = [];
  for (const url of urls) {
    let code = requireCache.get(url);
    if (!code) {
      try {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        code = await resp.text();
        requireCache.set(url, code);
      } catch (e) {
        console.error(`Failed to fetch @require ${url}:`, e);
        continue;
      }
    }
    results.push(code);
  }
  return results;
}

// --- chrome.userScripts registration ---

const RUN_AT_MAP = {
  'document-start': 'document_start',
  'document-end': 'document_end',
  'document-idle': 'document_idle',
  'document-body': 'document_end',
};

async function registerWithChrome(id, content, metadata, requireCode) {
  const allCode = [...requireCode, content].join('\n');

  const registration = {
    id,
    js: [{ code: allCode }],
    allFrames: !metadata.noframes,
    world: 'MAIN',
  };

  if (metadata.match?.length > 0) {
    registration.matches = metadata.match;
  }

  // @include globs (filter out /regex/ patterns)
  const includeGlobs = (metadata.include || []).filter(p => !(p.startsWith('/') && p.endsWith('/')));
  if (includeGlobs.length > 0) {
    registration.includeGlobs = includeGlobs;
  }

  // @exclude
  const excludeGlobs = (metadata.exclude || []).filter(p => !(p.startsWith('/') && p.endsWith('/')));
  if (excludeGlobs.length > 0) {
    registration.excludeGlobs = excludeGlobs;
  }

  if (metadata['exclude-match']?.length > 0) {
    registration.excludeMatches = metadata['exclude-match'];
  }

  // need at least one match pattern
  if (!registration.matches && !registration.includeGlobs) {
    registration.matches = ['*://*/*'];
  }

  const runAt = metadata['run-at'];
  if (runAt && RUN_AT_MAP[runAt]) {
    registration.runAt = RUN_AT_MAP[runAt];
  }

  try {
    const existing = await chrome.userScripts.getScripts({ ids: [id] });
    if (existing.length > 0) {
      await chrome.userScripts.update([registration]);
    } else {
      await chrome.userScripts.register([registration]);
    }
  } catch (e) {
    console.error(`Failed to register ${id}:`, e);
  }
}

// --- Enable/disable ---

async function toggleScript(id, enabled) {
  const { [STATE_KEY]: states = {} } = await chrome.storage.local.get(STATE_KEY);
  states[id] = enabled;
  await chrome.storage.local.set({ [STATE_KEY]: states });

  const info = registry.get(id);
  if (!info) return;

  info.enabled = enabled;

  if (enabled) {
    await registerWithChrome(id, info.content, info.metadata, info.requireCode);
  } else {
    try {
      await chrome.userScripts.unregister({ ids: [id] });
    } catch (e) { /* might not be registered */ }
  }

  await persistMeta();
}

// --- Persist metadata for popup ---

async function persistMeta() {
  const data = {};
  for (const [id, info] of registry) {
    data[id] = {
      name: info.metadata.name || id,
      matches: info.metadata.match || info.metadata.include || [],
      description: info.metadata.description || '',
      enabled: info.enabled,
    };
  }
  await chrome.storage.local.set({ [STORAGE_KEY]: data });
}

// --- Popup communication ---

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'toggleScript') {
    toggleScript(msg.id, msg.enabled).then(() => sendResponse({ ok: true }));
    return true;
  }
});

// --- Init ---

if (!chrome.userScripts) {
  chrome.storage.local.set({ [STORAGE_KEY]: { _error: {
    name: 'User Scripts API unavailable',
    matches: ['Enable "Developer mode" in chrome://extensions'],
    description: 'Chrome 138+: also enable "Allow User Scripts" for this extension',
    enabled: false,
  }}});
} else {
  connect();
}
