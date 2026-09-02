(function (global) {
  'use strict';

  const contract = global.SocialCommentPlatformContract;
  const types = global.SocialCommentTypes;
  const surfaceApi = global.SocialCommentInstagramSurface;
  const locator = global.InstagramControlLocator;

  function normalizedText(node) {
    return String(node?.innerText || node?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function controlLabels(node) {
    return locator?.getAccessibleLabels?.(node) || [normalizedText(node), node?.getAttribute?.('aria-label'), node?.getAttribute?.('title')].filter(Boolean);
  }

  function rowForLink(link) {
    const located = locator?.findCommentRow?.(link);
    if (located) return located;
    let row = null;
    for (let depth = 0, node = link; node && depth < 20; depth += 1, node = node.parentElement) {
      const links = surfaceApi.commentLinksIn(node);
      if (links.length !== 1) break;
      row = node;
      if (node !== link && node.querySelector?.('button,[role="button"]')) break;
    }
    return row;
  }

  function usernameForRow(row) {
    const profile = [...row.querySelectorAll?.('a[href]') || []].find((link) => /^\/[^/?#]+\/?$/.test(link.getAttribute?.('href') || ''));
    return String(profile?.innerText || profile?.textContent || '').trim().replace(/^@+/, '');
  }

  function textForRow(row, username) {
    const times = new Set([...row.querySelectorAll?.('time') || []].map(normalizedText));
    const controls = new Set();
    [...row.querySelectorAll?.('button,[role="button"]') || []].forEach((node) => controlLabels(node).forEach((label) => controls.add(label)));
    const lines = String(row.innerText || row.textContent || '').split(/\r?\n+/).map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
    return lines.filter((line) => line !== username && !times.has(line) && !controls.has(line)
      && !/^(?:(?:view|see)\s+(?:all\s+)?(?:\d+\s+)?(?:more\s+)?repl(?:y|ies)|\d+件(?:すべての|の)?返信を見る|查看(?:全部|所有)?\s*\d*\s*条?回复|(?:load|view|see)\s+(?:more|all)\s+(?:comments?|repl(?:y|ies))|(?:加载更多|查看更多|查看全部)(?:评论|回复))$/i.test(line)
      && !/^(?:translate|翻译(?:を見る)?|翻譯|翻訳を見る)$/i.test(line)).join(' ').trim();
  }

  function collectRecords(surface) {
    const entries = new Map();
    for (const link of surfaceApi.commentLinksIn(surface)) {
      const id = surfaceApi.commentIdFromUrl(link.getAttribute?.('href'));
      const row = rowForLink(link);
      if (!id || !row || !surfaceApi.visible(row) || entries.has(id)) continue;
      const username = usernameForRow(row);
      const text = textForRow(row, username);
      if (!username || !text) continue;
      entries.set(id, { id, parentId: '', kind: 'root', username, text, childCount: 0, isPostAuthor: false, element: row, anchor: link, platform: {} });
    }
    const records = [...entries.values()];
    const parentIds = locator?.deriveReplyParentIds?.(records) || new Map();
    return records.map((record) => {
      const parentId = String(parentIds.get(record.id) || '');
      const { anchor, ...withoutAnchor } = record;
      void anchor;
      return types.normalizeRecord({ ...withoutAnchor, parentId, kind: parentId ? 'reply' : 'root' });
    });
  }

  function postAuthorUsername(surface) {
    const documentRef = surface?.ownerDocument || global.document;
    const firstComment = surfaceApi.commentLinksIn(surface)[0];
    if (!firstComment) return '';
    const profiles = [...documentRef.querySelectorAll?.('main a[href]') || []].filter((link) => /^\/[^/?#]+\/?$/.test(link.getAttribute?.('href') || '')
      && (link.compareDocumentPosition(firstComment) & 4) !== 0);
    return String(profiles[0]?.innerText || profiles[0]?.textContent || '').trim().replace(/^@+/, '');
  }

  function buildThreads(records, context = {}) {
    const author = context.authorUsername || postAuthorUsername(context.surface || records.find((record) => record.element)?.element?.ownerDocument?.body);
    const normalizedAuthor = String(author || '').trim().replace(/^@+/, '').toLocaleLowerCase();
    const all = new Map(records.map((record) => [record.id, { ...record, isPostAuthor: Boolean(normalizedAuthor) && String(record.username || '').replace(/^@+/, '').toLocaleLowerCase() === normalizedAuthor, replies: [] }]));
    const parents = [];
    const orphanReplies = new Map();
    for (const record of all.values()) {
      const parent = all.get(record.parentId);
      if (record.parentId && parent) parent.replies.push(record);
      else if (record.parentId) {
        if (!orphanReplies.has(record.parentId)) orphanReplies.set(record.parentId, { id: `orphan:${record.parentId}`, kind: 'root', username: '', text: '', replies: [], platform: {} });
        orphanReplies.get(record.parentId).replies.push(record);
      } else parents.push(record);
    }
    parents.push(...orphanReplies.values());
    parents.forEach((record) => { record.hasUnloadedReplies = false; });
    return contract.createActionResult(true, { threads: parents });
  }

  function findParent(threads, parentId) {
    return (threads || []).find((thread) => String(thread?.id || '') === String(parentId || '')) || null;
  }

  // 孤儿回复只用于本轮筛选，不能被核心误当作可展开的一级评论。
  function nextParent(threads, completedIds) {
    return (threads || []).find((thread) => thread?.kind === 'root'
      && !String(thread?.id || '').startsWith('orphan:')
      && !completedIds?.has?.(String(thread.id))) || null;
  }

  global.SocialCommentInstagramComments = Object.freeze({
    collect(surface) { return contract.createActionResult(true, { records: collectRecords(surface) }); },
    toRecord(element) {
      const records = collectRecords(element?.ownerDocument || global.document);
      return contract.createActionResult(true, { record: records.find((record) => record.element === element) || null });
    },
    getId: (record) => String(record?.id || ''),
    getParentId: (record) => String(record?.parentId || ''),
    isReply: (record) => record?.kind === 'reply' || Boolean(record?.parentId),
    getAuthor: (record) => String(record?.username || ''),
    getText: (record) => String(record?.text || ''),
    getElement: (record) => record?.element || null,
    buildThreads,
    postAuthorUsername,
    findParent,
    nextParent,
  });
})(globalThis);
