const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

class FakeElement {
  constructor(tagName, attrs = {}, text = '') {
    this.tagName = tagName.toUpperCase();
    this.attrs = { ...attrs };
    this.textContent = text;
    this.innerText = text;
    this.children = [];
    this.parentElement = null;
    this.parentNode = null;
    this.isConnected = true;
    this.disabled = false;
  }
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

test('回复展开控件优先匹配正则文案，不把同结构普通回复按钮当成展开入口', () => {
  const { api } = load();
  const shaped = replyButton('随机文案');
  const expander = new FakeElement('button', {}, '查看所有2条回复');
  const ordinary = new FakeElement('button', {}, '回复');
  assert.equal(api.isReplyDisclosureShape(shaped), true);
  assert.equal(api.isReplyDisclosureShape(ordinary), false);
  assert.equal(api.isExpansionControl(shaped), false);
  assert.equal(api.isExpansionControl(expander), true);
  const wrapper = new FakeElement('div').append(shaped, ordinary, expander);
  const controls = api.findReplyDisclosureControls(wrapper);
  assert.equal(controls.length, 1);
  assert.equal(controls[0], expander);
});

test('回复入口通过 aria-expanded 判断已展开，不依赖 ul', () => {
  const { api } = load();
  const control = new FakeElement('button', { 'aria-expanded': 'true' }, '查看所有2条回复');
  assert.equal(api.isExpandedReplyDisclosure(control), true);
  const wrapper = new FakeElement('div').append(control);
  assert.equal(api.findReplyDisclosureControls(wrapper).length, 0);
});

test('评论行定位会越过普通回复按钮，直到找到正则匹配的展开入口', () => {
  const { api } = load();
  const link = new FakeElement('a', { href: '/p/example/c/101/' }, '作者');
  const body = new FakeElement('div').append(link, new FakeElement('button', {}, '回复'));
  const row = new FakeElement('div').append(body, new FakeElement('button', {}, '查看所有2条回复'));
  const surface = new FakeElement('main').append(row);
  assert.equal(api.findCommentRow(link), row);
  assert.equal(surface.children.length, 1);
});

test('回复父级按 DOM 顺序和明确缩进推断，不依赖 ul', () => {
  const { api } = load();
  const nodes = ['1', '2', '3', '4'].map((id) => new FakeElement('a', { href: `/p/example/c/${id}/` }));
  nodes.forEach((node, index) => {
    node.getBoundingClientRect = () => ({ left: [40, 72, 104, 40][index], width: 24, height: 24 });
    node.compareDocumentPosition = (other) => nodes.indexOf(node) < nodes.indexOf(other) ? 4 : 2;
  });
  const ids = api.deriveReplyParentIds(nodes.map((anchor) => ({ id: anchor.getAttribute('href').match(/c\/(\d+)/)[1], anchor })));
  assert.equal(ids.get('2'), '1');
  assert.equal(ids.get('3'), '2');
  assert.equal(ids.has('4'), false);
});

test('回复位于正则展开控件之后时，优先归属控件前的一级评论', () => {
  const { api } = load();
  const parentLink = new FakeElement('a', { href: '/p/example/c/1/' });
  const control = new FakeElement('button', {}, '查看所有2条回复');
  const replyLink = new FakeElement('a', { href: '/p/example/c/2/' });
  const row = new FakeElement('div').append(parentLink, control, replyLink);
  parentLink.compareDocumentPosition = (other) => other === control || other === replyLink ? 4 : 2;
  control.compareDocumentPosition = (other) => other === replyLink ? 4 : 2;
  replyLink.compareDocumentPosition = (other) => other === parentLink || other === control ? 2 : 0;
  const ids = api.deriveReplyParentIds([{ id: '1', anchor: parentLink, element: row }, { id: '2', anchor: replyLink, element: row }]);
  assert.equal(ids.get('2'), '1');
  assert.equal(ids.has('1'), false);
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
