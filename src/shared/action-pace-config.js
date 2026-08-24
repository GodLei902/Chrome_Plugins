(function (global) {
  'use strict';

  const DEFAULTS = {
    operation: { distribution: 'log-normal', meanSeconds: 18, minSeconds: 12, maxSeconds: 30, variability: 'medium' },
    rest: { distribution: 'log-normal', meanSeconds: 180, minSeconds: 120, maxSeconds: 300, variability: 'medium' },
    maxConsecutive: 3,
    rateLimit: { perMinute: 5, perHour: 60 },
    backoff: { baseSeconds: 30, maxSeconds: 900, jitterRatio: 0.25, maxFailures: 3 },
  };

  function positive(value, fallback) { return Number(value) > 0 ? Number(value) : fallback; }
  function sessionLimit(value) {
    if (String(value || '').trim().toLocaleLowerCase() === 'unlimited' || Number(value) === 0) return 'unlimited';
    return positive(value, 30);
  }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function normalizeDistribution(raw, fallback) {
    const source = raw || {};
    const minSeconds = positive(source.minSeconds, fallback.minSeconds);
    const maxSeconds = positive(source.maxSeconds, fallback.maxSeconds);
    return {
      distribution: source.distribution === 'gamma' ? 'gamma' : 'log-normal',
      minSeconds,
      maxSeconds,
      meanSeconds: positive(source.meanSeconds, (minSeconds + maxSeconds) / 2),
      variability: ['low', 'medium', 'high'].includes(source.variability) ? source.variability : 'medium',
    };
  }
  function normalizeSettings(raw) {
    const source = raw || {};
    const pace = source.pace || {};
    // Legacy values are kept readable so existing users receive the new pacing defaults without data loss.
    const operation = normalizeDistribution(pace.operation || (source.deleteDelayMin ? {
      minSeconds: source.deleteDelayMin, maxSeconds: source.deleteDelayMax,
      meanSeconds: (Number(source.deleteDelayMin) + Number(source.deleteDelayMax)) / 2,
    } : null), DEFAULTS.operation);
    const rest = normalizeDistribution(pace.rest || (source.cooldownMin ? {
      minSeconds: source.cooldownMin, maxSeconds: source.cooldownMax,
      meanSeconds: (Number(source.cooldownMin) + Number(source.cooldownMax)) / 2,
    } : null), DEFAULTS.rest);
    return {
      platform: source.platform === 'instagram' ? 'instagram' : 'instagram',
      targetPostUrl: typeof source.targetPostUrl === 'string' ? source.targetPostUrl.trim() : '',
      whitelist: typeof source.whitelist === 'string' ? source.whitelist.trim() : '',
      deleteKeywords: typeof source.deleteKeywords === 'string' ? source.deleteKeywords.trim() : '',
      // 使用字符串保存“不限”，避免 Infinity 序列化到 chrome.storage 后变成 null。
      sessionLimit: sessionLimit(source.sessionLimit),
      sessionMaxMinutes: positive(source.sessionMaxMinutes, 120),
      pace: {
        operation, rest,
        maxConsecutive: positive(pace.maxConsecutive, positive(source.batchLimit, DEFAULTS.maxConsecutive)),
        rateLimit: {
          perMinute: positive(pace.rateLimit?.perMinute, DEFAULTS.rateLimit.perMinute),
          perHour: positive(pace.rateLimit?.perHour, DEFAULTS.rateLimit.perHour),
        },
        backoff: {
          baseSeconds: positive(pace.backoff?.baseSeconds, DEFAULTS.backoff.baseSeconds),
          maxSeconds: positive(pace.backoff?.maxSeconds, DEFAULTS.backoff.maxSeconds),
          jitterRatio: Number.isFinite(Number(pace.backoff?.jitterRatio)) ? Number(pace.backoff.jitterRatio) : DEFAULTS.backoff.jitterRatio,
          maxFailures: positive(pace.backoff?.maxFailures, DEFAULTS.backoff.maxFailures),
        },
      },
    };
  }
  function validateSettings(raw) {
    const settings = normalizeSettings(raw);
    for (const item of [settings.pace.operation, settings.pace.rest]) {
      if (item.minSeconds > item.maxSeconds || item.meanSeconds < item.minSeconds || item.meanSeconds > item.maxSeconds) {
        throw new Error('等待时间的最短值、平均值和最长值必须按从小到大填写。');
      }
    }
    if (settings.pace.backoff.baseSeconds > settings.pace.backoff.maxSeconds) throw new Error('最长重试等待时间不能小于首次重试等待时间。');
    if (settings.sessionLimit !== 'unlimited' && settings.sessionLimit < 1) throw new Error('本次删除上限必须为正数或选择不限。');
    return settings;
  }
  global.InstagramCommentPaceConfig = { DEFAULTS: clone(DEFAULTS), normalizeSettings, validateSettings };
})(globalThis);
