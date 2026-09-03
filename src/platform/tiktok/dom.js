(function (global) {
  'use strict';

  const LEVEL_1 = '[data-e2e="comment-level-1"]';
  const LEVEL_2 = '[data-e2e="comment-level-2"]';
  const BODY_SELECTOR = `${LEVEL_1}, ${LEVEL_2}`;
  const TAB_GROUP_SELECTOR = 'div[data-testid="tux-web-tab-bar"]';
  const TAB_BUTTON_SELECTOR = 'button[data-testid="tux-web-tab-bar"]';
  const COMMENT_TAB_LABELS = new Set([
    'comment', 'comments', '评论', '評論', 'コメント', '댓글',
    'comentarios', 'commentaires', 'kommentare', 'комментарии',
  ]);
  const CREATOR_LABELS = new Set([
    'creator', 'クリエイター', '创作者', '創作者', 'creador', 'creadora', 'créateur', 'créatrice',
  ]);

  function normalizeText(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }

  function isVisible(element) {
    if (!element || element.isConnected === false) return false;
    const rect = element.getBoundingClientRect?.();
    if (rect && (rect.width <= 0 || rect.height <= 0)) return false;
    const style = element.ownerDocument?.defaultView?.getComputedStyle?.(element);
    return !style || (style.display !== 'none' && style.visibility !== 'hidden');
  }

  function documentFor(value) { return value?.page?.document || value?.document || value || global.document; }
  function findBodies(root) {
    const found = [...(root?.querySelectorAll?.(BODY_SELECTOR) || [])];
    if (root?.matches?.(BODY_SELECTOR)) found.unshift(root);
    return [...new Set(found)];
  }
  function hasVisibleBodies(root) { return findBodies(root).some(isVisible); }

  function locateBody(element) {
    if (element?.matches?.(LEVEL_1) || element?.matches?.(LEVEL_2)) return element;
    const bodies = findBodies(element);
    return bodies.length === 1 ? bodies[0] : null;
  }

  function bodyLevel(element) {
    const body = locateBody(element);
    return body?.matches?.(LEVEL_2) ? 2 : body?.matches?.(LEVEL_1) ? 1 : 0;
  }

  function locateRow(element) {
    const body = locateBody(element);
    const row = body?.parentElement;
    // comment-level-* 位于正文节点；只接受恰含一个正文节点的直接父级，避免跨行解析。
    return row && findBodies(row).length === 1 && findBodies(row)[0] === body ? row : null;
  }

  function uniqueDescendant(root, selector) {
    const matches = [...(root?.querySelectorAll?.(selector) || [])];
    return matches.length === 1 ? matches[0] : null;
  }

  function authorNode(element) {
    const level = bodyLevel(element);
    return level ? uniqueDescendant(locateRow(element), `[data-e2e="comment-username-${level}"]`) : null;
  }

  function creatorLabel(value) {
    const raw = normalizeText(value);
    const normalized = raw.replace(/[·•|：:]/g, ' ').trim().toLocaleLowerCase();
    return CREATOR_LABELS.has(normalized) || /(?:^|\s)(?:creator|クリエイター|创作者|創作者|creador|creadora|créateur|créatrice)(?:\s|$)/i.test(normalized) ? raw : '';
  }

  function isCreator(element) {
    const node = authorNode(element);
    const area = node?.parentElement || node;
    if (!area) return false;
    const authorLink = uniqueDescendant(node, 'a[href^="/@"]');
    const candidates = [area, ...(area.querySelectorAll?.('*') || [])];
    return candidates.some((candidate) => {
      if (candidate === node || candidate === authorLink || authorLink?.contains?.(candidate)) return false;
      return [candidate.getAttribute?.('aria-label'), candidate.getAttribute?.('title'), candidate.getAttribute?.('data-e2e'), candidate.getAttribute?.('data-testid'), candidate.textContent]
        .some(creatorLabel);
    });
  }

  function getAuthor(element) {
    const node = authorNode(element);
    const links = [...(node?.querySelectorAll?.('a[href]') || [])].filter((item) => String(item.getAttribute?.('href') || '').startsWith('/@'));
    const link = links.length === 1 ? links[0] : null;
    return normalizeText(link?.innerText || link?.textContent || link?.getAttribute?.('aria-label'));
  }

  function getText(element) {
    const body = locateBody(element);
    return normalizeText(body?.innerText || body?.textContent);
  }

  function getParentBody(element) {
    const body = locateBody(element);
    if (!body?.matches?.(LEVEL_2)) return null;
    // TikTok 将更深回复扁平为 level-2；仅能确认唯一一级线程时才继续。
    for (let ancestor = body.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const parents = [...(ancestor.querySelectorAll?.(LEVEL_1) || [])];
      if (parents.length === 1) return parents[0];
      if (parents.length > 1) return null;
    }
    return null;
  }

  function commentTabState(input) {
    const documentLike = documentFor(input);
    const groups = [...(documentLike?.querySelectorAll?.(TAB_GROUP_SELECTOR) || [])]
      .filter(isVisible)
      .map((group) => ({ group, buttons: [...group.querySelectorAll?.(TAB_BUTTON_SELECTOR) || []].filter(isVisible) }))
      .filter((entry) => entry.buttons.length >= 2);
    if (groups.length !== 1) return { ok: false, code: groups.length ? 'ambiguous' : 'not-found' };
    const entry = groups[0];
    const buttons = entry.buttons.filter((button) => COMMENT_TAB_LABELS.has(normalizeText(button.innerText || button.textContent).toLocaleLowerCase()));
    if (buttons.length !== 1) return { ok: false, code: buttons.length ? 'ambiguous' : 'not-found' };
    const button = buttons[0];
    const tabStyle = String(button.style?.color || button.parentElement?.style?.color || button.parentElement?.getAttribute?.('style') || '');
    return { ok: true, group: entry.group, button, active: tabStyle.includes('color-ui-text-1') };
  }

  global.SocialCommentTikTokDom = Object.freeze({
    LEVEL_1,
    LEVEL_2,
    BODY_SELECTOR,
    normalizeText,
    isVisible,
    documentFor,
    findBodies,
    hasVisibleBodies,
    locateBody,
    bodyLevel,
    locateRow,
    getAuthor,
    getText,
    getParentBody,
    isCreator,
    commentTabState,
  });
})(globalThis);
