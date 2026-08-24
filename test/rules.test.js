const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const context = { URL };
vm.createContext(context);
vm.runInContext(fs.readFileSync('src/content/rules.js', 'utf8'), context);

test('帖子作者的一级评论和回复不会进入删除候选', () => {
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
  assert.equal(result.skipped, 2);
});

test('普通评论仍按关键词进入候选', () => {
  const rules = context.InstagramCommentRules.prepareRules({ deleteKeywords: 'spam', whitelist: '' });
  const result = context.InstagramCommentRules.selectCandidates([{ username: 'visitor', text: 'spam', childCount: 0, hasUnloadedReplies: false, replies: [] }], rules);
  assert.equal(result.candidates.length, 1);
});
