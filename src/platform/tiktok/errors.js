(function (global) {
  'use strict';

  const contract = global.SocialCommentPlatformContract;
  if (!contract) throw new Error('TikTok 错误模块依赖的平台契约未加载。');

  const DEFAULT_MESSAGES = Object.freeze({
    permission: 'TikTok 登录或删除权限无法确认，任务已暂停。',
    challenge: 'TikTok 要求完成安全验证，任务已暂停。',
    'rate-limited': 'TikTok 操作频繁，请稍后重试。',
    'not-ready': 'TikTok 页面尚未准备完成。',
    ambiguous: 'TikTok 页面目标不唯一，任务已安全暂停。',
    'not-found': 'TikTok 作品或目标页面不存在。',
    unsupported: '当前 TikTok 能力尚未实现，任务已暂停。',
    cancelled: 'TikTok 操作已取消。',
    unknown: 'TikTok 页面出现未知异常，任务已暂停。',
  });

  function classify(error) {
    const code = contract.isErrorCode(error?.code) ? error.code : 'unknown';
    return contract.createPlatformError(code, error?.message || DEFAULT_MESSAGES[code], error?.details || {});
  }

  function toUserMessage(error) {
    const classified = classify(error);
    return classified.message || DEFAULT_MESSAGES[classified.code];
  }

  function isRetryable(error) {
    return ['not-ready', 'rate-limited'].includes(classify(error).code);
  }

  global.SocialCommentTikTokErrors = Object.freeze({ classify, toUserMessage, isRetryable });
})(globalThis);
