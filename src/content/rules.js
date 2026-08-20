(function (global) {
  'use strict';

  function normalizeUsername(value) {
    return String(value || '').trim().replace(/^@+/, '').toLocaleLowerCase();
  }

  function normalizeLines(value, mapper) {
    return [...new Set(String(value || '').split(/\r?\n/).map(mapper).filter(Boolean))];
  }

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

  function prepareRules(settings) {
    return {
      targetUrl: normalizeTargetUrl(settings.targetPostUrl),
      whitelist: new Set(normalizeLines(settings.whitelist, normalizeUsername)),
      keywords: normalizeLines(settings.deleteKeywords, (line) => line.trim().toLocaleLowerCase()),
    };
  }

  function isWhitelisted(comment, rules) {
    return rules.whitelist.has(normalizeUsername(comment.username));
  }

  function matchesKeyword(comment, rules) {
    const text = String(comment.text || '').toLocaleLowerCase();
    return rules.keywords.some((keyword) => text.includes(keyword));
  }

  function selectCandidates(threads, rules) {
    const candidates = [];
    let scanned = 0;
    let skipped = 0;
    for (const thread of threads) {
      scanned += 1 + thread.replies.length;
      for (const reply of thread.replies) {
        if (isWhitelisted(reply, rules)) { skipped++; continue; }
        if (matchesKeyword(reply, rules)) candidates.push({ ...reply, kind: 'reply', parent: thread });
      }
      if (isWhitelisted(thread, rules)) { skipped++; continue; }
      if (thread.replies.some((reply) => isWhitelisted(reply, rules))) { skipped++; continue; }
      if (matchesKeyword(thread, rules)) candidates.push({ ...thread, kind: 'comment' });
    }
    return { candidates: candidates.sort((a, b) => (a.kind === 'reply' ? -1 : 1) - (b.kind === 'reply' ? -1 : 1)), scanned, skipped };
  }

  global.InstagramCommentRules = { normalizeUsername, normalizeTargetUrl, prepareRules, isWhitelisted, matchesKeyword, selectCandidates };
})(globalThis);
