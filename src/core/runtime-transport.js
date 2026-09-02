(function (global) {
  'use strict';

  function create({ platformId, canonicalTargetUrl, sendMessage } = {}) {
    const send = typeof sendMessage === 'function'
      ? sendMessage
      : (message) => {
        try {
          if (!global.chrome?.runtime?.id) return Promise.resolve({ ok: false, reason: '扩展上下文已失效，请刷新页面。' });
          return global.chrome.runtime.sendMessage(message).catch(() => ({ ok: false, reason: '扩展后台不可用，请刷新页面。' }));
        } catch {
          return Promise.resolve({ ok: false, reason: '扩展上下文已失效，请刷新页面。' });
        }
      };
    return Object.freeze({
      send(type, details = {}) {
        return send({ type, platformId: String(details.platformId || platformId || ''), canonicalTargetUrl: String(details.canonicalTargetUrl || canonicalTargetUrl || ''), ...details });
      },
    });
  }

  global.SocialCommentRuntimeTransport = Object.freeze({ create });
})(globalThis);
