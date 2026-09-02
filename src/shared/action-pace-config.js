(function (global) {
  'use strict';

  // 面向普通用户的默认节奏：扩大单批处理量并缩短休息，同时保留操作间隔与全局限频安全边界。
  const DEFAULTS = {
    operation: { distribution: 'log-normal', meanSeconds: 18, minSeconds: 12, maxSeconds: 30, variability: 'medium' },
    rest: { distribution: 'log-normal', meanSeconds: 60, minSeconds: 45, maxSeconds: 90, variability: 'medium' },
    deleteDialogDelay: { distribution: 'log-normal', meanSeconds: 20, minSeconds: 5, maxSeconds: 25, variability: 'medium' },
    refreshRest: { distribution: 'log-normal', meanSeconds: 1800, minSeconds: 600, maxSeconds: 3600, variability: 'medium' },
    maxConsecutive: 20,
    rateLimit: { perMinute: 5, perHour: 60 },
    backoff: { baseSeconds: 30, maxSeconds: 900, jitterRatio: 0.25, maxFailures: 3 },
    // 连续加载和批次间休息是内置安全策略，不暴露给用户配置。
    pagination: {
      enabled: true,
      maxBatches: 20,
      noGrowthAttempts: 3,
      stableWaitMs: 800,
      waitTimeoutMs: 8000,
      allowDeletion: true,
      batchRest: { distribution: 'log-normal', meanSeconds: 12, minSeconds: 6, maxSeconds: 20, variability: 'medium' },
    },
  };

  function positive(value, fallback) { return Number(value) > 0 ? Number(value) : fallback; }
  function sessionLimit(value) {
    if (String(value || '').trim().toLocaleLowerCase() === 'unlimited' || Number(value) === 0) return 'unlimited';
    return positive(value, 100);
  }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function normalizeDistribution(raw, fallback) {
    const source = raw || {};
    const hasSourceValues = Object.keys(source).length > 0;
    const minSeconds = positive(source.minSeconds, fallback.minSeconds);
    const maxSeconds = positive(source.maxSeconds, fallback.maxSeconds);
    return {
      distribution: source.distribution === 'gamma' ? 'gamma' : 'log-normal',
      minSeconds,
      maxSeconds,
      // 完全没有保存过该配置时使用产品默认平均值；只有旧配置提供了边界时才取边界中点迁移。
      meanSeconds: positive(source.meanSeconds, hasSourceValues ? (minSeconds + maxSeconds) / 2 : fallback.meanSeconds),
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
      // 平台由注册中心在配置边界补全；共享配置不假设任何具体平台。
      platform: String(source.platformId || source.platform || ''),
      platformId: String(source.platformId || source.platform || ''),
      targetPostUrl: typeof (source.targetUrl || source.targetPostUrl) === 'string' ? String(source.targetUrl || source.targetPostUrl).trim() : '',
      targetUrl: typeof (source.targetUrl || source.targetPostUrl) === 'string' ? String(source.targetUrl || source.targetPostUrl).trim() : '',
      platformOptions: source.platformOptions && typeof source.platformOptions === 'object' ? clone(source.platformOptions) : {},
      whitelist: typeof source.whitelist === 'string' ? source.whitelist.trim() : '',
      deleteKeywords: typeof source.deleteKeywords === 'string' ? source.deleteKeywords.trim() : '',
      // 自动加载和正式运行跟随加载固定开启；忽略旧版本保存的开关，避免旧设置改变安全边界。
      pagination: {
        enabled: DEFAULTS.pagination.enabled,
        maxBatches: DEFAULTS.pagination.maxBatches,
        noGrowthAttempts: DEFAULTS.pagination.noGrowthAttempts,
        stableWaitMs: DEFAULTS.pagination.stableWaitMs,
        waitTimeoutMs: DEFAULTS.pagination.waitTimeoutMs,
        allowDeletion: DEFAULTS.pagination.allowDeletion,
        batchRest: clone(DEFAULTS.pagination.batchRest),
      },
      // 使用字符串保存“不限”，避免 Infinity 序列化到 chrome.storage 后变成 null。
      sessionLimit: sessionLimit(source.sessionLimit),
      // 0 表示持续运行；填写正数时仍可设置额外的会话最长时间安全上限。
      sessionMaxMinutes: Number(source.sessionMaxMinutes) > 0 ? Number(source.sessionMaxMinutes) : 0,
      pace: {
        operation, rest,
        deleteDialogDelay: normalizeDistribution(pace.deleteDialogDelay, DEFAULTS.deleteDialogDelay),
        refreshRest: global.SocialCommentScheduledRest?.normalize ? global.SocialCommentScheduledRest.normalize(pace.refreshRest) : normalizeDistribution(pace.refreshRest, DEFAULTS.refreshRest),
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
    const deleteDialogDelay = settings.pace.deleteDialogDelay;
    if (deleteDialogDelay.minSeconds > deleteDialogDelay.maxSeconds || deleteDialogDelay.meanSeconds < deleteDialogDelay.minSeconds || deleteDialogDelay.meanSeconds > deleteDialogDelay.maxSeconds) {
      throw new Error('点击删除前等待时间的最短值、平均值和最长值必须按从小到大填写。');
    }
    const rawRefreshRest = raw?.pace?.refreshRest || {};
    const rawRefreshValues = ['minSeconds', 'meanSeconds', 'maxSeconds'].map((key) => Number(rawRefreshRest[key])).filter(Number.isFinite);
    if (rawRefreshValues.some((value) => value < 600 || value > 3600)) throw new Error('本轮完成后的刷新休息时间必须在 10～60 分钟内。');
    const refreshRest = settings.pace.refreshRest;
    if (refreshRest.minSeconds < 600 || refreshRest.maxSeconds > 3600 || refreshRest.minSeconds > refreshRest.maxSeconds || refreshRest.meanSeconds < refreshRest.minSeconds || refreshRest.meanSeconds > refreshRest.maxSeconds) throw new Error('本轮完成后的刷新休息时间必须在 10～60 分钟内，且最短、平均、最长值按从小到大填写。');
    if (settings.pagination.maxBatches < 1 || settings.pagination.noGrowthAttempts < 1 || settings.pagination.stableWaitMs < 1) {
      throw new Error('自动加载批次、无新增重试次数和稳定等待时间必须为正数。');
    }
    if (settings.pace.backoff.baseSeconds > settings.pace.backoff.maxSeconds) throw new Error('最长重试等待时间不能小于首次重试等待时间。');
    if (settings.sessionLimit !== 'unlimited' && settings.sessionLimit < 1) throw new Error('本次删除上限必须为正数或选择不限。');
    return settings;
  }
  global.SocialCommentPaceConfig = { DEFAULTS: clone(DEFAULTS), normalizeSettings, validateSettings };
})(globalThis);
