const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

class FakeElement {
  constructor(tagName, attrs = {}, text = '') {
    this.tagName = tagName.toUpperCase();
    this.attrs = { ...attrs };
    this._text = text;
    this.children = [];
    this.parentElement = null;
    this.parentNode = null;
    this.isConnected = true;
    this.disabled = false;
  }
  get textContent() { return [this._text, ...this.children.map((child) => child.textContent)].filter(Boolean).join('\n'); }
  set textContent(value) { this._text = String(value || ''); }
  get innerText() { return this.textContent; }
  set innerText(value) { this._text = String(value || ''); }
  append(...nodes) { nodes.forEach((node) => { node.parentElement = this; node.parentNode = this; this.children.push(node); }); return this; }
  get firstElementChild() { return this.children[0] || null; }
  get lastElementChild() { return this.children[this.children.length - 1] || null; }
  getAttribute(name) { return this.attrs[name] ?? null; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  matches(selector) {
    return selector.split(',').some((part) => {
      if (part === 'a[href*="/c/"]') return this.tagName === 'A' && String(this.attrs.href || '').includes('/c/');
      const role = part.match(/^\[role="([^"]+)"\]$/)?.[1];
      if (role) return this.attrs.role === role;
      if (part === 'button') return this.tagName === 'BUTTON';
      if (/^[a-z]+$/i.test(part)) return this.tagName === part.toUpperCase();
      if (part === '[role="button"]') return this.attrs.role === 'button';
      if (part === '[role="menuitem"]') return this.attrs.role === 'menuitem';
      if (part === '[role="option"]') return this.attrs.role === 'option';
      if (part.includes('[aria-expanded]')) return this.attrs.tabindex === '0' && this.attrs['aria-expanded'] != null;
      if (part.includes('[aria-controls]')) return this.attrs.tabindex === '0' && this.attrs['aria-controls'] != null;
      if (part === 'input,textarea') return ['INPUT', 'TEXTAREA'].includes(this.tagName);
      return false;
    });
  }
  querySelectorAll(selector) {
    const all = [];
    const visit = (node) => { node.children.forEach((child) => { if (selector === '*' || child.matches(selector) || (selector.includes('svg') && child.tagName === 'SVG') || (selector.includes('circle') && child.tagName === 'CIRCLE') || (selector.includes('path') && child.tagName === 'PATH') || (selector.includes('title') && child.tagName === 'TITLE') || (selector.includes('aria-label') && child.getAttribute('aria-label'))) all.push(child); visit(child); }); };
    visit(this);
    return all;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  contains(node) { return this === node || this.children.some((child) => child.contains(node)); }
  closest(selector) { let node = this; while (node) { if (node.matches?.(selector)) return node; node = node.parentElement; } return null; }
  getBoundingClientRect() { return { width: 24, height: 24, left: 0, top: 0 }; }
}

function load() {
  const documentRef = new FakeElement('document');
  documentRef.documentElement = { lang: 'zh-CN' };
  const context = { globalThis: null, document: documentRef };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('src/content/instagram-control-labels.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('src/content/instagram-control-locator.js', 'utf8'), context);
  return { api: context.InstagramControlLocator, labels: context.InstagramControlLabels, documentRef };
}

function replyButton(label = '随机文案') {
  return new FakeElement('button').append(new FakeElement('div').append(new FakeElement('div'), new FakeElement('span', {}, label)));
}

function assignDomOrder(root) {
  const nodes = [];
  const visit = (node) => { nodes.push(node); node.children.forEach(visit); };
  visit(root);
  nodes.forEach((node) => {
    node.compareDocumentPosition = (other) => {
      const left = nodes.indexOf(node);
      const right = nodes.indexOf(other);
      if (left < 0 || right < 0 || left === right) return 0;
      return left < right ? 4 : 2;
    };
  });
  return root;
}

test('回复展开控件结构优先，普通回复按钮不会命中', () => {
  const { api } = load();
  const shaped = replyButton('随机文案');
  const expander = new FakeElement('button', {}, '查看所有2条回复');
  const ordinary = new FakeElement('button', {}, '回复');
  assert.equal(api.isReplyDisclosureShape(shaped), true);
  assert.equal(api.isReplyDisclosureShape(ordinary), false);
  assert.equal(api.isExpansionControl(shaped), true);
  assert.equal(api.isExpansionControl(expander), true);
  const wrapper = new FakeElement('div').append(shaped, ordinary, expander);
  const controls = api.findReplyDisclosureControls(wrapper);
  assert.equal(controls.length, 1);
  assert.equal(controls[0], shaped);
});

test('回复入口通过 aria-expanded 或同级 ul 判断已展开', () => {
  const { api } = load();
  const control = new FakeElement('button', { 'aria-expanded': 'true' }, '查看所有2条回复');
  assert.equal(api.isExpandedReplyDisclosure(control), true);
  let wrapper = new FakeElement('div').append(control);
  assert.equal(api.findReplyDisclosureControls(wrapper).length, 0);
  const structural = replyButton('查看所有2条回复');
  wrapper = assignDomOrder(new FakeElement('div').append(structural, new FakeElement('ul')));
  assert.equal(api.isExpandedReplyDisclosure(structural), true);
  assert.equal(api.findReplyDisclosureControls(wrapper).length, 0);
});

test('评论行定位停在正文操作行，不扩大到回复展开入口容器', () => {
  const { api } = load();
  const link = new FakeElement('a', { href: '/p/example/c/101/' }, '作者');
  const body = new FakeElement('div').append(link, new FakeElement('button', {}, '回复'));
  const row = new FakeElement('div').append(body, new FakeElement('button', {}, '查看所有2条回复'));
  const surface = new FakeElement('main').append(row);
  assert.equal(api.findCommentRow(link), body);
  assert.equal(surface.children.length, 1);
});

test('父级展开控件位于紧评论行外侧时仍归属当前一级评论', () => {
  const { api } = load();
  const parentLink = new FakeElement('a', { href: '/p/example/c/101/' }, 'alice');
  const parentRow = new FakeElement('div').append(parentLink, new FakeElement('span', {}, '一级评论'));
  const parentExpander = replyButton('查看所有2条回复');
  const nextLink = new FakeElement('a', { href: '/p/example/c/202/' }, 'bob');
  const nextRow = new FakeElement('div').append(nextLink, new FakeElement('span', {}, '下一条'));
  const nextExpander = replyButton('查看所有3条回复');
  const root = assignDomOrder(new FakeElement('div').append(parentRow, parentExpander, nextRow, nextExpander));
  assert.equal(root.children.length, 4);
  const parentControls = api.findReplyDisclosureControls(root, parentRow);
  const nextControls = api.findReplyDisclosureControls(root, nextRow);
  assert.equal(parentControls.length, 1);
  assert.equal(parentControls[0], parentExpander);
  assert.equal(nextControls.length, 1);
  assert.equal(nextControls[0], nextExpander);
});

test('展开后更多回复控件跟在子回复后面时仍归属一级评论', () => {
  const { api } = load();
  const parentLink = new FakeElement('a', { href: '/p/example/c/101/' }, 'alice');
  const parentRow = new FakeElement('div').append(parentLink, new FakeElement('span', {}, '一级评论'));
  const replyLink = new FakeElement('a', { href: '/p/example/c/102/' }, 'charlie');
  const replyRow = new FakeElement('li').append(replyLink, new FakeElement('span', {}, '已展开回复'));
  const replyList = new FakeElement('ul').append(replyRow);
  const moreReplies = replyButton('查看更多回复');
  const nextLink = new FakeElement('a', { href: '/p/example/c/202/' }, 'bob');
  const nextRow = new FakeElement('div').append(nextLink, new FakeElement('span', {}, '下一条'));
  const root = assignDomOrder(new FakeElement('div').append(parentRow, replyList, moreReplies, nextRow));
  const controls = api.findReplyDisclosureControls(root, parentRow);
  assert.equal(controls.length, 1);
  assert.equal(controls[0], moreReplies);
});

test('评论行扩大到外层时会把正文当作控件文案，紧边界保留正文', () => {
  const { api } = load();
  const link = new FakeElement('a', { href: '/p/example/c/101/' }, 'alice');
  const text = new FakeElement('span', {}, '需要保留的评论正文');
  const body = new FakeElement('div').append(link, text);
  const outerAction = new FakeElement('div', { role: 'button' }).append(body);
  const row = new FakeElement('div').append(outerAction, new FakeElement('button', {}, '查看所有2条回复'));
  assert.equal(api.findCommentRow(link), outerAction);
  assert.equal(api.getAccessibleLabels(row).some((label) => label.includes('需要保留的评论正文')), true);
});

test('没有明确列表结构时，不按时间链接横坐标误判一级评论', () => {
  const { api } = load();
  const nodes = ['1', '2', '3', '4'].map((id) => new FakeElement('a', { href: `/p/example/c/${id}/` }));
  nodes.forEach((node, index) => {
    node.getBoundingClientRect = () => ({ left: [40, 72, 104, 40][index], width: 24, height: 24 });
    node.compareDocumentPosition = (other) => nodes.indexOf(node) < nodes.indexOf(other) ? 4 : 2;
  });
  const ids = api.deriveReplyParentIds(nodes.map((anchor) => ({ id: anchor.getAttribute('href').match(/c\/(\d+)/)[1], anchor })));
  assert.equal(ids.size, 0);
  assert.equal(ids.has('4'), false);
});

test('页面已有真实回复列表时，不用时间链接横向坐标误判一级评论', () => {
  const { api } = load();
  const parent = new FakeElement('a', { href: '/p/example/c/1/' });
  const replyList = new FakeElement('ul');
  const reply = new FakeElement('a', { href: '/p/example/c/2/' });
  replyList.append(reply);
  const nextParent = new FakeElement('a', { href: '/p/example/c/3/' });
  const root = assignDomOrder(new FakeElement('div').append(parent, replyList, nextParent));
  parent.getBoundingClientRect = () => ({ left: 40, width: 24, height: 24 });
  reply.getBoundingClientRect = () => ({ left: 72, width: 24, height: 24 });
  nextParent.getBoundingClientRect = () => ({ left: 104, width: 24, height: 24 });
  const ids = api.deriveReplyParentIds([
    { id: '1', anchor: parent },
    { id: '2', anchor: reply },
    { id: '3', anchor: nextParent },
  ]);
  assert.equal(ids.get('2'), '1');
  assert.equal(ids.has('3'), false);
});

test('回复只有在存在明确列表层级时才建立父级关系', () => {
  const { api } = load();
  const parentLink = new FakeElement('a', { href: '/p/example/c/1/' });
  const control = new FakeElement('button', {}, '查看所有2条回复');
  const replyLink = new FakeElement('a', { href: '/p/example/c/2/' });
  const row = new FakeElement('div').append(parentLink, control, replyLink);
  parentLink.compareDocumentPosition = (other) => other === control || other === replyLink ? 4 : 2;
  control.compareDocumentPosition = (other) => other === replyLink ? 4 : 2;
  replyLink.compareDocumentPosition = (other) => other === parentLink || other === control ? 2 : 0;
  const ids = api.deriveReplyParentIds([{ id: '1', anchor: parentLink, element: row }, { id: '2', anchor: replyLink, element: row }]);
  assert.equal(ids.has('2'), false);
  assert.equal(ids.has('1'), false);
});

test('一个评论的回复列表不会把后续一级评论入口误判为已展开', () => {
  const { api } = load();
  const parentLink = new FakeElement('a', { href: '/p/example/c/1/' });
  const parentRow = new FakeElement('div').append(parentLink);
  const firstExpander = replyButton('查看所有2条回复');
  const firstReplies = new FakeElement('ul');
  const nextLink = new FakeElement('a', { href: '/p/example/c/2/' });
  const nextRow = new FakeElement('div').append(nextLink);
  const nextExpander = replyButton('查看所有3条回复');
  const root = assignDomOrder(new FakeElement('div').append(parentRow, firstExpander, firstReplies, nextRow, nextExpander));
  const controls = api.findReplyDisclosureControls(root);
  assert.equal(controls.includes(firstExpander), false);
  assert.equal(controls.includes(nextExpander), true);
});

test('评论菜单优先使用评论行内 SVG 结构并递归读取子级标签', () => {
  const { api } = load();
  const row = new FakeElement('article');
  const menu = new FakeElement('button').append(new FakeElement('div').append(new FakeElement('svg', { role: 'img' }).append(new FakeElement('circle'), new FakeElement('circle'), new FakeElement('circle'))));
  const like = new FakeElement('button', {}, '点赞').append(new FakeElement('svg', { role: 'img' }));
  row.append(like, menu);
  menu.firstElementChild.firstElementChild.setAttribute('aria-label', '评论选项');
  assert.ok(api.getAccessibleLabels(menu).includes('评论选项'));
  assert.equal(api.findCommentMenu(row), menu);
  assert.deepEqual(api.findCommentMenuResult(row).status, 'ok');
});

test('评论行内没有唯一选项控件时返回歧义或未找到，不猜测其它按钮', () => {
  const { api } = load();
  const row = new FakeElement('article');
  const first = new FakeElement('button').append(new FakeElement('svg', { role: 'img' }).append(new FakeElement('circle'), new FakeElement('circle'), new FakeElement('circle')));
  const second = new FakeElement('button').append(new FakeElement('svg', { role: 'img' }).append(new FakeElement('circle'), new FakeElement('circle'), new FakeElement('circle')));
  row.append(first, second);
  assert.equal(api.findCommentMenuResult(row).status, 'ambiguous');
  const empty = new FakeElement('article').append(new FakeElement('button', {}, '回复'));
  assert.equal(api.findCommentMenuResult(empty).status, 'not-found');
});

test('删除动作只在新弹层内匹配，并区分无权限的举报菜单', () => {
  const { api, documentRef } = load();
  const oldDialog = new FakeElement('div', { role: 'dialog' }).append(new FakeElement('button', {}, '取消'));
  documentRef.append(oldDialog);
  const before = api.captureActionSurfaceState(documentRef);
  const dialog = new FakeElement('div', { role: 'dialog', 'aria-modal': 'true' }).append(new FakeElement('button', {}, '删除评论'));
  documentRef.append(dialog);
  assert.equal(api.findActionSurface(before, documentRef), dialog);
  assert.equal(api.findDeleteAction(dialog), dialog.firstElementChild);
  const report = new FakeElement('div', { role: 'dialog' }).append(new FakeElement('button', {}, '举报'), new FakeElement('button', {}, '取消'));
  assert.equal(api.describeDeleteAction(report).reason, 'permission');
});

test('标签配置覆盖日文、简体中文、繁体中文和英文删除短语', () => {
  const { labels } = load();
  for (const [language, value] of [['ja', 'コメントを削除する'], ['zh-CN', '删除评论'], ['zh-TW', '刪除留言'], ['en', 'Delete comment']]) {
    assert.equal(labels.matchControlLabel('delete', [value], language).matched, true, language);
  }
  assert.equal(labels.matchControlLabel('replyDisclosure', ['查看所有2条回复'], 'zh-CN').matched, true);
});
