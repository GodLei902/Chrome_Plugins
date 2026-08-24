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

  // 帖子作者的评论和回复始终保留，优先级高于关键词匹配。
  function isAuthorComment(comment, rules) {
    return Boolean(comment.isPostAuthor) || (
      Boolean(rules.authorUsername) &&
      normalizeUsername(comment.username) === normalizeUsername(rules.authorUsername)
    );
  }

  function matchesKeyword(comment, rules) {
    const text = String(comment.text || '').toLocaleLowerCase();
    return rules.keywords.some((keyword) => text.includes(keyword));
  }

  // Instagram 偶尔会把回复组织成多层 parent_comment_id；递归展开后，
  // 无论父级作者是谁，只要当前回复命中规则就能进入候选。
  function replyItems(replies, parent, result = []) {
    for (const reply of replies || []) {
      result.push({ reply, parent });
      replyItems(reply.replies, parent, result);
    }
    return result;
  }

  function selectCandidates(threads, rules) {
    const candidates = [];
    const skippedIds = [];
    let scanned = 0;
    let skipped = 0;
    for (const thread of threads) {
      const descendants = replyItems(thread.replies, thread);
      scanned += descendants.length;
      for (const { reply, parent } of descendants) {
        if (isAuthorComment(reply, rules) || isWhitelisted(reply, rules)) { skipped++; if (reply.id) skippedIds.push(reply.id); continue; }
        if (matchesKeyword(reply, rules)) candidates.push({ ...reply, kind: 'reply', parent });
      }
    }
    return { candidates, skippedIds, scanned, skipped };
  }

  global.InstagramCommentRules = { normalizeUsername, normalizeTargetUrl, prepareRules, isWhitelisted, isAuthorComment, matchesKeyword, selectCandidates };
})(globalThis);
