(function (global) {
  'use strict';

  function read(value) {
    try { return new URL(String(value || '')); } catch { return null; }
  }

  function canonical(value) {
    const url = read(value);
    if (!url) return '';
    url.hash = '';
    url.search = '';
    return url.toString();
  }

  global.SocialCommentUrl = Object.freeze({ read, canonical });
})(globalThis);
