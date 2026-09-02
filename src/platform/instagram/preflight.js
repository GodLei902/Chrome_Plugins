(function (global) {
  'use strict';

  const contract = global.SocialCommentPlatformContract;
  const surfaceApi = global.SocialCommentInstagramSurface;
  const comments = global.SocialCommentInstagramComments;

  function documentFor(value) { return value?.document || value || global.document; }
  function pageText(page) { return String(documentFor(page)?.body?.innerText || ''); }
  function success(details = {}) { return contract.createActionResult(true, details); }

  function detectLogin(page) {
    const text = pageText(page);
    if (/log\s*in|sign\s*up|登录|ログイン/i.test(text) && !surfaceApi.commentLinksIn(documentFor(page)).length) {
      return contract.createActionResult(false, { code: 'permission', message: '当前未确认登录状态，已暂停。' });
    }
    return success({ state: 'ready' });
  }

  function detectPageState(page) {
    if (/(challenge_required|try again later|验证|verification|rate limit)/i.test(pageText(page))) {
      return contract.createActionResult(false, { code: 'challenge', message: '检测到验证、限流或异常页面，已暂停。' });
    }
    return success({ state: 'ready' });
  }

  function checkTarget(page, target) {
    const current = global.SocialCommentInstagramIdentity?.normalizeTargetUrl?.(documentFor(page)?.location?.href || global.location?.href || '');
    if (!current || !target?.canonicalUrl || current !== target.canonicalUrl) return contract.createActionResult(false, { code: 'not-found', message: '当前 URL 与设置的目标帖子不匹配。' });
    return success({ target });
  }

  function getCurrentAccount(page) {
    const documentRef = documentFor(page);
    const meta = documentRef?.querySelector?.('meta[property="og:title"]')?.content || '';
    return { id: '', username: String(meta || '').trim() };
  }

  function getContentOwner(page, target) {
    const surface = global.SocialCommentInstagramSurface?.discover?.(documentFor(page));
    const username = comments?.postAuthorUsername?.(surface) || '';
    return username ? { id: '', username } : null;
  }

  function compareAccounts(left, right) {
    return Boolean(left?.id && right?.id ? String(left.id) === String(right.id) : String(left?.username || '').replace(/^@+/, '').toLocaleLowerCase() === String(right?.username || '').replace(/^@+/, '').toLocaleLowerCase());
  }

  // 真正的删除权限仍在菜单动作中二次验证；前置阶段不能在 Preview 或执行前猜测权限。
  function checkDeletePermission(page, target) {
    const owner = getContentOwner(page, target);
    if (!owner) return contract.createActionResult(false, { code: 'ambiguous', message: '无法确认内容作者，已暂停。' });
    return success({ owner, canDelete: true });
  }

  function getRestrictionReason(page) {
    const state = detectPageState(page);
    return state.ok ? '' : state.error.message;
  }

  global.SocialCommentInstagramPreflight = Object.freeze({
    detectLogin,
    detectPageState,
    checkTarget,
    checkDeletePermission,
    getCurrentAccount,
    getContentOwner,
    compareAccounts,
    getRestrictionReason,
  });
})(globalThis);
