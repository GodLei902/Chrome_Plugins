(function (global) {
  'use strict';

  const contract = global.SocialCommentPlatformContract;
  if (!contract) throw new Error('平台注册中心必须在 platform/contract.js 之后加载。');

  const plugins = new Map();

  function register(plugin) {
    const normalized = contract.validatePlugin(plugin);
    const existing = plugins.get(normalized.id);
    if (existing && existing !== plugin) {
      // 同一页面重复加载脚本时允许幂等注册，但禁止静默替换不同实现。
      if (existing.displayName !== normalized.displayName) throw new Error(`平台插件已注册：${normalized.id}`);
      return existing;
    }
    plugins.set(normalized.id, normalized);
    return normalized;
  }

  function get(id) {
    return plugins.get(String(id || '')) || null;
  }

  function all() {
    return [...plugins.values()];
  }

  function resolve(value) {
    return all().find((plugin) => {
      try { return plugin.identity.isTargetUrl(value); } catch { return false; }
    }) || null;
  }

  global.SocialCommentPlatformRegistry = Object.freeze({ register, get, all, resolve });
})(globalThis);
