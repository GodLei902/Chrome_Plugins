(function (global) {
  'use strict';
  function backoffDelayMs(config, failureCount, random = Math.random) {
    const base = Math.min(config.maxSeconds, config.baseSeconds * (2 ** Math.max(0, failureCount - 1)));
    const jitter = 1 - config.jitterRatio + random() * config.jitterRatio * 2;
    return Math.round(base * jitter * 1000);
  }
  global.InstagramCommentBackoff = { backoffDelayMs };
})(globalThis);
