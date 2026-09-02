(function (global) {
  'use strict';

  const KINDS = Object.freeze(['root', 'reply']);

  function normalizeId(value) {
    return String(value || '').trim();
  }

  // 元素引用只能在当前页面动作周期内使用，序列化前必须剥离。
  function normalizeRecord(record = {}) {
    const parentId = normalizeId(record.parentId);
    const kind = record.kind === 'root' || record.kind === 'reply'
      ? record.kind
      : (parentId ? 'reply' : 'root');
    return {
      id: normalizeId(record.id),
      parentId,
      kind,
      username: String(record.username || '').trim(),
      authorId: normalizeId(record.authorId),
      text: String(record.text || '').trim(),
      isPostAuthor: Boolean(record.isPostAuthor),
      childCount: Math.max(0, Number(record.childCount) || 0),
      hasUnloadedReplies: Boolean(record.hasUnloadedReplies),
      element: record.element || null,
      platform: record.platform && typeof record.platform === 'object' ? { ...record.platform } : {},
    };
  }

  function isValidRecord(record) {
    return Boolean(record && normalizeId(record.id) && KINDS.includes(record.kind || (record.parentId ? 'reply' : 'root')));
  }

  function forStorage(record) {
    const normalized = normalizeRecord(record);
    const { element, ...serializable } = normalized;
    void element;
    return serializable;
  }

  global.SocialCommentTypes = Object.freeze({ KINDS, normalizeId, normalizeRecord, isValidRecord, forStorage });
})(globalThis);
