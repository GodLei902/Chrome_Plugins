(function (global) {
  'use strict';

  const LEVEL_1 = '[data-e2e="comment-level-1"]';
  const LEVEL_2 = '[data-e2e="comment-level-2"]';
  const BODY_SELECTOR = `${LEVEL_1}, ${LEVEL_2}`;
  const TAB_GROUP_SELECTOR = 'div[data-testid="tux-web-tab-bar"]';
  const TAB_BUTTON_SELECTOR = 'button[data-testid="tux-web-tab-bar"]';
  const LOAD_MORE_CANDIDATE_SELECTOR = 'button,[role="button"],span,p,div';
  const COMMENT_TAB_LABELS = new Set([
    'comment', 'comments', '评论', '評論', 'コメント', '댓글',
    'comentarios', 'commentaires', 'kommentare', 'комментарии',
  ]);
  const REPLY_EXPANSION_PATTERNS = [
    /^(?:view|show)(?:\s+all)?(?:\s+more)?\s+\d+\s+repl(?:y|ies)$/i,
    /^(?:view|show)\s+\d+\s+more\s+repl(?:y|ies)$/i,
    /^(?:view|show)\s+(?:more\s+)?repl(?:y|ies)$/i,
    /^\d+件(?:の)?返信を表示$/,
    /^(?:[-—–]\s*)?あと\s*\d+件表示(?:\s*[⌄∨▼])?$/,
    /^(?:返信を(?:さらに|もっと)|(?:さらに|もっと)返信を)表示$/,
    /^(?:查看|展开|展開)(?:全部)?\s*\d+\s*(?:条|條)?(?:回复|回覆)$/,
    /^(?:查看|顯示|显示)(?:更多|全部)?(?:回复|回覆)$/,
  ];
  // 加载入口文案只在评论面外的控制节点中识别，不能把评论正文中的“查看更多”当成分页动作。
  const LOAD_MORE_PATTERNS = [
    /^(?:view|show|see|load)\s+(?:more|all)(?:\s+\d+)?\s*(?:comments?|replies?)?$/i,
    /^(?:view|show|see|load)(?:\s+all)?\s+(?:\d+\s+)?(?:more\s+)?(?:comments?|replies?)$/i,
    /^\d+\s+(?:more\s+)?(?:comments?|replies?)$/i,
    /^(?:查看|顯示|显示|加载|載入)(?:更多|全部)\s*(?:评论|評論|回复|回覆)?$/i,
    /^(?:查看|顯示|显示|加载|載入)\s*(?:评论|評論|回复|回覆)$/i,
    /^(?:もっと|さらに)(?:コメント|返信)?を(?:見る|表示)$/i,
    /^(?:commentaires?|réponses?)\s+(?:suivants?|supplémentaires?)$/i,
    /^(?:ver|mostrar)\s+(?:más|todos)?\s*(?:comentarios?|respuestas?)?$/i,
    /^(?:mehr|weitere)\s+(?:kommentare|antworten)?\s*(?:anzeigen)?$/i,
  ];
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

  function isReplyExpansionText(value) {
    const text = normalizeText(value).toLocaleLowerCase();
    return Boolean(text) && REPLY_EXPANSION_PATTERNS.some((pattern) => pattern.test(text));
  }

  function isLoadMoreText(value) {
    const text = normalizeText(value);
    if (!text || isReplyExpansionText(text)) return false;
    return LOAD_MORE_PATTERNS.some((pattern) => pattern.test(text));
  }

  function findReplyExpansionControls(root) {
    const candidates = [...(root?.querySelectorAll?.('button,[role="button"],p,span,div') || [])]
      .filter((element) => isVisible(element) && isReplyExpansionText(element.textContent));
    // 只保留最深层带文案的节点，避免同一入口的父容器重复点击。
    return candidates.filter((element) => ![...(element.children || [])].some((child) => isVisible(child) && isReplyExpansionText(child.textContent)));
  }

  function controlLabels(element) {
    return [element?.textContent, element?.innerText, element?.getAttribute?.('aria-label'), element?.getAttribute?.('title')]
      .map(normalizeText)
      .filter(Boolean);
  }

  function isOutsideCommentBody(element, root) {
    if (element?.matches?.(LEVEL_1) || element?.matches?.(LEVEL_2)) return false;
    for (let current = element?.parentElement; current && current !== root; current = current.parentElement) {
      if (current.matches?.(LEVEL_1) || current.matches?.(LEVEL_2)) return false;
      // 回复展开容器与一级正文通常是兄弟节点；当某个控制节点位于仅含一个
      // 一级评论且已有回复/展开证据的线程内时，视为线程动作而非页面分页。
      const parentCount = current.querySelectorAll?.(LEVEL_1)?.length || 0;
      const replyCount = current.querySelectorAll?.(LEVEL_2)?.length || 0;
      if (parentCount === 1 && (replyCount > 0 || findReplyExpansionControls(current).length > 0)) return false;
    }
    return true;
  }

  function findLoadMoreControls(root) {
    const candidates = [...(root?.querySelectorAll?.(LOAD_MORE_CANDIDATE_SELECTOR) || [])]
      .filter((element) => isVisible(element) && isOutsideCommentBody(element, root) && controlLabels(element).some(isLoadMoreText));
    // 只保留最深层的实际控件，避免同一按钮的外层容器造成重复匹配。
    return candidates.filter((element) => ![...(element.children || [])]
      .some((child) => isVisible(child) && controlLabels(child).some(isLoadMoreText)));
  }

  function scrollableOverflow(node) {
    try {
      const style = node?.ownerDocument?.defaultView?.getComputedStyle?.(node);
      const computed = String(style?.overflowY || '').toLocaleLowerCase();
      const inline = String(node?.style?.overflowY || '').toLocaleLowerCase();
      // 测试/嵌入页面可能只提供 display/visibility 的计算样式；仅当计算值明确
      // 为可滚动值时优先采用它，否则保留元素本身的 overflowY 证据。
      return ['auto', 'scroll', 'overlay'].includes(computed) ? computed : (inline || computed);
    } catch {
      return String(node?.style?.overflowY || '').toLocaleLowerCase();
    }
  }

  function isScrollable(node) {
    if (!node || node === node.ownerDocument?.body || node === node.ownerDocument?.documentElement || !isVisible(node)) return false;
    if (!['auto', 'scroll', 'overlay'].includes(scrollableOverflow(node))) return false;
    return Number(node.scrollHeight || 0) > Number(node.clientHeight || 0) + 1;
  }

  function findScrollableElements(root) {
    const nodes = [root, ...(root?.querySelectorAll?.('*') || [])];
    return [...new Set(nodes.filter(isScrollable))];
  }

  function findScrollableElement(root) {
    const candidates = findScrollableElements(root);
    return candidates.sort((left, right) => {
      const leftComments = findBodies(left).length;
      const rightComments = findBodies(right).length;
      return rightComments - leftComments || Number(right.scrollHeight || 0) - Number(left.scrollHeight || 0);
    })[0] || null;
  }

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

  function getThreadParentBody(element) {
    for (let ancestor = element?.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const parents = [...(ancestor.querySelectorAll?.(LEVEL_1) || [])];
      if (parents.length === 1) return parents[0];
      if (parents.length > 1) return null;
    }
    return null;
  }

  // TikTok 的回复容器与一级评论正文是兄弟节点；展开确认必须覆盖完整线程。
  function getThreadContainer(element) {
    const body = locateBody(element);
    for (let current = body?.parentElement || element?.parentElement; current; current = current.parentElement) {
      const parents = [...(current.querySelectorAll?.(LEVEL_1) || [])];
      if (parents.length !== 1 || (body && !current.contains?.(body))) continue;
      const hasReplies = [...(current.querySelectorAll?.(LEVEL_2) || [])].length > 0;
      const hasExpansion = findReplyExpansionControls(current).length > 0;
      if (hasReplies || hasExpansion) return current;
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
    getThreadParentBody,
    getThreadContainer,
    isReplyExpansionText,
    findReplyExpansionControls,
    isLoadMoreText,
    findLoadMoreControls,
    isScrollable,
    findScrollableElements,
    findScrollableElement,
    isCreator,
    commentTabState,
  });
})(globalThis);
