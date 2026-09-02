(function (global) {
  'use strict';
  const SIGMA = { low: 0.2, medium: 0.45, high: 0.7 };
  function normalRandom(random = Math.random) {
    let a = 0; let b = 0;
    while (a === 0) a = random();
    while (b === 0) b = random();
    return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * b);
  }
  function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
  function logNormalSeconds(config, random = Math.random) {
    const sigma = SIGMA[config.variability] || SIGMA.medium;
    const mu = Math.log(config.meanSeconds) - (sigma * sigma) / 2;
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const value = Math.exp(mu + sigma * normalRandom(random));
      if (value >= config.minSeconds && value <= config.maxSeconds) return value;
    }
    return clamp(Math.exp(mu + sigma * normalRandom(random)), config.minSeconds, config.maxSeconds);
  }
  // Kept as a replaceable distribution hook; production defaults to log-normal.
  function gammaSeconds(config, random = Math.random) { return logNormalSeconds(config, random); }
  function generateDelayMs(config, random = Math.random) {
    const seconds = config.distribution === 'gamma' ? gammaSeconds(config, random) : logNormalSeconds(config, random);
    return Math.round(seconds * 1000);
  }
  const api = { normalRandom, logNormalSeconds, gammaSeconds, generateDelayMs };
  global.DelayGenerator = api;
})(globalThis);
