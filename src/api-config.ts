/**
 * api-config.ts - API configuration loader and validator
 *
 * Loads and validates configuration from ~/.config/qmd/api.yml
 */

import { parse as parseYAML } from "yaml";
import { z } from "zod";
import { homedir } from "os";
import { join } from "path";
import { existsSync, readFileSync } from "fs";

// =============================================================================
// Zod Schema
// =============================================================================

/**
 * Schema for service configuration (embedding, chat, rerank)
 */
const ServiceConfigSchema = z.object({
  base_url: z.string().url("base_url must be a valid URL"),
  api_key: z
    .string()
    .min(1, "api_key cannot be empty")
    .refine(
      (val) => !val.includes("YOUR_API_KEY_HERE"),
      "api_key cannot be empty"
    ),
  model: z.string().min(1, "model cannot be empty"),
});

/**
 * Schema for embedding configuration (includes dimensions)
 */
const EmbeddingConfigSchema = ServiceConfigSchema.extend({
  dimensions: z.number().int().positive("dimensions must be a positive integer"),
});

/**
 * Schema for rerank configuration (includes provider)
 */
const RerankConfigSchema = ServiceConfigSchema.extend({
  provider: z
    .string()
    .refine((val) => val === "siliconflow", {
      message: "provider must be 'siliconflow'",
    }),
});

/**
 * Full API configuration schema
 */
const ApiConfigSchema = z.object({
  embedding: EmbeddingConfigSchema,
  chat: ServiceConfigSchema,
  rerank: RerankConfigSchema,
  timeout: z.number().positive("timeout must be positive").default(60),
  max_retries: z.number().int().min(0, "max_retries cannot be negative").default(3),
  retry_delay: z.number().positive("retry_delay must be positive").default(1),
});

// =============================================================================
// TypeScript Types
// =============================================================================

/**
 * Service configuration (base)
 */
export type ServiceConfig = z.infer<typeof ServiceConfigSchema>;

/**
 * Embedding configuration
 */
export type EmbeddingConfig = z.infer<typeof EmbeddingConfigSchema>;

/**
 * Rerank configuration
 */
export type RerankConfig = z.infer<typeof RerankConfigSchema>;

/**
 * Complete API configuration
 */
export type ApiConfig = z.infer<typeof ApiConfigSchema>;

// =============================================================================
// Configuration Loading
// =============================================================================

/**
 * Get default configuration file path
 */
export function getConfigPath(): string {
  return join(homedir(), ".config", "qmd", "api.yml");
}

/**
 * Load and validate API configuration from file
 *
 * @param configPath - Path to config file (defaults to ~/.config/qmd/api.yml)
 * @returns Validated configuration object
 * @throws Error if config file not found or validation fails
 */
export function loadConfig(configPath?: string): ApiConfig {
  const path = configPath || getConfigPath();

  // Check if config file exists
  if (!existsSync(path)) {
    throw new Error(
      `Configuration file not found: ${path}\n\n` +
      `Run 'qmd init' to create a configuration template.`
    );
  }

  // Read and parse YAML
  let rawConfig: any;
  try {
    const content = readFileSync(path, "utf-8");
    rawConfig = parseYAML(content);
  } catch (error) {
    throw new Error(
      `Failed to parse configuration file: ${path}\n` +
      `${error instanceof Error ? error.message : String(error)}`
    );
  }

  // Validate with Zod
  try {
    return ApiConfigSchema.parse(rawConfig);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issues = error.issues.map((issue) => {
        const path = issue.path.join(".");
        return `  - ${path}: ${issue.message}`;
      });
      throw new Error(
        `Configuration validation failed:\n${issues.join("\n")}\n\n` +
        `Edit ${path} to fix these issues.`
      );
    }
    throw error;
  }
}

/**
 * Configuration template with placeholders and comments
 */
export const CONFIG_TEMPLATE = `# QMD API Configuration
# 
# This file configures cloud API access for embeddings, chat, and reranking.
# Get your SiliconFlow API key at: https://cloud.siliconflow.cn/

# Embedding service configuration
embedding:
  base_url: https://api.siliconflow.cn/v1
  api_key: sk-YOUR_API_KEY_HERE
  model: Qwen/Qwen3-Embedding-0.6B
  dimensions: 1024  # Must match the model's output dimensions

# Chat service configuration (for query expansion)
chat:
  base_url: https://api.siliconflow.cn/v1
  api_key: sk-YOUR_API_KEY_HERE
  model: Pro/deepseek-ai/DeepSeek-V3.2

# Rerank service configuration
rerank:
  base_url: https://api.siliconflow.cn/v1
  api_key: sk-YOUR_API_KEY_HERE
  model: Qwen/Qwen3-Reranker-0.6B
  provider: siliconflow

# HTTP client settings
timeout: 60        # Request timeout in seconds
max_retries: 3     # Maximum retry attempts for failed requests
retry_delay: 1     # Initial retry delay in seconds (exponential backoff)
`;
