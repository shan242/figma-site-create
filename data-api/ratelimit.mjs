// ratelimit.mjs — 进程内滑动窗口限流(契约 §6.1)。
//
// 单进程部署,内存计数就够;不需要 Redis。key 形如 "site:foo:post" / "ip:ab12:post"。
export function createRateLimiter({ now = Date.now } = {}) {
  const buckets = new Map();
  let ops = 0;

  const pruneStale = (windowMs) => {
    const cutoff = now() - windowMs;
    for (const [k, arr] of buckets) {
      // 数组按时间递增,丢掉过期头部
      let i = 0;
      while (i < arr.length && arr[i] <= cutoff) i++;
      if (i >= arr.length) buckets.delete(k);
      else if (i) buckets.set(k, arr.slice(i));
    }
  };

  return {
    // limit: 窗口内允许的次数;windowMs: 窗口长度
    check(key, limit, windowMs) {
      const t = now();
      const arr = buckets.get(key) || [];
      const cutoff = t - windowMs;
      let i = 0;
      while (i < arr.length && arr[i] <= cutoff) i++;
      const live = i ? arr.slice(i) : arr;
      if (live.length >= limit) {
        buckets.set(key, live);
        const retryMs = live[0] + windowMs - t;
        return { ok: false, retryAfterSec: Math.max(1, Math.ceil(retryMs / 1000)) };
      }
      live.push(t);
      buckets.set(key, live);
      // 每 1000 次调用清一次,避免长跑进程堆积 key
      if (++ops % 1000 === 0) pruneStale(windowMs);
      return { ok: true };
    },
    size: () => buckets.size,
  };
}
