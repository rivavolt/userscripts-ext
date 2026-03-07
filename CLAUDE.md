# Userscripts Manager

Declarative userscript manager built with Nix flake. Scripts live as `.user.js` files in a directory, loaded at launch, with hot reload on file change via native messaging host.

## Architecture

### Components

1. **Browser extension** (MV3) — uses `chrome.userScripts` API (Chrome 120+ / Firefox) to register and execute arbitrary userscripts
2. **Native messaging host** — small daemon that watches the scripts directory (inotify), pushes changes to the extension
3. **Nix flake** — builds both components, provides NixOS/home-manager module for declarative config

### Data flow

```
scripts directory (*.user.js files)
  -> native messaging host (watches with inotify)
  -> browser extension (native messaging connection)
  -> chrome.userScripts.register() / .update()
  -> scripts execute on matching pages
```

### Extension internals

- **Background service worker**: connects to native messaging host, manages script registry, handles GM_* API requests from userscripts
- **Content/injection layer**: uses `chrome.userScripts` API for injection (MV3 native), falls back to `scripting.registerContentScripts` where needed
- **Popup UI**: toggle scripts on/off, see matches for current tab, force reload from disk
- **Options page**: per-script overrides, global excludes, runtime config

### Script lifecycle

1. Nix build produces extension + native host with scripts directory path baked in
2. Extension loads -> connects to native host via native messaging
3. Native host reads all `*.user.js` from directory, sends to extension
4. Extension parses `==UserScript==` metadata blocks, registers via `chrome.userScripts.register()`
5. On file change: inotify -> native host pushes update -> extension calls `chrome.userScripts.update()`
6. Runtime toggles/overrides stored in extension storage (survives reload, reset on rebuild unless persisted)

### Metadata parsing

Standard userscript metadata block format:
```
// ==UserScript==
// @name        Script Name
// @match       *://*.example.com/*
// @grant       GM_xmlhttpRequest
// @run-at      document-end
// ==/UserScript==
```

Key directives: `@name`, `@namespace`, `@version`, `@description`, `@match`, `@include`, `@exclude`, `@grant`, `@run-at`, `@require`, `@resource`, `@noframes`, `@inject-into`

### GM_* API support (priority order)

Phase 1 (essential):
- `GM_info` — script metadata object
- `GM_getValue` / `GM_setValue` / `GM_deleteValue` / `GM_listValues` — per-script key-value storage
- `GM_addStyle` — inject CSS
- `GM_xmlhttpRequest` — cross-origin HTTP (proxied through background)
- `GM_registerMenuCommand` / `GM_unregisterMenuCommand`
- `unsafeWindow` — access page's JS context

Phase 2:
- `GM_getResourceText` / `GM_getResourceURL` — @resource access
- `GM_notification` — desktop notifications
- `GM_openInTab` — open tabs
- `GM_setClipboard` — clipboard write
- `GM_download` — file download
- `GM_addElement` — CSP-bypassing element creation
- `GM_addValueChangeListener` / `GM_removeValueChangeListener`

Also expose `GM.*` (promise-based) aliases for all of the above.

### Nix module design

```nix
{
  programs.userscripts = {
    enable = true;
    browsers = [ "firefox" "chromium" ];
    scripts = {
      "youtube-tweaks" = {
        src = ./scripts/youtube-tweaks.user.js;
        match = [ "*://*.youtube.com/*" ];
        runAt = "document-end";
        enabled = true;
      };
      "github-dark" = {
        src = pkgs.fetchurl { url = "..."; hash = "..."; };
        match = [ "*://github.com/*" ];
      };
    };
    scriptDirs = [ ./scripts ];
    stateDir = "~/.local/share/userscripts";
  };
}
```

### URL matching

Two systems (matching existing userscript spec):
1. **`@match` patterns** — Chrome match pattern syntax: `scheme://host/path` with wildcards
2. **`@include`/`@exclude`** — glob patterns with `*` wildcards, or `/regex/` syntax

### Security model

- Scripts run in `USER_SCRIPT` world (MV3) — isolated from extension and page by default
- `@grant none` scripts get no GM APIs, run with minimal privileges
- GM API calls validated against script's `@grant` list in background
- `GM_xmlhttpRequest` proxied through background service worker with header sanitization
- `unsafeWindow` access only when explicitly granted

### Injection timing

- `document-start` — before DOM exists (static content script declaration for reliability)
- `document-body` — when `<body>` exists
- `document-end` — after DOMContentLoaded (default)
- `document-idle` — after load event

### Key differences from existing managers

- **Declarative-first**: scripts defined in Nix, not manually installed through browser UI
- **Filesystem-native**: scripts are real files you edit with your editor, not stored in IndexedDB/extension storage
- **Hot reload**: file changes reflected immediately via native messaging, no extension rebuild needed
- **Reproducible**: `nix build` produces identical extension from the same flake lock
- **Runtime overrides**: popup/options page for toggling and per-site overrides without touching Nix config

## Research notes

### Existing manager architectures studied

**Greasemonkey 4.x** (Firefox WebExtension):
- MV2, uses `chrome.tabs.executeScript()` for injection
- Scripts stored in IndexedDB (one DB for registry, one per script for values)
- GM.* (dot) namespace only, promise-based
- PEG.js parser for metadata lines
- No build step, raw JS zipped into .xpi
- Communication: `chrome.runtime.sendMessage` for simple calls, Ports for streaming (XHR, notifications)

**Violentmonkey** (Chrome/Firefox):
- MV2, three-world architecture (background, content, page)
- "Safe globals" system: caches built-in references before page can tamper with prototypes
- Dual injection: page mode (via `<script>` elements) with content mode fallback (for CSP)
- Vault system for protecting built-in objects from prototype pollution
- Storage: `browser.storage.local` with prefixed flat keys (`scr:`, `code:`, `val:`, `req:`, `cac:`)
- Webpack + Gulp + Vue 3 build system
- Content-to-page bridge via CustomEvent/MouseEvent
- Both GM_* (sync) and GM.* (async) APIs
- Cloud sync support (Dropbox, Drive, OneDrive, WebDAV)

**Tampermonkey** (closed-source, partially documented):
- Most popular (~10M users), proprietary since v2.9+
- Multi-stage injection pipeline with sandbox via Function constructors
- Supports `unsafeWindow` through onclick handler tricks and property definitions
- Content-to-page bridge via custom events
- MV3 migration uses `chrome.userScripts` API

### MV3 userscript injection APIs

| API | Purpose | Code type | Since |
|-----|---------|-----------|-------|
| `chrome.userScripts` | Register/execute arbitrary scripts | Arbitrary `code` strings | Chrome 120+ |
| `chrome.scripting.registerContentScripts` | Dynamic content scripts | Bundled files only | Chrome 88+ |
| `chrome.scripting.executeScript` | One-time injection | Files or functions | Chrome 88+ |

`chrome.userScripts` is the primary MV3 path for userscript managers — only API allowing arbitrary code strings. Requires user to enable "Developer mode" toggle. Supports `USER_SCRIPT` execution world with configurable CSP and messaging.

### Key challenge: document-start timing

MV3 does not guarantee true `document-start` for dynamically registered scripts. Only statically declared manifest content scripts reliably run at `document-start`. Mitigation: declare a thin bootstrapper content script in manifest that runs at `document_start` and coordinates with the background for early injection.

## Tech stack

- Extension: vanilla JS (no framework for core), small UI lib for popup/options
- Native messaging host: single binary (Rust or Go), watches filesystem, speaks Chrome native messaging protocol (length-prefixed JSON over stdin/stdout)
- Build: Nix flake, no npm/webpack — keep it simple
- Tests: browser extension testing via web-ext + playwright or similar
