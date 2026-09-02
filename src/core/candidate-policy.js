(function (global) {
  'use strict';

  function normalizeUsername(value) {
    return String(value || '').trim().replace(/^@+/, '').toLocaleLowerCase();
  }

  function normalizeLines(value, mapper) {
    return [...new Set(String(value || '').split(/\r?\n/).map(mapper).filter(Boolean))];
  }

  function prepareRules(settings = {}) {
    return {
      whitelist: new Set(normalizeLines(settings.whitelist, normalizeUsername)),
      keywords: normalizeLines(settings.deleteKeywords, (line) => line.trim().toLocaleLowerCase()),
    };
  }

  function isWhitelisted(record, rules) {
    return rules.whitelist.has(normalizeUsername(record?.username));
  }

  // 内容作者的任何评论和回复均受保护，优先级高于关键词策略。
  function isAuthorComment(record, rules = {}) {
    return Boolean(record?.isPostAuthor) || (
      Boolean(rules.authorUsername) &&
      normalizeUsername(record?.username) === normalizeUsername(rules.authorUsername)
    );
  }

  function matchesKeyword(record, rules) {
    const text = String(record?.text || '').toLocaleLowerCase();
    return rules.keywords.some((keyword) => text.includes(keyword));
  }

  function replyItems(replies, parent, result = []) {
    for (const reply of replies || []) {
      result.push({ reply, parent });
      replyItems(reply.replies, parent, result);
    }
    return result;
  }

  function selectCandidates(threads, rules, capabilities = {}) {
    const candidates = [];
    const skippedIds = [];
    let scanned = 0;
    let skipped = 0;
    if (capabilities.supportsReplies === false) return { candidates, skippedIds, scanned, skipped };
    for (const thread of threads || []) {
      const descendants = replyItems(thread.replies, thread);
      scanned += descendants.length;
      for (const { reply, parent } of descendants) {
        if (isAuthorComment(reply, rules) || isWhitelisted(reply, rules)) {
          skipped += 1;
          if (reply.id) skippedIds.push(String(reply.id));
          continue;
        }
        if (matchesKeyword(reply, rules)) candidates.push({ ...reply, kind: 'reply', parent });
      }
    }
    return { candidates, skippedIds, scanned, skipped };
  }

  global.SocialCommentCandidatePolicy = Object.freeze({
    normalizeUsername,
    normalizeLines,
    prepareRules,
    isWhitelisted,
    isAuthorComment,
    matchesKeyword,
    selectCandidates,
  });
})(globalThis);
