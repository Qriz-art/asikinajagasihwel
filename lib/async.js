export function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function withTimeout(promise, milliseconds, message = "Waktu permintaan habis.") {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function mapLimit(items, concurrency, mapper) {
  const list = Array.isArray(items) ? items : [];
  const results = new Array(list.length);
  let cursor = 0;

  async function worker() {
    while (cursor < list.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(list[index], index);
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, list.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
