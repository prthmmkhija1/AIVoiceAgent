/**
 * Retry Utility with Exponential Backoff
 * 
 * Provides robust retry logic for network operations (TTS, LLM).
 * Implements exponential backoff with jitter to prevent thundering herd.
 */

/**
 * Default retry configuration
 */
export const DEFAULT_RETRY_CONFIG = {
  maxRetries: 3,
  initialDelayMs: 500,
  maxDelayMs: 5000,
  backoffMultiplier: 2,
  jitterFactor: 0.2,  // ±20% randomness
};

/**
 * Calculate delay with exponential backoff and jitter
 * @param {number} attempt - Current attempt number (0-indexed)
 * @param {Object} config - Retry configuration
 * @returns {number} - Delay in milliseconds
 */
function calculateDelay(attempt, config) {
  const baseDelay = config.initialDelayMs * Math.pow(config.backoffMultiplier, attempt);
  const cappedDelay = Math.min(baseDelay, config.maxDelayMs);
  
  // Add jitter (±jitterFactor of the delay)
  const jitter = cappedDelay * config.jitterFactor * (Math.random() * 2 - 1);
  return Math.round(cappedDelay + jitter);
}

/**
 * Sleep for specified milliseconds
 * @param {number} ms 
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Execute an async function with retry logic
 * 
 * @param {Function} fn - Async function to execute
 * @param {Object} options - Options
 * @param {Object} options.config - Retry configuration (default: DEFAULT_RETRY_CONFIG)
 * @param {string} options.operationName - Name for logging (e.g., 'TTS', 'LLM')
 * @param {Function} options.shouldRetry - (error) => boolean - whether to retry on this error
 * @param {Function} options.onRetry - (attempt, delay, error) => void - called before each retry
 * @returns {Promise<T>} - Result of the function
 */
export async function withRetry(fn, options = {}) {
  const config = { ...DEFAULT_RETRY_CONFIG, ...options.config };
  const operationName = options.operationName || 'Operation';
  const shouldRetry = options.shouldRetry || isRetryableError;
  const onRetry = options.onRetry || defaultOnRetry;

  let lastError;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Check if this is the last attempt
      if (attempt === config.maxRetries) {
        console.error(`❌ [${operationName}] Failed after ${config.maxRetries + 1} attempts:`, error.message);
        throw error;
      }

      // Check if we should retry this type of error
      if (!shouldRetry(error)) {
        console.error(`❌ [${operationName}] Non-retryable error:`, error.message);
        throw error;
      }

      // Calculate delay and retry
      const delay = calculateDelay(attempt, config);
      onRetry(attempt, delay, error, operationName);
      await sleep(delay);
    }
  }

  throw lastError;
}

/**
 * Default retry callback - logs retry attempts
 */
function defaultOnRetry(attempt, delay, error, operationName) {
  console.warn(`⚠️ [${operationName}] Attempt ${attempt + 1} failed: ${error.message}. Retrying in ${delay}ms...`);
}

/**
 * Default logic to determine if an error is retryable
 * Retries on network errors, rate limits, and server errors (5xx)
 * 
 * @param {Error} error 
 * @returns {boolean}
 */
export function isRetryableError(error) {
  // Network errors
  if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.code === 'ENOTFOUND') {
    return true;
  }

  // HTTP status-based errors
  const status = error.status || error.statusCode || error.response?.status;
  if (status) {
    // Rate limited (429) or server errors (500-599)
    if (status === 429 || (status >= 500 && status < 600)) {
      return true;
    }
    // Don't retry client errors (400-499 except 429)
    if (status >= 400 && status < 500) {
      return false;
    }
  }

  // Retry on timeout messages
  if (error.message?.toLowerCase().includes('timeout')) {
    return true;
  }

  // Default: retry on unknown errors
  return true;
}

/**
 * Create a wrapper that automatically retries a class method
 * 
 * @param {Object} instance - Class instance
 * @param {string} methodName - Method name to wrap
 * @param {Object} options - Retry options
 * @returns {Function} - Wrapped method with retry logic
 */
export function wrapWithRetry(instance, methodName, options = {}) {
  const originalMethod = instance[methodName].bind(instance);
  
  return async function(...args) {
    return withRetry(
      () => originalMethod(...args),
      { ...options, operationName: options.operationName || methodName }
    );
  };
}
