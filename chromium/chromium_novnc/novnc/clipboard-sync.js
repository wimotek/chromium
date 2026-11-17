// Wimotek noVNC Bidirectional Clipboard Auto-Sync Bridge (HTTPS / Secure Context)
// Works alongside noVNC 1.5.0 ExtendedClipboard (UTF-8) + Xvnc + autocutsel.

const CLIPBOARD_TEXTAREA_ID = 'noVNC_clipboard_text';
const CONTAINER_ID = 'noVNC_container';
const SYNC_DEBOUNCE_MS = 120;
const REMOTE_ROUNDTRIP_WAIT_MS = 40;
const SYNTHETIC_FLAG = '__wimotekSynthetic';

const isMac =
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || '');

let lastRemoteText = '';
let lastLocalText = '';
let pendingRemoteWrite = null;
let lastSyncAt = 0;
let syncInFlight = null;
let suppressedKeyupCodes = new Set();
let pendingCtrlVRelease = false;
let ctrlVInFlight = false;

function getClipboardTextarea() {
  return document.getElementById(CLIPBOARD_TEXTAREA_ID);
}

function getCanvasTarget() {
  return (
    document.querySelector('#noVNC_container canvas') ||
    document.querySelector('#noVNC_screen canvas') ||
    document.querySelector('canvas') ||
    document.activeElement ||
    document.body
  );
}

function canUseAsyncClipboard() {
  return Boolean(window.isSecureContext && navigator.clipboard);
}

function setupTextareaObserver() {
  const ta = getClipboardTextarea();
  if (!ta || ta.dataset.wimotekHooked === '1') return ta;

  const protoDesc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
  if (!protoDesc || !protoDesc.get || !protoDesc.set) return ta;

  const nativeGet = protoDesc.get;
  const nativeSet = protoDesc.set;

  ta._wimotekSetNative = (val) => {
    nativeSet.call(ta, val);
  };

  Object.defineProperty(ta, 'value', {
    configurable: true,
    enumerable: true,
    get() {
      return nativeGet.call(ta);
    },
    set(val) {
      nativeSet.call(ta, val);
      const text = typeof val === 'string' ? val : String(val ?? '');
      handleRemoteClipboardUpdate(text);
    },
  });

  ta.dataset.wimotekHooked = '1';
  return ta;
}

function pushTextToRemote(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  const ta = setupTextareaObserver();
  if (!ta) return false;

  if (text === lastLocalText && text === lastRemoteText) {
    return false;
  }

  lastLocalText = text;
  lastRemoteText = text;

  if (typeof ta._wimotekSetNative === 'function') {
    ta._wimotekSetNative(text);
  } else {
    ta.value = text;
  }
  ta.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

async function writeLocalClipboard(text) {
  if (!canUseAsyncClipboard() || typeof navigator.clipboard.writeText !== 'function') {
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    lastLocalText = text;
    pendingRemoteWrite = null;
  } catch {
    // Browser may deny writeText when tab/document lacks focus; flush on next interaction.
    pendingRemoteWrite = text;
  }
}

function handleRemoteClipboardUpdate(text) {
  if (typeof text !== 'string') return;
  if (text === lastRemoteText && text === lastLocalText) return;
  lastRemoteText = text;
  void writeLocalClipboard(text);
}

async function flushPendingRemoteWrite() {
  if (pendingRemoteWrite === null) return;
  const text = pendingRemoteWrite;
  await writeLocalClipboard(text);
}

async function syncLocalToRemote(force = false) {
  if (!canUseAsyncClipboard() || typeof navigator.clipboard.readText !== 'function') {
    return false;
  }
  const now = Date.now();
  if (!force && now - lastSyncAt < SYNC_DEBOUNCE_MS) {
    return false;
  }
  if (syncInFlight) {
    return syncInFlight;
  }

  syncInFlight = (async () => {
    try {
      await flushPendingRemoteWrite();
      const text = await navigator.clipboard.readText();
      lastSyncAt = Date.now();
      if (typeof text === 'string' && text.length > 0 && text !== lastLocalText) {
        return pushTextToRemote(text);
      }
      if (typeof text === 'string' && text.length > 0 && force && text !== lastRemoteText) {
        return pushTextToRemote(text);
      }
      return false;
    } catch {
      return false;
    } finally {
      syncInFlight = null;
    }
  })();

  return syncInFlight;
}

function dispatchSyntheticKey(target, type, opts) {
  const evt = new KeyboardEvent(type, {
    bubbles: true,
    cancelable: true,
    view: window,
    ...opts,
  });
  Object.defineProperty(evt, SYNTHETIC_FLAG, { value: true });
  target.dispatchEvent(evt);
}

function isEditableOutsideCanvas(el) {
  if (!el) return false;
  const tag = (el.tagName || '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function installEventHooks() {
  setupTextareaObserver();

  window.addEventListener('focus', () => {
    void flushPendingRemoteWrite().then(() => syncLocalToRemote(false));
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      void flushPendingRemoteWrite().then(() => syncLocalToRemote(false));
    }
  });

  document.addEventListener(
    'pointerdown',
    (e) => {
      const container = document.getElementById(CONTAINER_ID);
      if (container && container.contains(e.target)) {
        void flushPendingRemoteWrite().then(() => syncLocalToRemote(false));
      }
    },
    true
  );

  // Fallback for browsers or contexts where paste event provides clipboardData directly
  window.addEventListener(
    'paste',
    (e) => {
      if (isEditableOutsideCanvas(e.target)) return;
      const text = e.clipboardData?.getData('text/plain');
      if (text) {
        pushTextToRemote(text);
      }
    },
    true
  );

  window.addEventListener(
    'keydown',
    (e) => {
      if (e[SYNTHETIC_FLAG]) return;
      if (isEditableOutsideCanvas(e.target)) return;

      const code = e.code;
      const isCtrlPaste = e.ctrlKey && !e.metaKey && !e.altKey && code === 'KeyV';
      const isMacCmdShortcut =
        isMac &&
        e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        (code === 'KeyV' || code === 'KeyC' || code === 'KeyX' || code === 'KeyA');

      if (!isCtrlPaste && !isMacCmdShortcut) {
        return;
      }

      const target = getCanvasTarget();

      if (isCtrlPaste) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.repeat || ctrlVInFlight) return;

        ctrlVInFlight = true;
        pendingCtrlVRelease = false;

        void (async () => {
          try {
            const pushed = await syncLocalToRemote(true);
            if (pushed) {
              await sleep(REMOTE_ROUNDTRIP_WAIT_MS);
            }
            dispatchSyntheticKey(target, 'keydown', {
              key: e.key || 'v',
              code: 'KeyV',
              keyCode: 86,
              which: 86,
              ctrlKey: true,
              shiftKey: e.shiftKey,
            });
            if (pendingCtrlVRelease) {
              dispatchSyntheticKey(target, 'keyup', {
                key: e.key || 'v',
                code: 'KeyV',
                keyCode: 86,
                which: 86,
                ctrlKey: true,
                shiftKey: e.shiftKey,
              });
            }
          } finally {
            ctrlVInFlight = false;
            pendingCtrlVRelease = false;
          }
        })();
        return;
      }

      if (isMacCmdShortcut) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.repeat) return;
        suppressedKeyupCodes.add(code);

        const keyChar = code.replace('Key', '').toLowerCase();
        const keyCode = keyChar.toUpperCase().charCodeAt(0);

        void (async () => {
          if (code === 'KeyV') {
            const pushed = await syncLocalToRemote(true);
            if (pushed) {
              await sleep(REMOTE_ROUNDTRIP_WAIT_MS);
            }
          }

          // Release MetaLeft so Linux Chromium doesn't receive Super+Ctrl+<key>
          dispatchSyntheticKey(target, 'keyup', {
            key: 'Meta',
            code: 'MetaLeft',
            keyCode: 91,
            which: 91,
            metaKey: false,
          });
          dispatchSyntheticKey(target, 'keydown', {
            key: 'Control',
            code: 'ControlLeft',
            keyCode: 17,
            which: 17,
            ctrlKey: true,
          });
          dispatchSyntheticKey(target, 'keydown', {
            key: keyChar,
            code,
            keyCode,
            which: keyCode,
            ctrlKey: true,
            shiftKey: e.shiftKey,
          });
          dispatchSyntheticKey(target, 'keyup', {
            key: keyChar,
            code,
            keyCode,
            which: keyCode,
            ctrlKey: true,
            shiftKey: e.shiftKey,
          });
          dispatchSyntheticKey(target, 'keyup', {
            key: 'Control',
            code: 'ControlLeft',
            keyCode: 17,
            which: 17,
            ctrlKey: false,
          });
        })();
      }
    },
    true
  );

  window.addEventListener(
    'keyup',
    (e) => {
      if (e[SYNTHETIC_FLAG]) return;
      if (ctrlVInFlight && e.code === 'KeyV') {
        pendingCtrlVRelease = true;
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      if (suppressedKeyupCodes.has(e.code)) {
        suppressedKeyupCodes.delete(e.code);
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    true
  );
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', installEventHooks, { once: true });
} else {
  installEventHooks();
}
