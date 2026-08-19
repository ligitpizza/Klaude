async function withRetry(fn, { retries = 2, delayMs = 1500 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  throw lastErr;
}

module.exports = { withRetry };
