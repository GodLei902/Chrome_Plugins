(function (global) {
  'use strict';

  const contract = global.SocialCommentPlatformContract;
  const types = global.SocialCommentTypes;
  const dom = global.SocialCommentTikTokDom;
  if (!contract || !types || !dom) throw new Error('TikTok 评论解析依赖的基础模块未加载。');

  function digest(value) {
    let hash = 2166136261;
    for (const character of String(value || '')) {
      hash ^= character.codePointAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function targetFor(context) { return context?.target || context || {}; }

  function stableKey(element, context, parentId = '') {
    const target = targetFor(context);
    // 不把相对时间写进长期稳定键；时间变化后不能以相似文本继续操作。
    return [target.contentId || '', dom.bodyLevel(element) === 2 ? 'reply' : 'root', parentId, String(dom.getAuthor(element) || '').toLocaleLowerCase(), digest(dom.getText(element))].join(':');
  }

  function toRecord(element, context = {}) {
    const body = dom.locateBody(element);
    const row = dom.locateRow(body);
    if (!body || !row) return contract.createActionResult(false, { code: 'not-found', message: '目标节点不是已确认的 TikTok 评论行。' });
    const username = dom.getAuthor(body);
    const text = dom.getText(body);
    if (!username || !text) return contract.createActionResult(false, { code: 'ambiguous', message: 'TikTok 评论行内作者或正文证据不唯一。' });
    let parentId = '';
    if (dom.bodyLevel(body) === 2) {
      const parent = dom.getParentBody(body);
      if (!parent) return contract.createActionResult(false, { code: 'ambiguous', message: 'TikTok 回复缺少唯一的一级评论父级。' });
      const parentRecord = toRecord(parent, context);
      if (!parentRecord.ok) return parentRecord;
      parentId = parentRecord.record.id;
    }
    return contract.createActionResult(true, {
      record: types.normalizeRecord({
        id: stableKey(body, context, parentId),
        parentId,
        kind: parentId ? 'reply' : 'root',
        username,
        text,
        // 仅以当前行作者区域的 Creator 徽标保护，正文和页面其他区域不参与判断。
        isPostAuthor: dom.isCreator(body),
        element: row,
        platform: {},
      }),
    });
  }

  function collect(surface, context = {}) {
    if (!surface?.isConnected) return contract.createActionResult(false, { code: 'not-ready', message: 'TikTok 评论面已失效，需要重新发现。' });
    const records = [];
    const ids = new Set();
    for (const body of dom.findBodies(surface).filter(dom.isVisible)) {
      const result = toRecord(body, context);
      if (!result.ok) return result;
      if (ids.has(result.record.id)) return contract.createActionResult(false, { code: 'ambiguous', message: 'TikTok 评论稳定键重复，无法安全区分目标行。' });
      ids.add(result.record.id);
      records.push(result.record);
    }
    return contract.createActionResult(true, { records });
  }

  function buildThreads(records = {}) {
    const rows = Array.isArray(records) ? records : [];
    const threads = new Map(rows.filter((record) => record?.kind === 'root').map((record) => [record.id, { ...record, replies: [], hasUnloadedReplies: false }]));
    for (const record of rows.filter((item) => item?.kind === 'reply')) {
      const parent = threads.get(record.parentId);
      if (!parent) return contract.createActionResult(false, { code: 'ambiguous', message: 'TikTok 回复无法映射到唯一一级评论线程。' });
      parent.replies.push(record);
    }
    return contract.createActionResult(true, { threads: [...threads.values()] });
  }

  function findParent(threads, parentId) { return (threads || []).find((thread) => String(thread?.id || '') === String(parentId || '')) || null; }
  function nextParent(threads, completedIds) { return (threads || []).find((thread) => thread?.kind === 'root' && !completedIds?.has?.(String(thread.id))) || null; }
  function resolveElement(record) {
    const element = record?.element;
    return element && element.isConnected !== false
      ? contract.createActionResult(true, { element })
      : contract.createActionResult(false, { code: 'ambiguous', message: 'TikTok 评论行已重绘，无法安全定位。' });
  }

  global.SocialCommentTikTokComments = Object.freeze({
    collect,
    toRecord,
    stableKey,
    getId: (record) => String(record?.id || ''),
    getParentId: (record) => String(record?.parentId || ''),
    isReply: (record) => record?.kind === 'reply' || Boolean(record?.parentId),
    getAuthor: (record) => String(record?.username || ''),
    getText: (record) => String(record?.text || ''),
    getElement: (record) => record?.element || null,
    resolveElement,
    buildThreads,
    getPostAuthor: () => '',
    findParent,
    nextParent,
  });
})(globalThis);
