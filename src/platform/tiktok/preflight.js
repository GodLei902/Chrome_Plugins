(function (global) {
  'use strict';

  const contract = global.SocialCommentPlatformContract;
  const identity = global.SocialCommentTikTokIdentity;
  if (!contract || !identity) throw new Error('TikTok 预检依赖的平台契约或身份模块未加载。');

  function success(details = {}) {
    return contract.createActionResult(true, details);
  }

  function failure(code, message) {
    return contract.createActionResult(false, { code, message });
  }

  function documentFor(page) {
    return page?.document || page || global.document || null;
  }

  function currentUrl(page) {
    return documentFor(page)?.location?.href || page?.location?.href || global.location?.href || '';
  }

  function pageText(page) {
    const documentRef = documentFor(page);
    return String(documentRef?.body?.innerText || documentRef?.documentElement?.innerText || '');
  }

  function checkTarget(page, target) {
    const expected = identity.normalizeTargetUrl(target?.canonicalUrl || target?.canonicalTargetUrl || '');
    const actual = identity.normalizeTargetUrl(currentUrl(page));
    if (!expected) return failure('not-found', 'TikTok 目标作品 URL 无效。');
    if (!actual) return failure('not-found', '当前页面不是受支持的 TikTok 作品页。');
    if (actual !== expected) return failure('ambiguous', '当前 TikTok 作品页与任务目标不一致。');
    return success({ canonicalUrl: actual });
  }

  // 只识别可明确阻止后续操作的风险页；登录文案可能来自推荐内容，不能据此暂停任务。
  function detectPageState(page) {
    const documentRef = documentFor(page);
    if (!documentRef) return failure('not-ready', 'TikTok 页面文档尚未准备完成。');
    const text = pageText(page);
    if (/(captcha|验证码|安全验证|security\s*check|verify\s*(?:your|to)|challenge)/i.test(text)) {
      return failure('challenge', 'TikTok 页面需要完成安全验证，任务已暂停。');
    }
    if (/(rate\s*limit|too\s*many\s*requests|try\s*again\s*later|操作过于频繁|请求过多|操作频繁)/i.test(text)) {
      return failure('rate-limited', 'TikTok 操作频繁，请稍后重试。');
    }
    if (/(page\s*(?:is\s*)?not\s*available|couldn'?t\s*find\s*(?:this\s*)?page|video\s*unavailable|作品不存在|页面不存在|无法访问)/i.test(text)) {
      return failure('not-found', 'TikTok 作品页不存在或当前不可访问。');
    }
    return success({ state: 'ready' });
  }

  function unsupported(methodName) {
    return contract.createActionResult(false, {
      code: 'unsupported',
      message: `TikTok 预检能力尚未实现：${methodName}`,
    });
  }

  function getRestrictionReason(page) {
    const result = detectPageState(page);
    return result.ok ? '' : result.error.message;
  }

  global.SocialCommentTikTokPreflight = Object.freeze({
    detectLogin: () => unsupported('detectLogin'),
    detectPageState,
    checkTarget,
    checkDeletePermission: () => unsupported('checkDeletePermission'),
    getRestrictionReason,
    getCurrentAccount: () => unsupported('getCurrentAccount'),
    getContentOwner: () => unsupported('getContentOwner'),
  });
})(globalThis);
