/** Token bucket: `capacity` actions at once, refilled at `perSecond`. */
export class TokenBucket {
  constructor(capacity, perSecond, now = Date.now) {
    this.capacity = capacity;
    this.perSecond = perSecond;
    this.now = now;
    this.tokens = capacity;
    this.updated = now();
  }

  take(cost = 1) {
    const t = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((t - this.updated) / 1000) * this.perSecond);
    this.updated = t;
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}

/** Counts failures per key inside a sliding window, e.g. bad logins per address. */
export class FailureWindow {
  constructor(limit, windowMs, now = Date.now) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.entries = new Map();
  }

  blocked(key) {
    const entry = this.entries.get(key);
    if (!entry) return false;
    if (this.now() - entry.since > this.windowMs) {
      this.entries.delete(key);
      return false;
    }
    return entry.count >= this.limit;
  }

  fail(key) {
    const t = this.now();
    const entry = this.entries.get(key);
    if (!entry || t - entry.since > this.windowMs) this.entries.set(key, { count: 1, since: t });
    else entry.count += 1;
    if (this.entries.size > 10000) this.#prune(t);
  }

  /** Takes back one `fail`, for an attempt that was counted up front and then succeeded. */
  forgive(key) {
    const entry = this.entries.get(key);
    if (entry && entry.count > 0) entry.count -= 1;
  }

  #prune(t) {
    for (const [key, entry] of this.entries) {
      if (t - entry.since > this.windowMs) this.entries.delete(key);
    }
  }
}
