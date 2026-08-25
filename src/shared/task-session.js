(function (global) {
  'use strict';

  // 检查点只保存可序列化数据；页面刷新后的 DOM 引用必须由平台适配器重新发现。
  const STATUS = Object.freeze({ RUNNING: 'running', SCHEDULED_REST: 'scheduled-rest', REFRESHING: 'refreshing', PAUSED: 'paused', STOPPED: 'stopped' });
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function createId(now = Date.now(), random = Math.random) { return `session-${now.toString(36)}-${Math.floor(random() * 0xFFFFFF).toString(16).padStart(6, '0')}`; }
  function normalizeTarget(target, fallbackUrl = '') {
    if (target && typeof target === 'object') return { platform: String(target.platform || 'instagram'), normalizedId: String(target.normalizedId || target.url || fallbackUrl), url: String(target.url || fallbackUrl) };
    return { platform: 'instagram', normalizedId: String(target || fallbackUrl), url: String(fallbackUrl || target || '') };
  }
  function create(options = {}) {
    const target = normalizeTarget(options.target, options.targetUrl);
    return {
      schemaVersion: 1,
      sessionId: String(options.sessionId || createId()),
      target,
      // 保留旧字段，兼容现有按 targetUrl 存储的 Service Worker 消息。
      targetUrl: target.url,
      ownerTabId: Number.isFinite(Number(options.ownerTabId)) ? Number(options.ownerTabId) : null,
      mode: options.mode === 'preview' ? 'preview' : 'run',
      status: options.status || STATUS.RUNNING,
      startedAt: Number(options.startedAt) || Date.now(),
      lastCheckpointAt: Date.now(),
      stats: clone(options.stats || {}),
      processedIds: [...new Set((options.processedIds || []).map(String).filter(Boolean))],
      refresh: {
        count: Number(options.refresh?.count) || 0,
        restStartedAt: Number(options.refresh?.restStartedAt) || 0,
        restDelayMs: Number(options.refresh?.restDelayMs) || 0,
        nextRefreshAt: Number(options.refresh?.nextRefreshAt) || 0,
        lastReason: String(options.refresh?.lastReason || ''),
      },
      pace: clone(options.pace || {}),
      reason: String(options.reason || ''),
    };
  }
  function normalize(snapshot) { return snapshot && typeof snapshot === 'object' ? create(snapshot) : null; }
  function forStorage(snapshot, status, extra = {}) {
    const normalized = normalize({ ...snapshot, status: status || snapshot?.status, ...extra });
    if (!normalized) return null;
    normalized.lastCheckpointAt = Date.now();
    return normalized;
  }
  global.SocialCommentTaskSession = { STATUS, createId, create, normalize, forStorage };
})(globalThis);
