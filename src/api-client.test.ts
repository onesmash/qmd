/**
 * api-client.test.ts - Tests for HTTP client with retry logic
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { fetchWithRetry, postJSON, type FetchConfig } from "./api-client";

describe("api-client", () => {
  const defaultConfig: FetchConfig = {
    timeout: 5,
    maxRetries: 3,
    retryDelay: 0.1, // Short delay for tests
  };

  // Store original fetch
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    // Restore original fetch
    globalThis.fetch = originalFetch;
  });

  describe("fetchWithRetry", () => {
    test("returns response on success", async () => {
      const mockResponse = new Response("success", { status: 200 });
      globalThis.fetch = mock(() => Promise.resolve(mockResponse));

      const response = await fetchWithRetry("https://api.test.com", {}, defaultConfig);

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("success");
    });

    test("retries on 500 error", async () => {
      let attempts = 0;
      globalThis.fetch = mock(() => {
        attempts++;
        if (attempts < 3) {
          return Promise.resolve(new Response("error", { status: 500 }));
        }
        return Promise.resolve(new Response("success", { status: 200 }));
      });

      const response = await fetchWithRetry("https://api.test.com", {}, defaultConfig);

      expect(response.status).toBe(200);
      expect(attempts).toBe(3);
    });

    test("retries on 502, 503, 504 errors", async () => {
      for (const status of [502, 503, 504]) {
        let attempts = 0;
        globalThis.fetch = mock(() => {
          attempts++;
          if (attempts < 2) {
            return Promise.resolve(new Response("error", { status }));
          }
          return Promise.resolve(new Response("success", { status: 200 }));
        });

        const response = await fetchWithRetry("https://api.test.com", {}, defaultConfig);

        expect(response.status).toBe(200);
        expect(attempts).toBe(2);
      }
    });

    test("retries on 429 with Retry-After header", async () => {
      let attempts = 0;
      globalThis.fetch = mock(() => {
        attempts++;
        if (attempts < 2) {
          return Promise.resolve(
            new Response("rate limit", {
              status: 429,
              headers: { "Retry-After": "1" },
            })
          );
        }
        return Promise.resolve(new Response("success", { status: 200 }));
      });

      const response = await fetchWithRetry("https://api.test.com", {}, defaultConfig);

      expect(response.status).toBe(200);
      expect(attempts).toBe(2);
    });

    test("retries on network error", async () => {
      let attempts = 0;
      globalThis.fetch = mock(() => {
        attempts++;
        if (attempts < 3) {
          return Promise.reject(new Error("Network error"));
        }
        return Promise.resolve(new Response("success", { status: 200 }));
      });

      const response = await fetchWithRetry("https://api.test.com", {}, defaultConfig);

      expect(response.status).toBe(200);
      expect(attempts).toBe(3);
    });

    test("throws error after max retries exhausted", async () => {
      globalThis.fetch = mock(() => Promise.resolve(new Response("error", { status: 500 })));

      await expect(fetchWithRetry("https://api.test.com", {}, defaultConfig)).rejects.toThrow(
        /Request failed after 4 attempts/
      );
    });

    test("throws timeout error", async () => {
      globalThis.fetch = mock(
        (_url, options) =>
          new Promise((resolve, reject) => {
            const signal = options?.signal as AbortSignal;

            // Check if signal is already aborted
            if (signal?.aborted) {
              const error = new Error("The operation was aborted");
              error.name = "AbortError";
              reject(error);
              return;
            }

            // Set up abort listener
            if (signal) {
              const onAbort = () => {
                const error = new Error("The operation was aborted");
                error.name = "AbortError";
                reject(error);
              };
              signal.addEventListener("abort", onAbort);
            }

            // Simulate a slow response
            setTimeout(() => resolve(new Response("late")), 10000);
          })
      );

      const shortTimeout = { ...defaultConfig, timeout: 0.1 };

      await expect(fetchWithRetry("https://api.test.com", {}, shortTimeout)).rejects.toThrow(
        /Request timeout after 0.1s \(4 attempts\)/
      );
    });

    test("timeout applies per attempt, not total operation", async () => {
      // This test shows that with retries, the total operation time could be
      // (maxRetries + 1) * timeout seconds
      let attemptCount = 0;
      globalThis.fetch = mock(
        (_url, options) =>
          new Promise((resolve, reject) => {
            attemptCount++;
            const signal = options?.signal as AbortSignal;

            // Check if signal is already aborted
            if (signal?.aborted) {
              const error = new Error("The operation was aborted");
              error.name = "AbortError";
              reject(error);
              return;
            }

            // Set up abort listener
            if (signal) {
              const onAbort = () => {
                const error = new Error("The operation was aborted");
                error.name = "AbortError";
                reject(error);
              };
              signal.addEventListener("abort", onAbort);
            }

            // Always timeout - simulate slow API
            setTimeout(() => resolve(new Response("late")), 10000);
          })
      );

      const configWithRetries = { ...defaultConfig, timeout: 0.1, maxRetries: 2 };

      await expect(fetchWithRetry("https://api.test.com", {}, configWithRetries)).rejects.toThrow(
        /Request timeout after 0.1s \(3 attempts\)/
      );

      // Should have attempted 3 times (initial + 2 retries)
      expect(attemptCount).toBe(3);
    });

    test("does not retry on 400 client error", async () => {
      let attempts = 0;
      globalThis.fetch = mock(() => {
        attempts++;
        return Promise.resolve(new Response("bad request", { status: 400 }));
      });

      const response = await fetchWithRetry("https://api.test.com", {}, defaultConfig);

      expect(response.status).toBe(400);
      expect(attempts).toBe(1); // No retries
    });

    test("does not retry on 401 unauthorized", async () => {
      let attempts = 0;
      globalThis.fetch = mock(() => {
        attempts++;
        return Promise.resolve(new Response("unauthorized", { status: 401 }));
      });

      const response = await fetchWithRetry("https://api.test.com", {}, defaultConfig);

      expect(response.status).toBe(401);
      expect(attempts).toBe(1); // No retries
    });

    test("passes through request options", async () => {
      let capturedOptions: RequestInit | undefined;
      globalThis.fetch = mock((url, options) => {
        capturedOptions = options;
        return Promise.resolve(new Response("success", { status: 200 }));
      });

      await fetchWithRetry(
        "https://api.test.com",
        {
          method: "POST",
          headers: { "X-Custom": "test" },
          body: JSON.stringify({ foo: "bar" }),
        },
        defaultConfig
      );

      expect(capturedOptions?.method).toBe("POST");
      expect((capturedOptions?.headers as any)["X-Custom"]).toBe("test");
      expect(capturedOptions?.body).toBe(JSON.stringify({ foo: "bar" }));
    });
  });

  describe("postJSON", () => {
    test("makes POST request with JSON body and authorization", async () => {
      let capturedUrl: string | undefined;
      let capturedOptions: RequestInit | undefined;

      globalThis.fetch = mock((url, options) => {
        capturedUrl = url as string;
        capturedOptions = options;
        return Promise.resolve(
          new Response(JSON.stringify({ result: "success" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        );
      });

      const result = await postJSON(
        "https://api.test.com/endpoint",
        { input: "test" },
        "sk-test123",
        defaultConfig
      );

      expect(capturedUrl).toBe("https://api.test.com/endpoint");
      expect(capturedOptions?.method).toBe("POST");
      expect((capturedOptions?.headers as any)["Content-Type"]).toBe("application/json");
      expect((capturedOptions?.headers as any)["Authorization"]).toBe("Bearer sk-test123");
      expect(capturedOptions?.body).toBe(JSON.stringify({ input: "test" }));
      expect(result).toEqual({ result: "success" });
    });

    test("throws error on non-2xx status", async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: { message: "API error" } }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          })
        )
      );

      await expect(
        postJSON("https://api.test.com/endpoint", { input: "test" }, "sk-test123", defaultConfig)
      ).rejects.toThrow(/HTTP 400: API error/);
    });

    test("handles non-JSON error responses", async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(
          new Response("Internal Server Error", {
            status: 500,
          })
        )
      );

      await expect(
        postJSON("https://api.test.com/endpoint", { input: "test" }, "sk-test123", defaultConfig)
      ).rejects.toThrow(/Request failed after 4 attempts/);
    });

    test("parses JSON response correctly", async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              data: [{ id: 1, value: "test" }],
              meta: { count: 1 },
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }
          )
        )
      );

      const result = await postJSON<any>(
        "https://api.test.com/endpoint",
        { query: "test" },
        "sk-test123",
        defaultConfig
      );

      expect(result.data).toHaveLength(1);
      expect(result.data[0].id).toBe(1);
      expect(result.meta.count).toBe(1);
    });
  });
});
