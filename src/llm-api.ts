/**
 * llm-api.ts - API client for cloud LLM services
 *
 * Provides embeddings, query expansion, and reranking via cloud APIs.
 * Replaces node-llama-cpp with SiliconFlow API.
 */

import { postJSON, type FetchConfig } from "./api-client";
import type { ApiConfig, EmbeddingConfig, RerankConfig } from "./api-config";

// Re-export formatting functions (used by both local and API implementations)
export { formatQueryForEmbedding, formatDocForEmbedding } from "./llm";

// =============================================================================
// Types
// =============================================================================

/**
 * Embedding result
 */
export type EmbeddingResult = {
  embedding: number[];
  model: string;
};

/**
 * Query expansion result
 */
export type QueryExpansion = {
  type: "lex" | "vec" | "hyde";
  text: string;
};

/**
 * Rerank document input
 */
export type RerankDocument = {
  file: string;   // Original file identifier
  text: string;   // Document text to rerank
  index: number;  // Original position
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
 * Query expansion options
 */
export type ExpandQueryOptions = {
  includeLexical?: boolean;  // Include lexical query variations (default: true)
  context?: string;          // Additional context for query expansion
};

// =============================================================================
// Rerank Adapter Interface
// =============================================================================

/**
 * Adapter interface for different rerank API formats
 */
export interface RerankAdapter {
  /**
   * Format request body for the provider's API
   */
  formatRequest(query: string, docs: RerankDocument[]): any;

  /**
   * Parse response from the provider's API
   */
  parseResponse(response: any, originalDocs: RerankDocument[]): RerankDocumentResult[];

  /**
   * Get endpoint URL for the provider
   */
  getEndpoint(baseUrl: string): string;
}

/**
 * SiliconFlow rerank adapter
 */
export class SiliconFlowRerankAdapter implements RerankAdapter {
  constructor(private model: string) {}

  formatRequest(query: string, docs: RerankDocument[]): any {
    return {
      model: this.model,
      query,
      documents: docs.map((doc) => doc.text),
      top_n: docs.length, // Return all docs with scores
    };
  }

  parseResponse(response: any, originalDocs: RerankDocument[]): RerankDocumentResult[] {
    if (!response.results || !Array.isArray(response.results)) {
      throw new Error("Invalid rerank response format: missing results array");
    }

    return response.results.map((result: any) => {
      const index = result.index;
      const originalDoc = originalDocs[index];
      if (!originalDoc) {
        throw new Error(`Invalid rerank result: index ${index} out of bounds`);
      }

      return {
        file: originalDoc.file,
        score: result.relevance_score || result.score || 0,
        index: originalDoc.index,
      };
    });
  }

  getEndpoint(baseUrl: string): string {
    return `${baseUrl}/rerank`;
  }
}

// =============================================================================
// API Client
// =============================================================================

/**
 * LLM API client for cloud services
 */
export class ApiClient {
  private fetchConfig: FetchConfig;
  private rerankAdapter: RerankAdapter;

  constructor(private config: ApiConfig) {
    this.fetchConfig = {
      timeout: config.timeout,
      maxRetries: config.max_retries,
      retryDelay: config.retry_delay,
    };

    // Initialize rerank adapter based on provider
    switch (config.rerank.provider) {
      case "siliconflow":
        this.rerankAdapter = new SiliconFlowRerankAdapter(config.rerank.model);
        break;
      default:
        throw new Error(`Unsupported rerank provider: ${config.rerank.provider}`);
    }
  }

  /**
   * Generate embedding for a single text
   *
   * @param text - Text to embed
   * @returns Embedding vector
   * @throws Error if API fails or dimension mismatch
   */
  async embed(text: string): Promise<EmbeddingResult> {
    const url = `${this.config.embedding.base_url}/embeddings`;

    const response = await postJSON(
      url,
      {
        model: this.config.embedding.model,
        input: text,
      },
      this.config.embedding.api_key,
      this.fetchConfig
    );

    // Extract embedding from response
    if (!response.data || !Array.isArray(response.data) || response.data.length === 0) {
      throw new Error("Invalid embedding response: missing data array");
    }

    const embedding = response.data[0].embedding;
    if (!Array.isArray(embedding)) {
      throw new Error("Invalid embedding response: embedding is not an array");
    }

    // Validate dimensions
    if (embedding.length !== this.config.embedding.dimensions) {
      throw new Error(
        `Embedding dimension mismatch: expected ${this.config.embedding.dimensions}, got ${embedding.length}\n\n` +
        `Update embedding.dimensions in ~/.config/qmd/api.yml or run 'qmd cleanup' to reset vectors.`
      );
    }

    return {
      embedding,
      model: this.config.embedding.model,
    };
  }

  /**
   * Generate embeddings for multiple texts (sequential)
   *
   * @param texts - Array of texts to embed
   * @returns Array of embedding results in same order as input
   */
  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    const results: EmbeddingResult[] = [];

    for (let i = 0; i < texts.length; i++) {
      try {
        const result = await this.embed(texts[i]);
        results.push(result);
      } catch (error) {
        console.error(`Failed to embed text ${i + 1}/${texts.length}:`, error);
        // Continue with other embeddings
      }
    }

    return results;
  }

  /**
   * Rerank documents by relevance to query
   *
   * @param query - Search query
   * @param docs - Documents to rerank
   * @returns Reranked results with scores
   */
  async rerank(query: string, docs: RerankDocument[]): Promise<RerankResult> {
    const url = this.rerankAdapter.getEndpoint(this.config.rerank.base_url);

    const requestBody = this.rerankAdapter.formatRequest(query, docs);

    const response = await postJSON(
      url,
      requestBody,
      this.config.rerank.api_key,
      this.fetchConfig
    );

    const results = this.rerankAdapter.parseResponse(response, docs);

    return {
      results,
      model: this.config.rerank.model,
    };
  }

  /**
   * Expand query into multiple variations using Function Calling
   *
   * @param query - Original search query
   * @param options - Expansion options
   * @returns Array of query variations
   */
  async expandQuery(query: string, options: ExpandQueryOptions = {}): Promise<QueryExpansion[]> {
    const { includeLexical = true, context } = options;

    const url = `${this.config.chat.base_url}/chat/completions`;

    // Define function schema for structured output
    const expandQueryFunction = {
      name: "expand_query",
      description: "Generate variations of a search query for better retrieval",
      parameters: {
        type: "object",
        properties: {
          queries: {
            type: "array",
            description: "Array of query variations with different search strategies",
            items: {
              type: "object",
              properties: {
                type: {
                  type: "string",
                  enum: includeLexical ? ["lex", "vec", "hyde"] : ["vec", "hyde"],
                  description:
                    "Query type: 'lex' for keyword/lexical search, 'vec' for semantic vector search, 'hyde' for hypothetical document",
                },
                text: {
                  type: "string",
                  description: "The query text",
                },
              },
              required: ["type", "text"],
            },
          },
        },
        required: ["queries"],
      },
    };

    // Build messages
    const messages = [
      {
        role: "system",
        content:
          "You are a search query expert. Generate diverse query variations to improve retrieval.",
      },
    ];

    if (context) {
      messages.push({
        role: "user",
        content: `Context: ${context}`,
      });
    }

    messages.push({
      role: "user",
      content: `Generate search query variations for: "${query}"`,
    });

    const response = await postJSON(
      url,
      {
        model: this.config.chat.model,
        messages,
        tools: [{ type: "function", function: expandQueryFunction }],
        tool_choice: "auto",
      },
      this.config.chat.api_key,
      this.fetchConfig
    );

    // Parse function call response
    if (!response.choices || response.choices.length === 0) {
      throw new Error("Invalid chat response: no choices returned");
    }

    const choice = response.choices[0];
    const toolCalls = choice.message?.tool_calls;

    if (!toolCalls || toolCalls.length === 0) {
      throw new Error("Query expansion failed: no function call returned");
    }

    const functionCall = toolCalls[0];
    if (functionCall.function.name !== "expand_query") {
      throw new Error(`Unexpected function call: ${functionCall.function.name}`);
    }

    // Parse arguments
    let args: any;
    try {
      args = JSON.parse(functionCall.function.arguments);
    } catch (error) {
      throw new Error(`Failed to parse function arguments: ${error}`);
    }

    if (!args.queries || !Array.isArray(args.queries)) {
      throw new Error("Invalid function response: missing queries array");
    }

    return args.queries;
  }
}

// =============================================================================
// Note: formatQueryForEmbedding and formatDocForEmbedding are re-exported
// from ./llm at the top of this file (line 12)
// =============================================================================
