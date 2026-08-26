(function (global) {
  'use strict';

  const labelsApi = global.InstagramControlLabels || {};
  const normalize = labelsApi.normalizeInstagramLabel || ((value) => String(value || '').replace(/\s+/g, ' ').trim());
  const controlSelector = 'button,[role="button"],[role="menuitem"],[role="option"],[tabindex="0"][aria-expanded],[tabindex="0"][aria-controls]';
  const surfaceSelector = '[role="dialog"][aria-modal="true"],[role="dialog"],[role="menu"],[role="listbox"]';
  const excludedWords = /(?:like|点赞|赞|いいね|回复|回覆|返信|translate|翻译|翻譯|翻訳|emoji|表情|reaction|举报|檢舉|報告|report|cancel|取消|取消する|关闭|close)/i;

  function visible(node) {
    if (!node || node.isConnected === false) return false;
    if (typeof node.getBoundingClientRect !== 'function') return true;
    const rect = node.getBoundingClientRect();
    return Boolean(rect && rect.width > 0 && rect.height > 0);
  }

  function accessibleLabels(node) {
    if (!node) return [];
    const result = [];
    const add = (value) => { const normalized = normalize(value); if (normalized && !result.includes(normalized)) result.push(normalized); };
    add(node.innerText || node.textContent);
    add(node.getAttribute?.('aria-label'));
    add(node.getAttribute?.('title'));
    node.querySelectorAll?.('[aria-label],[title]').forEach((child) => {
      add(child.getAttribute('aria-label'));
      add(child.getAttribute('title'));
    });
    return result;
  }

  function controlsIn(root) {
    if (!root) return [];
    const result = [];
    if (root.matches?.(controlSelector)) result.push(root);
    root.querySelectorAll?.(controlSelector).forEach((node) => result.push(node));
    return [...new Set(result)].filter(visible);
  }

  function isReplyDisclosureShape(node) {
    if (!node?.matches?.('button,[role="button"]')) return false;
    const wrapper = node.firstElementChild;
    const marker = wrapper?.firstElementChild;
    const label = wrapper?.lastElementChild;
    return Boolean(wrapper && wrapper.children?.length === 2 && marker?.tagName === 'DIV' && marker.children?.length === 0
      && !normalize(marker.textContent) && label?.tagName === 'SPAN');
  }

  function replyContainer(node) {
    let current = node?.parentElement;
    for (let depth = 0; current && depth < 4; depth += 1, current = current.parentElement) {
      const children = [...(current.children || [])];
      if (children.some((child) => child !== node && child.tagName === 'UL')) return current;
    }
    return node?.parentElement || null;
  }

  function isExpandedReplyDisclosure(node) {
    const aria = node?.getAttribute?.('aria-expanded');
    if (aria === 'true') return true;
    if (aria === 'false') return false;
    const container = replyContainer(node);
    return Boolean(container && [...container.children || []].some((child) => child.tagName === 'UL' && visible(child)));
  }

  function match(type, node, languageHints) {
    return labelsApi.matchControlLabel ? labelsApi.matchControlLabel(type, accessibleLabels(node), languageHints) : { matched: false };
  }

  function isExpansionControl(node, languageHints) {
    if (!visible(node) || node.matches?.('input,textarea,[contenteditable="true"]')) return false;
    let ancestor = node.parentElement;
    while (ancestor) {
      if (ancestor.id === 'icc-host' || ['dialog', 'menu', 'listbox'].includes(ancestor.getAttribute?.('role'))) return false;
      ancestor = ancestor.parentElement;
    }
    return isReplyDisclosureShape(node) || match('replyDisclosure', node, languageHints).matched
      || match('hiddenComments', node, languageHints).matched || match('loadMore', node, languageHints).matched;
  }

  function findReplyDisclosureControls(root, commentRow, languageHints) {
    const scope = commentRow || root;
    const candidates = controlsIn(scope).filter((node) => isExpansionControl(node, languageHints));
    const shaped = candidates.filter(isReplyDisclosureShape);
    // 结构候选唯一时优先使用结构；文字只在结构缺失或冲突时兜底。
    if (shaped.length) return shaped.filter((node) => !isExpandedReplyDisclosure(node));
    return candidates.filter((node) => !isExpandedReplyDisclosure(node));
  }

  function findLoadMoreControls(root, languageHints) {
    return controlsIn(root).filter((node) => match('loadMore', node, languageHints).matched && !isExpandedReplyDisclosure(node));
  }

  function dotGeometry(svg) {
    if (!svg) return false;
    const circles = [...(svg.querySelectorAll?.('circle') || [])];
    if (circles.length >= 3) {
      const sameParent = circles.filter((circle) => circle.parentElement === circles[0].parentElement);
      if (sameParent.length >= 3) return true;
    }
    const paths = [...(svg.querySelectorAll?.('path') || [])];
    return paths.some((path) => /(?:\.\.\.|ellipsis|dots)/i.test(`${path.getAttribute?.('d') || ''} ${path.getAttribute?.('aria-label') || ''}`));
  }

  function scoreCommentMenu(node, commentRow) {
    if (!visible(node) || !commentRow?.contains?.(node)) return -1;
    if (node.tagName !== 'BUTTON' && node.getAttribute?.('tabindex') !== '0') return -1;
    const values = accessibleLabels(node).join(' ');
    if (excludedWords.test(values)) return -1;
    const svg = node.querySelector?.('svg[role="img"],svg[viewBox="0 0 24 24"],svg');
    if (!svg) return -1;
    let score = 4;
    if (svg.getAttribute?.('aria-label') || svg.querySelector?.('title')) score += 2;
    if (dotGeometry(svg)) score += 4;
    if (node.getAttribute?.('aria-haspopup') === 'dialog') score -= 3;
    const rect = node.getBoundingClientRect?.();
    if (rect && rect.width >= 20 && rect.height >= 20) score += 1;
    return score;
  }

  function findCommentMenu(commentRow, languageHints) {
    const controls = controlsIn(commentRow).filter((node) => node !== commentRow);
    const scored = controls.map((node) => ({ node, score: scoreCommentMenu(node, commentRow) })).filter((item) => item.score >= 0);
    if (scored.length) {
      const max = Math.max(...scored.map((item) => item.score));
      const best = scored.filter((item) => item.score === max);
      if (best.length === 1 && max >= 5) return best[0].node;
    }
    const labelled = controls.filter((node) => (node.tagName === 'BUTTON' || node.getAttribute?.('tabindex') === '0')
      && match('commentOptions', node, languageHints).matched && !excludedWords.test(accessibleLabels(node).join(' ')));
    return labelled.length === 1 ? labelled[0] : null;
  }

  function findCommentMenuResult(commentRow, languageHints) {
    if (!commentRow) return { status: 'not-found', action: null, reason: '目标回复行不存在。' };
    const controls = controlsIn(commentRow).filter((node) => node !== commentRow);
    const action = findCommentMenu(commentRow, languageHints);
    if (action) return { status: 'ok', action, reason: '' };
    const candidates = controls.filter((node) => scoreCommentMenu(node, commentRow) >= 0
      || ((node.tagName === 'BUTTON' || node.getAttribute?.('tabindex') === '0')
        && match('commentOptions', node, languageHints).matched));
    return { status: candidates.length > 1 ? 'ambiguous' : 'not-found', action: null, reason: candidates.length > 1 ? '目标回复行存在多个评论选项控件。' : '目标回复行没有可确认的评论选项控件。' };
  }

  function elementSignature(node) {
    if (!node) return '';
    const attrs = ['role', 'aria-modal', 'aria-expanded', 'aria-label', 'title'].map((name) => `${name}=${node.getAttribute?.(name) || ''}`).join('|');
    const children = node.querySelectorAll?.('*')?.length || 0;
    return `${attrs}|text=${normalize(node.innerText || node.textContent)}|children=${children}`;
  }

  function isExtensionSurface(node) {
    let current = node;
    while (current) {
      if (current.id === 'icc-host' || current.getAttribute?.('data-icc-host') === 'true') return true;
      current = current.parentNode;
    }
    return false;
  }

  function actionSurfaces(documentRef = global.document) {
    const nodes = documentRef?.querySelectorAll ? [...documentRef.querySelectorAll(surfaceSelector)] : [];
    return nodes.filter((node) => visible(node) && !isExtensionSurface(node) && controlsIn(node).length > 0);
  }

  function captureActionSurfaceState(documentRef = global.document) {
    return { document: documentRef, surfaces: new Map(actionSurfaces(documentRef).map((node) => [node, elementSignature(node)])) };
  }

  function findActionSurface(beforeState, documentRef = beforeState?.document || global.document) {
    const before = beforeState?.surfaces || new Map();
    const changed = actionSurfaces(documentRef).filter((node) => !before.has(node) || before.get(node) !== elementSignature(node));
    if (changed.length !== 1) return null;
    return changed[0];
  }

  function deleteActionCandidates(surface) {
    return controlsIn(surface).filter((node) => !node.disabled && node.getAttribute?.('aria-disabled') !== 'true');
  }

  function findDeleteAction(surface, languageHints) {
    if (!surface) return null;
    const matches = deleteActionCandidates(surface).filter((node) => labelsApi.matchControlLabel?.('delete', accessibleLabels(node), languageHints)?.matched);
    return matches.length === 1 ? matches[0] : null;
  }

  function describeDeleteAction(surface, languageHints) {
    const actions = deleteActionCandidates(surface);
    const matches = actions.filter((node) => labelsApi.matchControlLabel?.('delete', accessibleLabels(node), languageHints)?.matched);
    if (matches.length === 1) return { action: matches[0], reason: 'delete' };
    if (!matches.length && actions.some((node) => /(?:举报|檢舉|報告|report|举报)/i.test(accessibleLabels(node).join(' ')))) return { action: null, reason: 'permission' };
    return { action: null, reason: matches.length > 1 ? 'ambiguous' : 'missing' };
  }

  function captureExpansionState(control, commentIds = []) {
    const container = replyContainer(control);
    return {
      control,
      ids: new Set([...commentIds].map(String)),
      expanded: isExpandedReplyDisclosure(control),
      ariaExpanded: control?.getAttribute?.('aria-expanded') || '',
      container,
      containerHasList: Boolean(container && [...(container.children || [])].some((child) => child.tagName === 'UL')),
      signature: elementSignature(control),
    };
  }

  function waitForExpansionResult(before, current = {}) {
    const ids = new Set([...(current.commentIds || current.ids || [])].map(String));
    const newId = [...ids].some((id) => id && !before?.ids?.has(id));
    const control = current.control || before?.control;
    const ariaChanged = before?.ariaExpanded === 'false' && control?.getAttribute?.('aria-expanded') === 'true';
    const listAppeared = Boolean(before?.container && [...(before.container.children || [])].some((child) => child.tagName === 'UL' && visible(child))) || Boolean(before?.containerHasList === false && current.containerHasList);
    const changed = control && (!control.isConnected || !visible(control) || elementSignature(control) !== before?.signature);
    return { ok: Boolean(newId || ariaChanged || listAppeared || (changed && (current.stable === true || current.stableSnapshot))), newId, listAppeared, ariaChanged, changed };
  }

  function waitForDeleteResult(commentId, current = {}) {
    const ids = new Set([...(current.commentIds || [])].map(String));
    const deleted = commentId ? !ids.has(String(commentId)) : false;
    return { ok: deleted, deleted, needsConfirmation: Boolean(current.surface), surface: current.surface || null };
  }

  global.InstagramControlLocator = {
    visible,
    getAccessibleLabels: accessibleLabels,
    isReplyDisclosureShape,
    isExpandedReplyDisclosure,
    isExpansionControl,
    findReplyDisclosureControls,
    findLoadMoreControls,
    findCommentMenu,
    findCommentMenuResult,
    captureActionSurfaceState,
    findActionSurface,
    findDeleteAction,
    describeDeleteAction,
    captureExpansionState,
    waitForExpansionResult,
    waitForDeleteResult,
    elementSignature,
  };
})(globalThis);
