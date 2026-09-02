(function (global) {
  'use strict';

  const contract = global.SocialCommentPlatformContract;

  function classify(error) {
    if (error?.code && contract.isErrorCode(error.code)) return contract.createPlatformError(error.code, error.message || 'Instagram 页面操作失败。');
    const message = String(error?.message || error || 'Instagram 页面状态未知。');
    if (/(challenge|required|验证|verification|rate limit|try again later)/i.test(message)) return contract.createPlatformError('challenge', message);
    if (/(权限|permission|not authorized)/i.test(message)) return contract.createPlatformError('permission', message);
    if (/(多个|歧义|ambiguous|无法确认|不明确)/i.test(message)) return contract.createPlatformError('ambiguous', message);
    if (/(找不到|未找到|not found)/i.test(message)) return contract.createPlatformError('not-found', message);
    if (/(取消|cancelled)/i.test(message)) return contract.createPlatformError('cancelled', message);
    return contract.createPlatformError('unknown', message);
  }

  function toUserMessage(error) { return String(error?.message || 'Instagram 页面状态未知。'); }
  function isRetryable(error) { return ['not-ready', 'rate-limited'].includes(error?.code); }

  global.SocialCommentInstagramErrors = Object.freeze({ classify, toUserMessage, isRetryable });
})(globalThis);
