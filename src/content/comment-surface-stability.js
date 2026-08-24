(function (global) {
  'use strict';

  // 该模块不触碰页面 DOM，只负责把有序身份信息变成稳定签名，便于在 Node 中覆盖
  // 容器替换和两次采样比较等关键分支。
  const DEFAULTS = {
    mutationDebounceMs: 250,
    rafConfirmCount: 2,
    stablePasses: 2,
    initialReadyTimeoutMs: 15000,
    postDeleteSettleTimeoutMs: 10000,
    emptyRescanAttempts: 3,
  };

  function sortedRecords(records) {
    return [...(records || [])]
      .map((record) => Object.fromEntries(Object.entries(record || {}).sort(([left], [right]) => left.localeCompare(right))))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }

  function snapshotSignature(snapshot) {
    return JSON.stringify({
      surfaceGeneration: Number(snapshot?.surfaceGeneration || 0),
      connected: Boolean(snapshot?.connected),
      commentIds: [...new Set(snapshot?.commentIds || [])].map(String).sort(),
      mappedReplies: sortedRecords(snapshot?.mappedReplies),
      data: sortedRecords(snapshot?.data),
    });
  }

  function samplesAreStable(first, second) {
    return Boolean(
      first && second
      && first.surfaceGeneration === second.surfaceGeneration
      && first.mutationVersion === second.mutationVersion
      && first.signature === second.signature,
    );
  }

  global.InstagramCommentSurfaceStability = { DEFAULTS, snapshotSignature, samplesAreStable };
})(globalThis);
