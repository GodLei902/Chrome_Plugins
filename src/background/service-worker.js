const SNAPSHOT_PREFIX = 'instagramCommentCleanerSession:';
const LOCK_PREFIX = 'instagramCommentCleanerLock:';
const LEASE_MS = 90 * 1000;

chrome.runtime.onInstalled.addListener(() => {
  console.info('[Social Comment Cleaner] installed');
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'ICC_PING') {
    sendResponse({ ok: true });
    return false;
  }
  if (!message?.type?.startsWith('ICC_')) return false;
  (async () => {
    const key = `${LOCK_PREFIX}${message.targetUrl}`;
    if (message.type === 'ICC_ACQUIRE_LOCK') {
      const current = (await chrome.storage.local.get(key))[key];
      const now = Date.now();
      if (current && current.tabId !== sender.tab?.id && current.expiresAt > now) return sendResponse({ ok: false, reason: '该帖子正在另一标签页运行。' });
      await chrome.storage.local.set({ [key]: { tabId: sender.tab?.id, expiresAt: now + LEASE_MS } });
      return sendResponse({ ok: true });
    }
    if (message.type === 'ICC_RELEASE_LOCK') {
      const current = (await chrome.storage.local.get(key))[key];
      if (!current || current.tabId === sender.tab?.id) await chrome.storage.local.remove(key);
      return sendResponse({ ok: true });
    }
    const snapshotKey = `${SNAPSHOT_PREFIX}${message.targetUrl}`;
    if (message.type === 'ICC_SAVE_SESSION') await chrome.storage.local.set({ [snapshotKey]: message.snapshot });
    if (message.type === 'ICC_GET_SESSION') return sendResponse({ ok: true, snapshot: (await chrome.storage.local.get(snapshotKey))[snapshotKey] || null });
    if (message.type === 'ICC_CLEAR_SESSION') await chrome.storage.local.remove(snapshotKey);
    sendResponse({ ok: true });
  })().catch((error) => sendResponse({ ok: false, reason: error.message }));
  return true;
});
