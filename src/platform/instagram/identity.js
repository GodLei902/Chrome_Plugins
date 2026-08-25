(function (global) {
  'use strict';

  function normalizeTargetUrl(value) {
    try {
      const url = new URL(value);
      const match = url.pathname.match(/^\/(p|reel)\/([^/]+)\/?$/i);
      if (!['instagram.com', 'www.instagram.com'].includes(url.hostname.toLowerCase()) || !match) return '';
      return `https://www.instagram.com/${match[1].toLowerCase()}/${match[2]}/`;
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
    const canonicalUrl = normalizeTargetUrl(value);
    if (!canonicalUrl) return null;
    const url = new URL(canonicalUrl);
    const [, contentType, contentId] = url.pathname.split('/');
    return Object.freeze({
      platformId: 'instagram',
      canonicalUrl,
      contentId,
      contentType: contentType === 'reel' ? 'reel' : 'post',
      host: url.hostname,
    });
  }

  global.SocialCommentInstagramIdentity = Object.freeze({ normalizeTargetUrl, isTargetUrl, matchesPage, getTargetContext });
})(globalThis);
