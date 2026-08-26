importScripts('../shared/rate-limiter.js', '../shared/task-session.js', '../platform/contract.js', '../platform/registry.js', '../platform/instagram/identity.js', '../platform/instagram/plugin.js');

const SNAPSHOT_PREFIX = 'socialTaskSession:instagram:';
const LOCK_PREFIX = 'socialTaskLock:instagram:';
const RATE_LIMIT_PREFIX = 'socialTaskRateLimit:instagram:';
const REFRESH_ALARM_PREFIX = 'socialTaskRefresh:instagram:';
const LEASE_MS = 90 * 1000;

function normalizeTargetUrl(value) {
  return globalThis.SocialCommentPlatformRegistry?.resolve(value)?.identity.normalizeTargetUrl(value) || '';
}

function refreshAlarmName(targetUrl) { return `${REFRESH_ALARM_PREFIX}${encodeURIComponent(targetUrl)}`; }
function snapshotKey(targetUrl) { return `${SNAPSHOT_PREFIX}${targetUrl}`; }
function rateLimitKey(targetUrl) { return `${RATE_LIMIT_PREFIX}${targetUrl}`; }
function clearRefreshAlarm(targetUrl) { return chrome.alarms.clear(refreshAlarmName(targetUrl)); }
function scheduleRefreshAlarm(targetUrl, when) {
  return chrome.alarms.create(refreshAlarmName(targetUrl), { when: Math.max(Date.now() + 1000, Number(when) || Date.now() + 1000) });
}
function tabsReload(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.reload(tabId, { bypassCache: true }, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message)); else resolve();
    });
  });
}

async function waitForTabLoad(tabId, timeoutMs = 15000) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.status === 'complete') return tab;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('目标页面加载超时。'));
    }, timeoutMs);
    const listener = (updatedTabId, changeInfo, updatedTab) => {
      if (updatedTabId !== tabId || changeInfo.status !== 'complete') return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(updatedTab);
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function launchOnTargetTab(targetUrl, mode) {
  const tabs = await chrome.tabs.query({});
  const existingTab = tabs.find((tab) => normalizeTargetUrl(tab.url || '') === targetUrl);
  const tab = existingTab?.id
    ? await chrome.tabs.update(existingTab.id, { active: true, url: targetUrl })
    : await chrome.tabs.create({ active: true, url: targetUrl });
  await waitForTabLoad(tab.id);

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: mode === 'preview' ? 'ICC_PREVIEW' : 'ICC_START',
    }).catch(() => null);
    if (response?.ok) return response;
    await new Promise((done) => setTimeout(done, 400));
  }
  return { ok: false, reason: '当前页面尚未加载清理器，请等待页面完成加载后重试。' };
}

async function controlTargetTab(targetUrl, type) {
  const tabs = await chrome.tabs.query({});
  const tab = tabs.find((candidate) => normalizeTargetUrl(candidate.url || '') === targetUrl);
  if (!tab?.id) return { ok: false, reason: '尚未找到已打开的目标帖子，请先点击“开始”。' };
  const response = await chrome.tabs.sendMessage(tab.id, { type }).catch(() => null);
  return response?.ok ? response : { ok: false, reason: '目标页面尚未加载清理器，请等待页面完成加载后重试。' };
}

chrome.runtime.onInstalled.addListener(() => {
  console.info('[社交评论清理器] installed');
});

chrome.alarms?.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith(REFRESH_ALARM_PREFIX)) return;
  (async () => {
    const targetUrl = decodeURIComponent(alarm.name.slice(REFRESH_ALARM_PREFIX.length));
    const key = snapshotKey(targetUrl);
    const stored = (await chrome.storage.local.get(key))[key];
    const snapshot = globalThis.SocialCommentTaskSession?.normalize(stored) || stored;
    if (!snapshot || !['scheduled-rest', 'refreshing'].includes(snapshot.status)) return;
    if (snapshot.status === 'scheduled-rest' && Number(snapshot.refresh?.nextRefreshAt) > Date.now()) {
      await scheduleRefreshAlarm(targetUrl, snapshot.refresh.nextRefreshAt);
      return;
    }
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((candidate) => normalizeTargetUrl(candidate.url || '') === targetUrl);
    if (!tab?.id) {
      await chrome.storage.local.set({ [key]: { ...snapshot, status: 'paused', reason: '目标标签页已关闭，自动刷新已暂停。', lastCheckpointAt: Date.now() } });
      await clearRefreshAlarm(targetUrl);
      return;
    }
    await chrome.storage.local.set({ [key]: { ...snapshot, status: 'refreshing', reason: '本轮休息结束，正在刷新目标页面。', lastCheckpointAt: Date.now() } });
    await clearRefreshAlarm(targetUrl);
    try {
      await tabsReload(tab.id);
      await waitForTabLoad(tab.id);
    } catch (error) {
      await chrome.storage.local.set({ [key]: { ...snapshot, status: 'paused', reason: `自动刷新失败：${error.message || '未知错误'}`, lastCheckpointAt: Date.now() } });
    }
  })().catch((error) => console.warn('[社交评论清理器] 自动刷新失败', error));
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'ICC_LAUNCH') {
    (async () => {
      const targetUrl = normalizeTargetUrl(message.targetUrl);
      if (!targetUrl) return sendResponse({ ok: false, reason: '目标 URL 无效。' });
      return sendResponse(await launchOnTargetTab(targetUrl, message.mode));
    })().catch((error) => sendResponse({ ok: false, reason: error.message }));
    return true;
  }
  if (['ICC_PAUSE', 'ICC_STOP'].includes(message?.type)) {
    (async () => {
      const targetUrl = normalizeTargetUrl(message.targetUrl);
      if (!targetUrl) return sendResponse({ ok: false, reason: '目标 URL 无效。' });
      return sendResponse(await controlTargetTab(targetUrl, message.type));
    })().catch((error) => sendResponse({ ok: false, reason: error.message }));
    return true;
  }
  if (message?.type === 'ICC_PING') {
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === 'ICC_SCHEDULE_REFRESH' || message?.type === 'ICC_CANCEL_REFRESH') {
    (async () => {
      const targetUrl = normalizeTargetUrl(message.targetUrl);
      if (!targetUrl) return sendResponse({ ok: false, reason: '目标 URL 无效。' });
      if (message.type === 'ICC_CANCEL_REFRESH') {
        await clearRefreshAlarm(targetUrl);
        return sendResponse({ ok: true });
      }
      await scheduleRefreshAlarm(targetUrl, message.nextRefreshAt);
      const lockKey = `${LOCK_PREFIX}${targetUrl}`;
      const currentLock = (await chrome.storage.local.get(lockKey))[lockKey];
      if (currentLock?.tabId === sender.tab?.id) await chrome.storage.local.set({ [lockKey]: { ...currentLock, expiresAt: Math.max(currentLock.expiresAt || 0, Number(message.nextRefreshAt) + LEASE_MS) } });
      return sendResponse({ ok: true, nextRefreshAt: Number(message.nextRefreshAt) });
    })().catch((error) => sendResponse({ ok: false, reason: error.message }));
    return true;
  }
  if (!message?.type?.startsWith('ICC_')) return false;
  (async () => {
    const targetUrl = normalizeTargetUrl(message.targetUrl);
    if (!targetUrl) return sendResponse({ ok: false, reason: '目标 URL 无效。' });
    const key = `${LOCK_PREFIX}${targetUrl}`;
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
    if (message.type === 'ICC_RENEW_LOCK') {
      const current = (await chrome.storage.local.get(key))[key];
      if (!current || current.tabId !== sender.tab?.id) return sendResponse({ ok: false, reason: '帖子锁已失效。' });
      await chrome.storage.local.set({ [key]: { ...current, expiresAt: Date.now() + LEASE_MS } });
      return sendResponse({ ok: true });
    }
    if (message.type === 'ICC_RATE_ACQUIRE') {
      const limitKey = rateLimitKey(targetUrl);
      const stored = (await chrome.storage.local.get(limitKey))[limitKey];
      const limiter = new InstagramCommentRateLimiter(stored);
      const result = limiter.acquire(message.limits || { perMinute: 5, perHour: 60 });
      await chrome.storage.local.set({ [limitKey]: limiter.snapshot() });
      return sendResponse(result);
    }
    const sessionKey = snapshotKey(targetUrl);
    // 会话操作完成后必须立即响应，避免继续落入未知消息类型分支。
    if (message.type === 'ICC_SAVE_SESSION') {
      await chrome.storage.local.set({ [sessionKey]: { ...message.snapshot, ownerTabId: sender.tab?.id || message.snapshot?.ownerTabId || null } });
      return sendResponse({ ok: true });
    }
    if (message.type === 'ICC_GET_SESSION') return sendResponse({ ok: true, snapshot: (await chrome.storage.local.get(sessionKey))[sessionKey] || null });
    if (message.type === 'ICC_CLEAR_SESSION') {
      await chrome.storage.local.remove(sessionKey);
      await clearRefreshAlarm(targetUrl);
      return sendResponse({ ok: true });
    }
    sendResponse({ ok: false, reason: `不支持的消息类型：${message.type}` });
  })().catch((error) => sendResponse({ ok: false, reason: error.message }));
  return true;
});
