const stores = new Map();

function getStore(bucket) {
  if (!stores.has(bucket)) {
    stores.set(bucket, new Map());
  }

  return stores.get(bucket);
}

export function getClientIp(request) {
  const forwarded = request?.headers?.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }

  return (
    request?.headers?.get("x-real-ip") ||
    request?.headers?.get("cf-connecting-ip") ||
    "unknown"
  );
}

export function checkRateLimit(request, bucket, limit, windowMs) {
  const store = getStore(bucket);
  const key = getClientIp(request);
  const now = Date.now();
  const current = store.get(key);

  if (!current || current.resetAt <= now) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    if (store.size > 2000) {
      for (const [storedKey, value] of store.entries()) {
        if (value.resetAt <= now) {
          store.delete(storedKey);
        }
      }
    }

    return {
      limited: false,
      remaining: Math.max(0, limit - 1),
      retryAfter: Math.ceil(windowMs / 1000),
    };
  }

  current.count += 1;
  const limited = current.count > limit;
  return {
    limited,
    remaining: Math.max(0, limit - current.count),
    retryAfter: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
  };
}

export function rateLimitHeaders(result) {
  return {
    "Retry-After": String(result.retryAfter),
    "X-RateLimit-Remaining": String(result.remaining),
  };
}
