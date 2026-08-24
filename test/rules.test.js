const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const context = { URL };
vm.createContext(context);
vm.runInContext(fs.readFileSync('src/content/rules.js', 'utf8'), context);

test('一级评论永远不会进入删除候选，作者回复也会保护', () => {
  const rules = context.InstagramCommentRules.prepareRules({ deleteKeywords: 'spam', whitelist: '' });
  const threads = [{
    username: 'post-owner', text: 'spam', isPostAuthor: true, childCount: 2, hasUnloadedReplies: false,
    replies: [
      { username: 'post-owner', text: 'spam', isPostAuthor: true },
      { username: 'visitor', text: 'spam' },
    ],
  }];
  const result = context.InstagramCommentRules.selectCandidates(threads, rules);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].username, 'visitor');
  assert.equal(result.skipped, 1);
});

test('命中关键词的子级回复进入候选', () => {
  const rules = context.InstagramCommentRules.prepareRules({ deleteKeywords: 'spam', whitelist: '' });
  const result = context.InstagramCommentRules.selectCandidates([{ username: 'owner', text: 'parent', replies: [{ id: 'r1', username: 'visitor', text: 'spam' }] }], rules);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].kind, 'reply');
});

test('帖子作者的一级评论下，其他用户的命中回复进入候选', () => {
  const rules = context.InstagramCommentRules.prepareRules({ deleteKeywords: 'spam', whitelist: '' });
  const result = context.InstagramCommentRules.selectCandidates([{
    username: 'post-owner', isPostAuthor: true, text: '正常内容',
    replies: [{ id: 'r-author-child', username: 'visitor', text: 'spam' }],
  }], rules);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].id, 'r-author-child');
});

test('多级嵌套回复也会递归扫描', () => {
  const rules = context.InstagramCommentRules.prepareRules({ deleteKeywords: 'spam', whitelist: '' });
  const result = context.InstagramCommentRules.selectCandidates([{
    username: 'post-owner', isPostAuthor: true, text: '正常内容',
    replies: [{ id: 'r1', username: 'visitor', text: '普通回复', replies: [{ id: 'r2', username: 'visitor2', text: 'spam' }] }],
  }], rules);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].id, 'r2');
});

test('命中关键词的一级评论不会进入候选', () => {
  const rules = context.InstagramCommentRules.prepareRules({ deleteKeywords: 'spam', whitelist: '' });
  const result = context.InstagramCommentRules.selectCandidates([{ username: 'visitor', text: 'spam', replies: [] }], rules);
  assert.equal(result.candidates.length, 0);
});
