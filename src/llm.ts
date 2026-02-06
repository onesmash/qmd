/**
 * llm.ts - LLM abstraction layer for QMD
 *
 * Provides embeddings, query expansion, and reranking via cloud APIs.
 * Replaces node-llama-cpp with SiliconFlow API.
 */

import { ApiClient } from "./llm-api";
import { loadConfig, type ApiConfig } from "./api-config";

// =============================================================================
// Embedding Formatting Functions
// =============================================================================

/**
 * Format a query for embedding.
 * Uses nomic-style task prefix format.
 */
export function formatQueryForEmbedding(query: string): string {
  return `task: search result | query: ${query}`;
}

/**
 * Format a document for embedding.
 * Uses nomic-style format with title and text fields.
 */
export function formatDocForEmbedding(text: string, title?: string): string {
  return `title: ${title || "none"} | text: ${text}`;
}

// =============================================================================
// Types
// =============================================================================

/**
 * Token with log probability (kept for compatibility)
 */
export type TokenLogProb = {
  token: string;
  logprob: number;
};

/**
 * Embedding result
 */
export type EmbeddingResult = {
  embedding: number[];
  model: string;
};

/**
 * Generation result with optional logprobs (kept for compatibility)
 */
export type GenerateResult = {
  text: string;
  model: string;
  logprobs?: TokenLogProb[];
  done: boolean;
};

/**
 * Rerank result for a single document
 */
export type RerankDocumentResult = {
  file: string;
  score: number;
  index: number;
};

/**
 * Batch rerank result
 */
export type RerankResult = {
  results: RerankDocumentResult[];
  model: string;
};

/**
 * Model info (kept for compatibility)
 */
export type ModelInfo = {
  name: string;
  exists: boolean;
  path?: string;
};

/**
 * Options for embedding
 */
export type EmbedOptions = {
  model?: string;
  isQuery?: boolean;
  title?: string;
};

/**
 * Options for text generation
 */
export type GenerateOptions = {
  model?: string;
  maxTokens?: number;
  temperature?: number;
};

/**
 * Options for reranking
 */
export type RerankOptions = {
  model?: string;
};

/**
 * Options for LLM sessions
 */
export type LLMSessionOptions = {
  /** Max session duration in ms (default: 10 minutes) */
  maxDuration?: number;
  /** External abort signal */
  signal?: AbortSignal;
  /** Debug name for logging */
  name?: string;
};

/**
 * Session interface for scoped LLM access with lifecycle guarantees
 */
export interface ILLMSession {
  embed(text: string, options?: EmbedOptions): Promise<EmbeddingResult | null>;
  embedBatch(texts: string[]): Promise<(EmbeddingResult | null)[]>;
  expandQuery(query: string, options?: { context?: string; includeLexical?: boolean }): Promise<Queryable[]>;
  rerank(query: string, documents: RerankDocument[], options?: RerankOptions): Promise<RerankResult>;
  /** Whether this session is still valid (not released or aborted) */
  readonly isValid: boolean;
  /** Abort signal for this session (aborts on release or maxDuration) */
  readonly signal: AbortSignal;
}

/**
 * Supported query types for different search backends
 */
export type QueryType = 'lex' | 'vec' | 'hyde';

/**
 * A single query and its target backend type
 */
export type Queryable = {
  type: QueryType;
  text: string;
};

/**
 * Document to rerank
 */
export type RerankDocument = {
  file: string;
  text: string;
  title?: string;
};

// =============================================================================
// LLM Interface (for compatibility)
// =============================================================================

/**
 * Base LLM interface
 */
export interface LLM {
  embed(text: string, options?: EmbedOptions): Promise<EmbeddingResult | null>;
  embedBatch(texts: string[]): Promise<(EmbeddingResult | null)[]>;
  expandQuery(query: string, options?: { context?: string; includeLexical?: boolean }): Promise<Queryable[]>;
  rerank(query: string, documents: RerankDocument[], options?: RerankOptions): Promise<RerankResult>;
}

// =============================================================================
// Session Management
// =============================================================================

/**
 * Error thrown when attempting to use a released LLM session
 */
export class SessionReleasedError extends Error {
  constructor(message?: string) {
    super(message || "Cannot use released LLM session");
    this.name = "SessionReleasedError";
  }
}

/**
 * Scoped LLM session with lifecycle management
 */
class LLMSession implements ILLMSession {
  private released = false;
  private abortController = new AbortController();
  private timeoutId?: ReturnType<typeof setTimeout>;

  constructor(
    private apiClient: ApiClient,
    options: LLMSessionOptions = {}
  ) {
    const { maxDuration = 600000, signal, name } = options; // 10 minutes default

    // Set timeout if maxDuration is specified
    if (maxDuration > 0) {
      this.timeoutId = setTimeout(() => {
        console.warn(`LLM session ${name || "unnamed"} timed out after ${maxDuration}ms`);
        this.release();
      }, maxDuration);
    }

    // Link external abort signal
    if (signal) {
      if (signal.aborted) {
        this.abortController.abort();
      } else {
        signal.addEventListener("abort", () => this.abortController.abort(), { once: true });
      }
    }
  }

  get isValid(): boolean {
    return !this.released && !this.abortController.signal.aborted;
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  private ensureValid() {
    if (!this.isValid) {
      throw new SessionReleasedError();
    }
  }

  async embed(text: string, options?: EmbedOptions): Promise<EmbeddingResult | null> {
    this.ensureValid();

    // Format text based on options
    let formattedText = text;
    if (options?.isQuery) {
      formattedText = formatQueryForEmbedding(text);
    } else if (options?.title) {
      formattedText = formatDocForEmbedding(text, options.title);
    }

    try {
      return await this.apiClient.embed(formattedText);
    } catch (error) {
      console.error("Embedding failed:", error);
      return null;
    }
  }

  async embedBatch(texts: string[]): Promise<(EmbeddingResult | null)[]> {
    this.ensureValid();

    try {
      const results = await this.apiClient.embedBatch(texts);
      return results;
    } catch (error) {
      console.error("Batch embedding failed:", error);
      return texts.map(() => null);
    }
  }

  async expandQuery(query: string, options?: { context?: string; includeLexical?: boolean }): Promise<Queryable[]> {
    this.ensureValid();

    try {
      return await this.apiClient.expandQuery(query, options);
    } catch (error) {
      console.error("Query expansion failed:", error);
      // Fallback to original query
      return [{ type: "vec", text: query }];
    }
  }

  async rerank(query: string, documents: RerankDocument[], options?: RerankOptions): Promise<RerankResult> {
    this.ensureValid();

    // Map documents to API format
    const apiDocs = documents.map((doc, index) => ({
      file: doc.file,
      text: doc.text,
      index,
    }));

    const result = await this.apiClient.rerank(query, apiDocs);
    return result;
  }

  release() {
    if (this.released) return;
    this.released = true;

    if (this.timeoutId !== undefined) {
      clearTimeout(this.timeoutId);
    }

    this.abortController.abort();
  }
}

// =============================================================================
// Session Factory
// =============================================================================

/**
 * Execute a function with a scoped LLM session
 *
 * @param fn - Function to execute with LLM session
 * @param options - Session options
 * @returns Result of the function
 */
export async function withLLMSession<T>(
  fn: (session: ILLMSession) => Promise<T>,
  options: LLMSessionOptions = {}
): Promise<T> {
  const apiClient = getDefaultApiClient();
  const session = new LLMSession(apiClient, options);

  try {
    return await fn(session);
  } finally {
    session.release();
  }
}

// =============================================================================
// Default API Client (singleton)
// =============================================================================

let defaultApiClient: ApiClient | null = null;

/**
 * Get or create the default API client
 *
 * @returns Default API client instance
 * @throws Error if configuration file not found
 */
export function getDefaultApiClient(): ApiClient {
  if (!defaultApiClient) {
    const config = loadConfig();
    defaultApiClient = new ApiClient(config);
  }
  return defaultApiClient;
}

/**
 * Set the default API client (for testing)
 *
 * @param client - API client instance or null to clear
 */
export function setDefaultApiClient(client: ApiClient | null): void {
  defaultApiClient = client;
}

/**
 * Dispose the default API client
 */
export async function disposeDefaultApiClient(): Promise<void> {
  defaultApiClient = null;
}

// =============================================================================
// Compatibility Layer (for gradual migration)
// =============================================================================

/**
 * Check if LLM can be unloaded (always true for API client)
 *
 * @returns true (API clients don't need unloading)
 */
export function canUnloadLLM(): boolean {
  return true; // API clients are stateless
}

// Legacy type aliases for backward compatibility
export type LlamaCppConfig = never; // Removed
export type LlamaCpp = never; // Removed
export type PullResult = never; // Removed

/**
 * @deprecated Use getDefaultApiClient() instead
 */
export function getDefaultLlamaCpp(): ApiClient {
  console.warn("getDefaultLlamaCpp() is deprecated. Use getDefaultApiClient() instead.");
  return getDefaultApiClient();
}

/**
 * @deprecated No longer needed with API client
 */
export function setDefaultLlamaCpp(_llm: any): void {
  console.warn("setDefaultLlamaCpp() is deprecated. Configuration is managed via ~/.config/qmd/api.yml");
}

/**
 * @deprecated No longer needed with API client
 */
export async function disposeDefaultLlamaCpp(): Promise<void> {
  console.warn("disposeDefaultLlamaCpp() is deprecated. Use disposeDefaultApiClient() instead.");
  await disposeDefaultApiClient();
}

/**
 * @deprecated Model pulling is no longer needed with API client
 */
export async function pullModels(): Promise<never> {
  throw new Error(
    "pullModels() is no longer available. " +
    "Models are managed by the API provider. " +
    "Run 'qmd init' to configure API access."
  );
}

// Export constants for backward compatibility (values no longer used)
export const DEFAULT_EMBED_MODEL_URI = "deprecated";
export const DEFAULT_RERANK_MODEL_URI = "deprecated";
export const DEFAULT_GENERATE_MODEL_URI = "deprecated";
export const DEFAULT_MODEL_CACHE_DIR = "deprecated";
