/**
 * api-client.ts - HTTP client with retry logic and timeout handling
 *
 * Provides fetchWithRetry wrapper around native fetch with:
 * - Exponential backoff for retries
 * - Timeout support via AbortController
 * - Retry-After header parsing
 */

/**
 * HTTP status codes that should trigger a retry
 */
const RETRY_STATUS_CODES = [408, 429, 500, 502, 503, 504];

/**
 * Configuration for HTTP client
 */
export type FetchConfig = {
  timeout: number;      // Request timeout in seconds
  maxRetries: number;   // Maximum number of retry attempts
  retryDelay: number;   // Initial retry delay in seconds
};

/**
 * Fetch with retry logic and timeout handling
 *
 * @param url - URL to fetch
 * @param options - Fetch options (headers, body, etc.)
 * @param config - Retry and timeout configuration
 * @returns Response object
 * @throws Error after exhausting all retries or on timeout
 */
export async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  config: FetchConfig
): Promise<Response> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  let lastError: Error | null = null;

  try {
    for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
      try {
        // Set timeout for this attempt
        if (timeoutId) clearTimeout(timeoutId);
        timeoutId = setTimeout(() => controller.abort(), config.timeout * 1000);

        // Make the request with abort signal
        const response = await fetch(url, {
          ...options,
          signal: controller.signal,
        });

        // Check if status code should trigger a retry
        if (RETRY_STATUS_CODES.includes(response.status)) {
          if (attempt < config.maxRetries) {
            // Calculate delay with exponential backoff
            let delay = Math.pow(2, attempt) * config.retryDelay * 1000;

            // For 429 (rate limit), check Retry-After header
            if (response.status === 429) {
              const retryAfter = response.headers.get("Retry-After");
              if (retryAfter) {
                const seconds = parseInt(retryAfter, 10);
                if (!isNaN(seconds)) {
                  delay = seconds * 1000;
                }
              }
            }

            // Wait before retrying
            await new Promise((resolve) => setTimeout(resolve, delay));
            continue;
          } else {
            // All retries exhausted - throw error
            if (timeoutId) clearTimeout(timeoutId);
            throw new Error(`Request failed after ${config.maxRetries + 1} attempts`);
          }
        }

        // Success or non-retryable error - clear timeout and return
        if (timeoutId) clearTimeout(timeoutId);
        return response;
      } catch (error) {
        lastError = error as Error;

        // Check if this was a timeout (abort)
        if (error instanceof Error && error.name === "AbortError") {
          if (timeoutId) clearTimeout(timeoutId);
          // Don't throw immediately - let retry logic handle it
        }

        // If we're out of retries, throw
        if (attempt >= config.maxRetries) {
          break;
        }

        // Network error or timeout - retry with exponential backoff
        const delay = Math.pow(2, attempt) * config.retryDelay * 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }

  // All retries exhausted
  if (lastError instanceof Error && lastError.name === "AbortError") {
    const totalAttempts = config.maxRetries + 1;
    const attemptsText = totalAttempts === 1 ? "1 attempt" : `${totalAttempts} attempts`;
    throw new Error(`Request timeout after ${config.timeout}s (${attemptsText})`);
  }
  throw new Error(
    `Request failed after ${config.maxRetries + 1} attempts: ${lastError?.message || "Unknown error"}`
  );
}

/**
 * Make a JSON POST request with retry logic
 *
 * @param url - URL to post to
 * @param body - Request body (will be JSON stringified)
 * @param apiKey - API key for authentication
 * @param config - Retry and timeout configuration
 * @returns Parsed JSON response
 * @throws Error on request failure or non-2xx status
 */
export async function postJSON<T = any>(
  url: string,
  body: any,
  apiKey: string,
  config: FetchConfig
): Promise<T> {
  const response = await fetchWithRetry(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    },
    config
  );

  // Check for error status
  if (!response.ok) {
    const errorText = await response.text();
    let errorMessage = `HTTP ${response.status}`;

    try {
      const errorData = JSON.parse(errorText);
      if (errorData.error?.message) {
        errorMessage += `: ${errorData.error.message}`;
      } else if (errorData.message) {
        errorMessage += `: ${errorData.message}`;
      }
    } catch {
      // Not JSON, use raw text
      if (errorText) {
        errorMessage += `: ${errorText.substring(0, 200)}`;
      }
    }

    throw new Error(errorMessage);
  }

  // Parse and return JSON
  return await response.json();
}
