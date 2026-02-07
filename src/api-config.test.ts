/**
 * api-config.test.ts - Tests for API configuration loader
 */

import { describe, test, expect } from "bun:test";
import { loadConfig, getConfigPath, CONFIG_TEMPLATE, type ApiConfig } from "./api-config";
import { join } from "path";
import { mkdirSync, writeFileSync, unlinkSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";

describe("api-config", () => {
  // Helper to create temporary config file
  function createTempConfig(content: string): string {
    const tempDir = join(tmpdir(), "qmd-test-" + Math.random().toString(36).slice(2));
    mkdirSync(tempDir, { recursive: true });
    const configPath = join(tempDir, "api.yml");
    writeFileSync(configPath, content, "utf-8");
    return configPath;
  }

  // Helper to cleanup temp files
  function cleanupTempConfig(configPath: string) {
    const dir = join(configPath, "..");
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  describe("getConfigPath", () => {
    test("returns correct default path", () => {
      const path = getConfigPath();
      expect(path).toContain(".config/qmd/api.yml");
    });
  });

  describe("loadConfig", () => {
    test("loads valid configuration", () => {
      const validConfig = `
embedding:
  base_url: https://api.siliconflow.cn/v1
  api_key: sk-test123
  model: Qwen/Qwen3-Embedding-0.6B
  dimensions: 1024

chat:
  base_url: https://api.siliconflow.cn/v1
  api_key: sk-test123
  model: Pro/deepseek-ai/DeepSeek-V3.2

rerank:
  base_url: https://api.siliconflow.cn/v1
  api_key: sk-test123
  model: Qwen/Qwen3-Reranker-0.6B
  provider: siliconflow

timeout: 30
max_retries: 3
retry_delay: 1
`;

      const configPath = createTempConfig(validConfig);
      try {
        const config = loadConfig(configPath);
        
        expect(config.embedding.base_url).toBe("https://api.siliconflow.cn/v1");
        expect(config.embedding.api_key).toBe("sk-test123");
        expect(config.embedding.model).toBe("Qwen/Qwen3-Embedding-0.6B");
        expect(config.embedding.dimensions).toBe(1024);
        
        expect(config.chat.base_url).toBe("https://api.siliconflow.cn/v1");
        expect(config.chat.api_key).toBe("sk-test123");
        expect(config.chat.model).toBe("Pro/deepseek-ai/DeepSeek-V3.2");
        
        expect(config.rerank.base_url).toBe("https://api.siliconflow.cn/v1");
        expect(config.rerank.api_key).toBe("sk-test123");
        expect(config.rerank.model).toBe("Qwen/Qwen3-Reranker-0.6B");
        expect(config.rerank.provider).toBe("siliconflow");
        
        expect(config.timeout).toBe(30);
        expect(config.max_retries).toBe(3);
        expect(config.retry_delay).toBe(1);
      } finally {
        cleanupTempConfig(configPath);
      }
    });

    test("applies default values for optional fields", () => {
      const minimalConfig = `
embedding:
  base_url: https://api.siliconflow.cn/v1
  api_key: sk-test123
  model: Qwen/Qwen3-Embedding-0.6B
  dimensions: 1024

chat:
  base_url: https://api.siliconflow.cn/v1
  api_key: sk-test123
  model: Pro/deepseek-ai/DeepSeek-V3.2

rerank:
  base_url: https://api.siliconflow.cn/v1
  api_key: sk-test123
  model: Qwen/Qwen3-Reranker-0.6B
  provider: siliconflow
`;

      const configPath = createTempConfig(minimalConfig);
      try {
        const config = loadConfig(configPath);

        expect(config.timeout).toBe(60);
        expect(config.max_retries).toBe(3);
        expect(config.retry_delay).toBe(1);
      } finally {
        cleanupTempConfig(configPath);
      }
    });

    test("throws error when config file not found", () => {
      const nonexistentPath = "/nonexistent/path/api.yml";
      
      expect(() => loadConfig(nonexistentPath)).toThrow(/Configuration file not found/);
      expect(() => loadConfig(nonexistentPath)).toThrow(/qmd init/);
    });

    test("throws error for invalid YAML syntax", () => {
      const invalidYAML = `
embedding:
  base_url: https://api.siliconflow.cn/v1
  api_key: sk-test123
  invalid: [unclosed array
`;

      const configPath = createTempConfig(invalidYAML);
      try {
        expect(() => loadConfig(configPath)).toThrow(/Failed to parse configuration file/);
      } finally {
        cleanupTempConfig(configPath);
      }
    });

    test("throws error when required field missing", () => {
      const missingField = `
embedding:
  base_url: https://api.siliconflow.cn/v1
  # api_key is missing
  model: Qwen/Qwen3-Embedding-0.6B
  dimensions: 1024

chat:
  base_url: https://api.siliconflow.cn/v1
  api_key: sk-test123
  model: Pro/deepseek-ai/DeepSeek-V3.2

rerank:
  base_url: https://api.siliconflow.cn/v1
  api_key: sk-test123
  model: Qwen/Qwen3-Reranker-0.6B
  provider: siliconflow
`;

      const configPath = createTempConfig(missingField);
      try {
        expect(() => loadConfig(configPath)).toThrow(/Configuration validation failed/);
        expect(() => loadConfig(configPath)).toThrow(/embedding.api_key/);
      } finally {
        cleanupTempConfig(configPath);
      }
    });

    test("throws error for invalid field type", () => {
      const invalidType = `
embedding:
  base_url: https://api.siliconflow.cn/v1
  api_key: sk-test123
  model: Qwen/Qwen3-Embedding-0.6B
  dimensions: "1024"  # Should be number, not string

chat:
  base_url: https://api.siliconflow.cn/v1
  api_key: sk-test123
  model: Pro/deepseek-ai/DeepSeek-V3.2

rerank:
  base_url: https://api.siliconflow.cn/v1
  api_key: sk-test123
  model: Qwen/Qwen3-Reranker-0.6B
  provider: siliconflow
`;

      const configPath = createTempConfig(invalidType);
      try {
        expect(() => loadConfig(configPath)).toThrow(/Configuration validation failed/);
        expect(() => loadConfig(configPath)).toThrow(/embedding.dimensions/);
      } finally {
        cleanupTempConfig(configPath);
      }
    });

    test("throws error for invalid base_url", () => {
      const invalidURL = `
embedding:
  base_url: not-a-valid-url
  api_key: sk-test123
  model: Qwen/Qwen3-Embedding-0.6B
  dimensions: 1024

chat:
  base_url: https://api.siliconflow.cn/v1
  api_key: sk-test123
  model: Pro/deepseek-ai/DeepSeek-V3.2

rerank:
  base_url: https://api.siliconflow.cn/v1
  api_key: sk-test123
  model: Qwen/Qwen3-Reranker-0.6B
  provider: siliconflow
`;

      const configPath = createTempConfig(invalidURL);
      try {
        expect(() => loadConfig(configPath)).toThrow(/Configuration validation failed/);
        expect(() => loadConfig(configPath)).toThrow(/base_url must be a valid URL/);
      } finally {
        cleanupTempConfig(configPath);
      }
    });

    test("throws error for invalid provider", () => {
      const invalidProvider = `
embedding:
  base_url: https://api.siliconflow.cn/v1
  api_key: sk-test123
  model: Qwen/Qwen3-Embedding-0.6B
  dimensions: 1024

chat:
  base_url: https://api.siliconflow.cn/v1
  api_key: sk-test123
  model: Pro/deepseek-ai/DeepSeek-V3.2

rerank:
  base_url: https://api.siliconflow.cn/v1
  api_key: sk-test123
  model: Qwen/Qwen3-Reranker-0.6B
  provider: openai  # Invalid provider
`;

      const configPath = createTempConfig(invalidProvider);
      try {
        expect(() => loadConfig(configPath)).toThrow(/Configuration validation failed/);
        expect(() => loadConfig(configPath)).toThrow(/provider must be 'siliconflow'/);
      } finally {
        cleanupTempConfig(configPath);
      }
    });

    test("throws error for negative dimensions", () => {
      const negativeDimensions = `
embedding:
  base_url: https://api.siliconflow.cn/v1
  api_key: sk-test123
  model: Qwen/Qwen3-Embedding-0.6B
  dimensions: -1024  # Negative dimensions

chat:
  base_url: https://api.siliconflow.cn/v1
  api_key: sk-test123
  model: Pro/deepseek-ai/DeepSeek-V3.2

rerank:
  base_url: https://api.siliconflow.cn/v1
  api_key: sk-test123
  model: Qwen/Qwen3-Reranker-0.6B
  provider: siliconflow
`;

      const configPath = createTempConfig(negativeDimensions);
      try {
        expect(() => loadConfig(configPath)).toThrow(/Configuration validation failed/);
        expect(() => loadConfig(configPath)).toThrow(/dimensions must be a positive integer/);
      } finally {
        cleanupTempConfig(configPath);
      }
    });
  });

  describe("CONFIG_TEMPLATE", () => {
    test("template is valid YAML", () => {
      const configPath = createTempConfig(CONFIG_TEMPLATE);
      try {
        // Should not throw - template structure is valid
        // (will fail validation because of placeholder values, which is expected)
        expect(() => loadConfig(configPath)).toThrow(/api_key cannot be empty/);
      } finally {
        cleanupTempConfig(configPath);
      }
    });

    test("template includes all required sections", () => {
      expect(CONFIG_TEMPLATE).toContain("embedding:");
      expect(CONFIG_TEMPLATE).toContain("chat:");
      expect(CONFIG_TEMPLATE).toContain("rerank:");
      expect(CONFIG_TEMPLATE).toContain("base_url:");
      expect(CONFIG_TEMPLATE).toContain("api_key:");
      expect(CONFIG_TEMPLATE).toContain("model:");
      expect(CONFIG_TEMPLATE).toContain("dimensions:");
      expect(CONFIG_TEMPLATE).toContain("provider:");
      expect(CONFIG_TEMPLATE).toContain("timeout:");
      expect(CONFIG_TEMPLATE).toContain("max_retries:");
      expect(CONFIG_TEMPLATE).toContain("retry_delay:");
    });

    test("template includes documentation comments", () => {
      expect(CONFIG_TEMPLATE).toContain("#");
      expect(CONFIG_TEMPLATE).toContain("SiliconFlow");
    });
  });
});
