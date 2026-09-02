importScripts('../shared/rate-limiter.js', '../shared/task-session.js', '../platform/contract.js', '../platform/registry.js', '../platform/instagram/identity.js', '../platform/instagram/plugin.js');

const SNAPSHOT_PREFIX = 'socialTaskSession:';
const LOCK_PREFIX = 'socialTaskLock:';
const RATE_LIMIT_PREFIX = 'socialTaskRateLimit:';
const REFRESH_ALARM_PREFIX = 'socialTaskRefresh:';
const LEASE_MS = 90 * 1000;

// ICC_* 兼容到 v2.1.0；所有新调用统一使用 SC_* 和显式 platformId。
const LEGACY_MESSAGE_TYPES = Object.freeze({
  ICC_LAUNCH: 'SC_LAUNCH',
  ICC_PAUSE: 'SC_PAUSE',
  ICC_STOP: 'SC_STOP',
  ICC_PING: 'SC_PING',
  ICC_SCHEDULE_REFRESH: 'SC_SCHEDULE_REFRESH',
  ICC_CANCEL_REFRESH: 'SC_CANCEL_REFRESH',
  ICC_GET_SETTINGS: 'SC_GET_SETTINGS',
  ICC_ACQUIRE_LOCK: 'SC_ACQUIRE_LOCK',
  ICC_RELEASE_LOCK: 'SC_RELEASE_LOCK',
  ICC_RENEW_LOCK: 'SC_RENEW_LOCK',
  ICC_RATE_ACQUIRE: 'SC_RATE_ACQUIRE',
  ICC_SAVE_SESSION: 'SC_SAVE_SESSION',
  ICC_GET_SESSION: 'SC_GET_SESSION',
  ICC_CLEAR_SESSION: 'SC_CLEAR_SESSION',
});

function resolveTarget(value, requestedPlatformId = '') {
  const registry = globalThis.SocialCommentPlatformRegistry;
  const plugin = requestedPlatformId ? registry?.get(requestedPlatformId) : registry?.resolve(value);
  if (!plugin) return null;
  const canonicalTargetUrl = plugin.identity.normalizeTargetUrl(value);
  if (!canonicalTargetUrl) return null;
  return Object.freeze({ platformId: plugin.id, canonicalTargetUrl, plugin });
}

function messageTarget(message) {
  return resolveTarget(message?.canonicalTargetUrl || message?.targetUrl || '', message?.platformId);
}

function refreshAlarmName(target) { return `${REFRESH_ALARM_PREFIX}${target.platformId}:${encodeURIComponent(target.canonicalTargetUrl)}`; }
function snapshotKey(target) { return `${SNAPSHOT_PREFIX}${target.platformId}:${target.canonicalTargetUrl}`; }
function lockKey(target) { return `${LOCK_PREFIX}${target.platformId}:${target.canonicalTargetUrl}`; }
function rateLimitKey(target) { return `${RATE_LIMIT_PREFIX}${target.platformId}:${target.canonicalTargetUrl}`; }
function clearRefreshAlarm(target) { return chrome.alarms.clear(refreshAlarmName(target)); }
function scheduleRefreshAlarm(target, when) {
  return chrome.alarms.create(refreshAlarmName(target), { when: Math.max(Date.now() + 1000, Number(when) || Date.now() + 1000) });
}

function parseAlarmTarget(name) {
  if (!name.startsWith(REFRESH_ALARM_PREFIX)) return null;
  const suffix = name.slice(REFRESH_ALARM_PREFIX.length);
  const delimiter = suffix.indexOf(':');
  if (delimiter < 1) return null;
  const platformId = suffix.slice(0, delimiter);
  const url = decodeURIComponent(suffix.slice(delimiter + 1));
  return resolveTarget(url, platformId);
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

async function findTargetTab(target) {
  const tabs = await chrome.tabs.query({});
  return tabs.find((tab) => {
    const resolved = resolveTarget(tab.url || '', target.platformId);
    return resolved?.canonicalTargetUrl === target.canonicalTargetUrl;
  }) || null;
}

async function launchOnTargetTab(target, mode) {
  const existingTab = await findTargetTab(target);
  const tab = existingTab?.id
    ? await chrome.tabs.update(existingTab.id, { active: true, url: target.canonicalTargetUrl })
    : await chrome.tabs.create({ active: true, url: target.canonicalTargetUrl });
  await waitForTabLoad(tab.id);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: mode === 'preview' ? 'SC_PREVIEW' : 'SC_START',
      platformId: target.platformId,
      canonicalTargetUrl: target.canonicalTargetUrl,
    }).catch(() => null);
    if (response?.ok) return response;
    await new Promise((done) => setTimeout(done, 400));
  }
  return { ok: false, reason: '当前页面尚未加载清理器，请等待页面完成加载后重试。' };
}

async function controlTargetTab(target, type) {
  const tab = await findTargetTab(target);
  if (!tab?.id) return { ok: false, reason: '尚未找到已打开的目标帖子，请先点击“开始”。' };
  const response = await chrome.tabs.sendMessage(tab.id, {
    type,
    platformId: target.platformId,
    canonicalTargetUrl: target.canonicalTargetUrl,
  }).catch(() => null);
  return response?.ok ? response : { ok: false, reason: '目标页面尚未加载清理器，请等待页面完成加载后重试。' };
}

function normalizeMessage(message) {
  const type = LEGACY_MESSAGE_TYPES[message?.type] || message?.type || '';
  const target = messageTarget(message);
  return { ...message, type, platformId: message?.platformId || target?.platformId || '', canonicalTargetUrl: message?.canonicalTargetUrl || target?.canonicalTargetUrl || '' };
}

chrome.runtime.onInstalled.addListener(() => {
  console.info('[社交评论清理器] installed');
});

chrome.alarms?.onAlarm.addListener((alarm) => {
  const target = parseAlarmTarget(alarm.name);
  if (!target) return;
  (async () => {
    const key = snapshotKey(target);
    const stored = (await chrome.storage.local.get(key))[key];
    const snapshot = globalThis.SocialCommentTaskSession?.normalize(stored) || stored;
    if (!snapshot || !['scheduled-rest', 'refreshing'].includes(snapshot.status)) return;
    if (snapshot.status === 'scheduled-rest' && Number(snapshot.refresh?.nextRefreshAt) > Date.now()) {
      await scheduleRefreshAlarm(target, snapshot.refresh.nextRefreshAt);
      return;
    }
    const tab = await findTargetTab(target);
    if (!tab?.id) {
      await chrome.storage.local.set({ [key]: { ...snapshot, status: 'paused', reason: '目标标签页已关闭，自动刷新已暂停。', lastCheckpointAt: Date.now() } });
      await clearRefreshAlarm(target);
      return;
    }
    await chrome.storage.local.set({ [key]: { ...snapshot, status: 'refreshing', reason: '本轮休息结束，正在刷新目标页面。', lastCheckpointAt: Date.now() } });
    await clearRefreshAlarm(target);
    try {
      await tabsReload(tab.id);
      await waitForTabLoad(tab.id);
    } catch (error) {
      await chrome.storage.local.set({ [key]: { ...snapshot, status: 'paused', reason: `自动刷新失败：${error.message || '未知错误'}`, lastCheckpointAt: Date.now() } });
    }
  })().catch((error) => console.warn('[社交评论清理器] 自动刷新失败', error));
});

chrome.runtime.onMessage.addListener((rawMessage, sender, sendResponse) => {
  const message = normalizeMessage(rawMessage);
  if (message.type === 'SC_PING') {
    sendResponse({ ok: true });
    return false;
  }
  if (!message.type?.startsWith('SC_')) return false;
  (async () => {
    if (message.type === 'SC_GET_SETTINGS') {
      const storageArea = chrome.storage?.sync || chrome.storage?.local;
      if (!storageArea?.get) return sendResponse({ ok: false, reason: '扩展设置存储不可用。' });
      const stored = await storageArea.get('socialCommentCleanerSettings');
      return sendResponse({ ok: true, settings: stored?.socialCommentCleanerSettings || {} });
    }
    const target = messageTarget(message);
    if (!target) return sendResponse({ ok: false, reason: '目标 URL 无效。' });
    if (message.type === 'SC_LAUNCH') return sendResponse(await launchOnTargetTab(target, message.mode));
    if (['SC_PAUSE', 'SC_STOP'].includes(message.type)) return sendResponse(await controlTargetTab(target, message.type));
    if (message.type === 'SC_SCHEDULE_REFRESH' || message.type === 'SC_CANCEL_REFRESH') {
      if (message.type === 'SC_CANCEL_REFRESH') {
        await clearRefreshAlarm(target);
        return sendResponse({ ok: true });
      }
      await scheduleRefreshAlarm(target, message.nextRefreshAt);
      const currentLock = (await chrome.storage.local.get(lockKey(target)))[lockKey(target)];
      if (currentLock?.tabId === sender.tab?.id) {
        await chrome.storage.local.set({ [lockKey(target)]: { ...currentLock, expiresAt: Math.max(currentLock.expiresAt || 0, Number(message.nextRefreshAt) + LEASE_MS) } });
      }
      return sendResponse({ ok: true, nextRefreshAt: Number(message.nextRefreshAt) });
    }
    const key = lockKey(target);
    if (message.type === 'SC_ACQUIRE_LOCK') {
      const current = (await chrome.storage.local.get(key))[key];
      const now = Date.now();
      if (current && current.tabId !== sender.tab?.id && current.expiresAt > now) return sendResponse({ ok: false, reason: '该帖子正在另一标签页运行。' });
      await chrome.storage.local.set({ [key]: { tabId: sender.tab?.id, expiresAt: now + LEASE_MS } });
      return sendResponse({ ok: true });
    }
    if (message.type === 'SC_RELEASE_LOCK') {
      const current = (await chrome.storage.local.get(key))[key];
      if (!current || current.tabId === sender.tab?.id) await chrome.storage.local.remove(key);
      return sendResponse({ ok: true });
    }
    if (message.type === 'SC_RENEW_LOCK') {
      const current = (await chrome.storage.local.get(key))[key];
      if (!current || current.tabId !== sender.tab?.id) return sendResponse({ ok: false, reason: '帖子锁已失效。' });
      await chrome.storage.local.set({ [key]: { ...current, expiresAt: Date.now() + LEASE_MS } });
      return sendResponse({ ok: true });
    }
    if (message.type === 'SC_RATE_ACQUIRE') {
      const limitKey = rateLimitKey(target);
      const stored = (await chrome.storage.local.get(limitKey))[limitKey];
      const limiter = new globalThis.SocialCommentRateLimiter(stored);
      const result = limiter.acquire(message.limits || { perMinute: 5, perHour: 60 });
      await chrome.storage.local.set({ [limitKey]: limiter.snapshot() });
      return sendResponse(result);
    }
    const sessionKey = snapshotKey(target);
    if (message.type === 'SC_SAVE_SESSION') {
      await chrome.storage.local.set({ [sessionKey]: { ...message.snapshot, ownerTabId: sender.tab?.id || message.snapshot?.ownerTabId || null } });
      return sendResponse({ ok: true });
    }
    if (message.type === 'SC_GET_SESSION') return sendResponse({ ok: true, snapshot: (await chrome.storage.local.get(sessionKey))[sessionKey] || null });
    if (message.type === 'SC_CLEAR_SESSION') {
      await chrome.storage.local.remove(sessionKey);
      await clearRefreshAlarm(target);
      return sendResponse({ ok: true });
    }
    return sendResponse({ ok: false, reason: `不支持的消息类型：${message.type}` });
  })().catch((error) => sendResponse({ ok: false, reason: error.message }));
  return true;
});
