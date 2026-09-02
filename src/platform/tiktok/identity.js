(function (global) {
  'use strict';

  const APPROVED_HOST = 'www.tiktok.com';
  const VIDEO_PATH = /^\/@([^/]+)\/video\/(\d+)\/?$/;

  function normalizeHandle(value) {
    return String(value || '').trim().replace(/^@+/, '').toLocaleLowerCase();
  }

  function normalizeTargetUrl(value) {
    try {
      const url = new URL(value);
      const match = url.pathname.match(VIDEO_PATH);
      if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== APPROVED_HOST || !match) return '';
      return `https://${APPROVED_HOST}/@${match[1]}/video/${match[2]}`;
    } catch {
      return '';
    }
  }

  function isTargetUrl(value) {
    return Boolean(normalizeTargetUrl(value));
  }

  function matchesPage(locationLike) {
    return isTargetUrl(locationLike?.href || locationLike);
  }

  function getTargetContext(value) {
    const canonicalUrl = normalizeTargetUrl(value?.href || value);
    if (!canonicalUrl) return null;
    const match = new URL(canonicalUrl).pathname.match(VIDEO_PATH);
    return Object.freeze({
      platformId: 'tiktok',
      canonicalUrl,
      contentId: match[2],
      contentType: 'video',
      creatorHandle: match[1],
      host: APPROVED_HOST,
    });
  }

  function compareAccounts(left, right) {
    const leftHandle = normalizeHandle(left?.username || left?.handle || left);
    const rightHandle = normalizeHandle(right?.username || right?.handle || right);
    return Boolean(leftHandle && rightHandle && leftHandle === rightHandle);
  }

  global.SocialCommentTikTokIdentity = Object.freeze({
    normalizeTargetUrl,
    isTargetUrl,
    matchesPage,
    getTargetContext,
    compareAccounts,
  });
})(globalThis);
