/**
 * qmd.test.ts - Tests for qmd CLI entry point
 */

import { describe, test, expect } from "bun:test";

describe("qmd CLI cleanup", () => {
  test("qmd.ts should import disposeDefaultApiClient from llm.js", async () => {
    // Verify that qmd.ts properly imports the cleanup function for API client
    const qmdSource = await Bun.file("src/qmd.ts").text();
    
    // Check that disposeDefaultApiClient is imported (not the deprecated disposeDefaultLlamaCpp)
    const hasImport = /import\s+{[^}]*disposeDefaultApiClient[^}]*}\s+from\s+["']\.\/llm\.js["']/.test(qmdSource);
    
    expect(hasImport).toBe(true);
  });
  
  test("disposeDefaultApiClient function exists in llm.js", async () => {
    // Verify the function exists and is callable
    const { disposeDefaultApiClient } = await import("./llm.js");
    
    expect(typeof disposeDefaultApiClient).toBe("function");
    
    // Should not throw when called
    await expect(disposeDefaultApiClient()).resolves.toBeUndefined();
  });
  
  test("deprecated disposeDefaultLlamaCpp still exists for backward compatibility", async () => {
    // Verify the deprecated function exists but warns users
    const { disposeDefaultLlamaCpp } = await import("./llm.js");
    
    expect(typeof disposeDefaultLlamaCpp).toBe("function");
    
    // Should work but is deprecated
    await expect(disposeDefaultLlamaCpp()).resolves.toBeUndefined();
  });
});
