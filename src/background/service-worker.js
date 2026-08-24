importScripts('../shared/rate-limiter.js');

const SNAPSHOT_PREFIX = 'instagramCommentCleanerSession:';
const LOCK_PREFIX = 'instagramCommentCleanerLock:';
const RATE_LIMIT_KEY = 'instagramCommentCleanerRateLimit';
const LEASE_MS = 90 * 1000;
const DEBUGGER_VERSION = '1.3';

function normalizeTargetUrl(value) {
  try {
    const url = new URL(value);
    const match = url.pathname.match(/^\/(p|reel)\/([^/]+)\/?$/i);
    if (!['instagram.com', 'www.instagram.com'].includes(url.hostname.toLowerCase()) || !match) return '';
    return `https://www.instagram.com/${match[1].toLowerCase()}/${match[2]}/`;
  } catch {
    return '';
  }
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

function debuggerAttach(target) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach(target, DEBUGGER_VERSION, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

function debuggerDetach(target) {
  return new Promise((resolve) => {
    chrome.debugger.detach(target, () => {
      resolve();
    });
  });
}

function debuggerSendCommand(target, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

async function hoverCommentAtPoint(tabId, x, y) {
  const target = { tabId };
  let attached = false;
  try {
    await debuggerAttach(target);
    attached = true;
    // 真实鼠标移动才会触发 Instagram 的 hover 状态，合成 DOM 事件不够。
    await debuggerSendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
      button: 'none',
      buttons: 0,
      pointerType: 'mouse',
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error.message || '无法悬停评论。' };
  } finally {
    if (attached) await debuggerDetach(target).catch(() => {});
  }
}

chrome.runtime.onInstalled.addListener(() => {
  console.info('[社交评论清理器] installed');
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
  if (message?.type === 'ICC_HOVER_COMMENT') {
    (async () => {
      const tabId = sender.tab?.id;
      const x = Number(message.x);
      const y = Number(message.y);
      if (!Number.isFinite(tabId) || !Number.isFinite(x) || !Number.isFinite(y)) return sendResponse({ ok: false, reason: '无法获取当前标签页或悬停坐标。' });
      if (typeof chrome.debugger === 'undefined') return sendResponse({ ok: false, reason: '当前浏览器不支持调试悬停能力，请升级 Chrome。' });
      return sendResponse(await hoverCommentAtPoint(tabId, x, y));
    })().catch((error) => sendResponse({ ok: false, reason: error.message }));
    return true;
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
    if (message.type === 'ICC_RENEW_LOCK') {
      const current = (await chrome.storage.local.get(key))[key];
      if (!current || current.tabId !== sender.tab?.id) return sendResponse({ ok: false, reason: '帖子锁已失效。' });
      await chrome.storage.local.set({ [key]: { ...current, expiresAt: Date.now() + LEASE_MS } });
      return sendResponse({ ok: true });
    }
    if (message.type === 'ICC_RATE_ACQUIRE') {
      const stored = (await chrome.storage.local.get(RATE_LIMIT_KEY))[RATE_LIMIT_KEY];
      const limiter = new InstagramCommentRateLimiter(stored);
      const result = limiter.acquire(message.limits || { perMinute: 5, perHour: 60 });
      await chrome.storage.local.set({ [RATE_LIMIT_KEY]: limiter.snapshot() });
      return sendResponse(result);
    }
    const snapshotKey = `${SNAPSHOT_PREFIX}${message.targetUrl}`;
    if (message.type === 'ICC_SAVE_SESSION') await chrome.storage.local.set({ [snapshotKey]: message.snapshot });
    if (message.type === 'ICC_GET_SESSION') return sendResponse({ ok: true, snapshot: (await chrome.storage.local.get(snapshotKey))[snapshotKey] || null });
    if (message.type === 'ICC_CLEAR_SESSION') await chrome.storage.local.remove(snapshotKey);
    sendResponse({ ok: false, reason: `不支持的消息类型：${message.type}` });
  })().catch((error) => sendResponse({ ok: false, reason: error.message }));
  return true;
});
