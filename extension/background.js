import { parseMetadata } from './metadata.js';

const NATIVE_HOST = 'com.userscripts.host';
const STORAGE_KEY = 'scriptData';
const STATE_KEY = 'scriptStates';

const registry = new Map(); // id -> {content, metadata, requireCode, enabled}
const requireCache = new Map(); // url -> code
let port = null;
let reconnectTimer = null;
let messageQueue = Promise.resolve();
let connected = false;

// --- Logging (bridge to native host -> journal) ---

function log(level, message) {
  console[level === 'error' ? 'error' : 'log'](`[userscripts] ${message}`);
  if (port) {
    try { port.postMessage({ type: 'log', level, message }); } catch (e) {}
  }
}

// --- Native messaging ---

function connect() {
  if (connected) return;
  connected = true;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  try {
    port = chrome.runtime.connectNative(NATIVE_HOST);
  } catch (e) {
    connected = false;
    log('error', `Failed to connect to native host: ${e}`);
    scheduleReconnect();
    return;
  }

  log('info', 'Connected to native host');
  port.onMessage.addListener((msg) => {
    messageQueue = messageQueue.then(() => handleMessage(msg)).catch(e => {
      log('error', `Message handler error: ${e.message}\n${e.stack}`);
    });
  });
  port.onDisconnect.addListener(() => {
    log('error', `Native host disconnected: ${chrome.runtime.lastError?.message}`);
    port = null;
    connected = false;
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
      await handleScriptUpdate(msg.id, msg.content);
      break;
    case 'removed':
      await handleScriptRemoved(msg.id);
      break;
    case 'ready': {
      await cleanupStaleScripts();
      await persistMeta();

      // verify
      const scripts = await chrome.userScripts.getScripts();
      const { [STORAGE_KEY]: data } = await chrome.storage.local.get(STORAGE_KEY);
      const storageCount = data ? Object.keys(data).length : 0;
      log('info', `Sync done: registry=${registry.size} chrome=${scripts.length} storage=${storageCount}`);
      break;
    }
  }
}

async function handleScriptUpdate(id, content) {
  const metadata = parseMetadata(content);
  if (!metadata) {
    log('error', `Failed to parse metadata for ${id}`);
    return;
  }

  const requireCode = await fetchRequires(metadata.require || []);
  const { [STATE_KEY]: states = {} } = await chrome.storage.local.get(STATE_KEY);
  const enabled = states[id] !== false;

  registry.set(id, { content, metadata, requireCode, enabled });

  if (!enabled) return;
  await registerWithChrome(id, content, metadata, requireCode);
}

async function handleScriptRemoved(id) {
  registry.delete(id);
  await persistMeta();
  try {
    await chrome.userScripts.unregister({ ids: [id] });
  } catch (e) {}
}

async function cleanupStaleScripts() {
  try {
    const registered = await chrome.userScripts.getScripts();
    const knownIds = new Set(registry.keys());
    const staleIds = registered.map(s => s.id).filter(id => !knownIds.has(id));
    if (staleIds.length > 0) {
      log('info', `Cleaning up ${staleIds.length} stale scripts`);
      await chrome.userScripts.unregister({ ids: staleIds });
    }
  } catch (e) {
    log('error', `cleanupStaleScripts failed: ${e.message}`);
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
        log('error', `Failed to fetch @require ${url}: ${e}`);
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

const GM_SHIMS = `
if (typeof GM_addStyle === 'undefined') {
  function GM_addStyle(css) {
    const style = document.createElement('style');
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
    return style;
  }
}
if (typeof GM === 'undefined') {
  var GM = {};
}
if (!GM.registerMenuCommand) {
  GM.registerMenuCommand = function() {};
}
`;

async function registerWithChrome(id, content, metadata, requireCode) {
  const allCode = [GM_SHIMS, ...requireCode, content].join('\n');

  const registration = {
    id,
    js: [{ code: allCode }],
    allFrames: !metadata.noframes,
    world: 'USER_SCRIPT',
  };

  if (metadata.match?.length > 0) {
    registration.matches = metadata.match;
  }

  const includeGlobs = (metadata.include || []).filter(p => !(p.startsWith('/') && p.endsWith('/')));
  if (includeGlobs.length > 0) {
    registration.includeGlobs = includeGlobs;
  }

  const excludeGlobs = (metadata.exclude || []).filter(p => !(p.startsWith('/') && p.endsWith('/')));
  if (excludeGlobs.length > 0) {
    registration.excludeGlobs = excludeGlobs;
  }

  if (metadata['exclude-match']?.length > 0) {
    registration.excludeMatches = metadata['exclude-match'];
  }

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
    log('error', `Failed to register ${id}: ${e.message}`);
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
    try { await chrome.userScripts.unregister({ ids: [id] }); } catch (e) {}
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

function init() {
  if (!chrome.userScripts) {
    log('error', 'userScripts API unavailable');
    const isFirefox = typeof browser !== 'undefined';
    chrome.storage.local.set({ [STORAGE_KEY]: { _error: {
      name: 'User Scripts API unavailable',
      matches: isFirefox
        ? ['Requires Firefox 131+ with Developer mode enabled']
        : ['Enable "Developer mode" in chrome://extensions'],
      description: isFirefox
        ? ''
        : 'Chrome 138+: also enable "Allow User Scripts" for this extension',
      enabled: false,
    }}});
  } else {
    connect();
  }
}

chrome.runtime.onStartup.addListener(() => init());
chrome.runtime.onInstalled.addListener(() => init());
init();
