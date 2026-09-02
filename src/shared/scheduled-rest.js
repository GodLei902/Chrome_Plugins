(function (global) {
  'use strict';
  const MIN_SECONDS = 10 * 60;
  const MAX_SECONDS = 60 * 60;
  const DEFAULTS = Object.freeze({ distribution: 'log-normal', meanSeconds: 30 * 60, minSeconds: MIN_SECONDS, maxSeconds: MAX_SECONDS, variability: 'medium' });
  function positive(value, fallback) { return Number(value) > 0 ? Number(value) : fallback; }
  function normalize(raw) {
    const source = raw || {};
    const minSeconds = Math.max(MIN_SECONDS, positive(source.minSeconds, DEFAULTS.minSeconds));
    const maxSeconds = Math.min(MAX_SECONDS, positive(source.maxSeconds, DEFAULTS.maxSeconds));
    const boundedMax = Math.max(minSeconds, maxSeconds);
    const meanSeconds = Math.min(boundedMax, Math.max(minSeconds, positive(source.meanSeconds, DEFAULTS.meanSeconds)));
    return { distribution: source.distribution === 'gamma' ? 'gamma' : 'log-normal', meanSeconds, minSeconds, maxSeconds: boundedMax, variability: ['low', 'medium', 'high'].includes(source.variability) ? source.variability : 'medium' };
  }
  function generate(config, random = Math.random) {
    const normalized = normalize(config);
    const generator = global.DelayGenerator;
    return generator?.generateDelayMs ? generator.generateDelayMs(normalized, random) : Math.round((normalized.minSeconds + random() * (normalized.maxSeconds - normalized.minSeconds)) * 1000);
  }
  global.SocialCommentScheduledRest = { DEFAULTS: { ...DEFAULTS }, MIN_SECONDS, MAX_SECONDS, normalize, generate };
})(globalThis);
