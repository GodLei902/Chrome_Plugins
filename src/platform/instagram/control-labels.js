(function (global) {
  'use strict';

  // 文字只作结构定位失败后的兜底；新增语言应只修改此配置和 fixture。
  const INSTAGRAM_CONTROL_LABELS = Object.freeze({
    ja: Object.freeze({
      replyDisclosure: [/^\d+件すべての返信を見る$/, /^\d+件の返信を見る$/, /^返信をすべて見る$/, /^すべての返信を見る$/],
      hiddenComments: [/^非表示のコメントを見る$/, /^非表示.*コメント.*見る$/],
      loadMore: [/^(?:コメント|返信)を(?:さらに|もっと)(?:読み込む|見る)$/, /^(?:コメント|返信)をすべて見る$/],
      commentOptions: [/^コメントのオプション$/, /^コメントオプション$/, /^オプション$/, /^その他$/],
      delete: [/^削除$/, /^削除する$/, /^コメントを削除(?:する)?$/],
    }),
    'zh-CN': Object.freeze({
      replyDisclosure: [/^查看(?:全部|所有)?\s*\d*\s*条回复$/, /^查看所有\d+条回复$/, /^查看\s*\d+\s*条回复$/, /^查看(?:全部|所有)?回复$/],
      hiddenComments: [/^查看隐藏评论$/, /^查看.*隐藏.*评论$/],
      loadMore: [/^(?:加载更多|查看更多|查看全部)(?:评论|回复)$/],
      commentOptions: [/^评论选项$/, /^更多选项$/],
      delete: [/^删除$/, /^删除评论$/],
    }),
    'zh-TW': Object.freeze({
      replyDisclosure: [/^查看(?:全部|所有)?\s*\d*\s*則?回覆$/, /^查看所有\d+則回覆$/],
      hiddenComments: [/^查看隱藏留言$/, /^查看隱藏評論$/],
      loadMore: [/^(?:載入更多|查看更多|查看全部)(?:留言|評論|回覆)$/],
      commentOptions: [/^留言選項$/, /^更多選項$/],
      delete: [/^刪除$/, /^刪除留言$/],
    }),
    en: Object.freeze({
      replyDisclosure: [/^(?:view|see)\s+(?:all\s+)?(?:\d+\s+)?(?:more\s+)?repl(?:y|ies)$/i, /^\d+\s+repl(?:y|ies)\s+(?:to\s+)?view$/i],
      hiddenComments: [/^(?:see|view)\s+hidden\s+comments?$/i],
      loadMore: [/^(?:load|view|see)\s+(?:more|all)\s+(?:comments?|repl(?:y|ies))$/i],
      commentOptions: [/^(?:comment\s+)?options?$/i, /^more\s+options?$/i],
      delete: [/^delete$/i, /^delete\s+comment$/i],
    }),
  });

  const LANGUAGE_ORDER = ['ja', 'zh-CN', 'zh-TW', 'en'];

  function normalizeInstagramLabel(value) {
    let result = String(value == null ? '' : value);
    try { result = result.normalize('NFKC'); } catch { /* 旧浏览器没有 normalize 时继续使用原文 */ }
    return result
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/[\u00A0\u3000]/g, ' ')
      .replace(/[\u2010-\u2015\u2212]/g, '-')
      .replace(/[\uFF01-\uFF5E]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xFEE0))
      .replace(/\s+/g, ' ')
      .trim();
  }

  function languageKey(value) {
    const language = String(value || '').trim().toLowerCase().replace('_', '-');
    if (language.startsWith('ja')) return 'ja';
    if (language === 'zh-tw' || language === 'zh-hk' || language === 'zh-mo') return 'zh-TW';
    if (language.startsWith('zh')) return 'zh-CN';
    if (language.startsWith('en')) return 'en';
    return '';
  }

  function getLanguageOrder(documentRef = global.document, hints) {
    const values = [];
    const append = (value) => { const key = languageKey(value); if (key && !values.includes(key)) values.push(key); };
    if (Array.isArray(hints)) hints.forEach(append);
    else if (typeof hints === 'string') append(hints);
    else if (hints && typeof hints === 'object') [hints.language, hints.lang, hints.locale].forEach(append);
    append(documentRef?.documentElement?.lang);
    append(documentRef?.body?.lang);
    LANGUAGE_ORDER.forEach((key) => { if (!values.includes(key)) values.push(key); });
    return values;
  }

  function getControlLabels(type, languageHints, documentRef = global.document) {
    const result = [];
    getLanguageOrder(documentRef, languageHints).forEach((language) => {
      (INSTAGRAM_CONTROL_LABELS[language]?.[type] || []).forEach((pattern) => result.push({ language, pattern }));
    });
    return result;
  }

  function matchConfiguredLabel(type, labels, languageOrder, documentRef = global.document) {
    const values = (Array.isArray(labels) ? labels : [labels]).map(normalizeInstagramLabel).filter(Boolean);
    if (!values.length) return { matched: false, language: '', label: '', pattern: null };
    const order = Array.isArray(languageOrder) ? languageOrder : getLanguageOrder(documentRef, languageOrder);
    for (const language of order) {
      const patterns = INSTAGRAM_CONTROL_LABELS[language]?.[type] || [];
      for (const label of values) {
        const pattern = patterns.find((candidate) => candidate.test(label));
        if (pattern) return { matched: true, language, label, pattern };
      }
    }
    return { matched: false, language: '', label: '', pattern: null };
  }

  function matchControlLabel(type, labels, languageHints, documentRef = global.document) {
    return matchConfiguredLabel(type, labels, getLanguageOrder(documentRef, languageHints), documentRef);
  }

  global.InstagramControlLabels = {
    INSTAGRAM_CONTROL_LABELS,
    LANGUAGE_ORDER,
    normalizeInstagramLabel,
    getLanguageOrder,
    getControlLabels,
    matchConfiguredLabel,
    matchControlLabel,
  };
})(globalThis);
