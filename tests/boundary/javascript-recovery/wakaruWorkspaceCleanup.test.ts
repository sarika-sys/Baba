import { writeFile } from "node:fs/promises";
import type { PathLike, RmOptions } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const fsControl = vi.hoisted(() => ({
  workspaceRoots: [] as string[],
  failRootRemoval: 0,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    mkdtemp: async (prefix: string) => {
      const created = await actual.mkdtemp(prefix);
      fsControl.workspaceRoots.push(created);
      return created;
    },
    rm: async (path: PathLike, options?: RmOptions): Promise<void> => {
      if (
        fsControl.failRootRemoval > 0 &&
        fsControl.workspaceRoots.at(-1) === String(path)
      ) {
        fsControl.failRootRemoval -= 1;
        throw new Error("injected workspace removal failure");
      }
      return actual.rm(path, options);
    },
  };
});

const execution = vi.hoisted(() => ({ failure: undefined as unknown }));

vi.mock(
  "../../../src/javascript/recovery/WakaruCommand.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../src/javascript/recovery/WakaruCommand.js")
      >();
    return {
      ...actual,
      resolveWakaruCommand: async () => ({
        command: "/unused/wakaru",
        limiter: "/unused/prlimit",
        sha256: "a".repeat(64),
        bytes: 1,
      }),
    };
  },
);

vi.mock(
  "../../../src/javascript/recovery/WakaruExecution.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../src/javascript/recovery/WakaruExecution.js")
      >();
    return {
      ...actual,
      prepareWakaruExecution: async () => {
        throw execution.failure;
      },
    };
  },
);

import { AnalysisTimeoutError } from "../../../src/domain/analysisErrorCore.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { WakaruProvider } from "../../../src/javascript/recovery/WakaruProvider.js";

it("reveals the original timeout after a workspace removal retry succeeds", async () => {
  const root = await createTestTempDirectory("rea-wakaru-workspace-");
  const sourcePath = join(root, "source.js");
  const output = join(root, "output");
  await writeFile(sourcePath, "module.exports = 42;");
  execution.failure = new AnalysisTimeoutError(
    "recover_javascript_sources",
    120_000,
  );
  const provider = new WakaruProvider({});
  try {
    fsControl.failRootRemoval = 1;
    const result = await provider.recover({
      path: sourcePath,
      output_directory: output,
      extraction_mode: "structural",
      rewrite_level: "standard",
    });
    if (result.ok) throw new Error("Expected workspace cleanup failure");
    expect(projectAnalysisError(result.error).code).toBe("cleanup_incomplete");
    expect(result.error.cleanupResources).toContain(
      fsControl.workspaceRoots.at(-1),
    );
    // Retrying the workspace removal must reveal the typed timeout, not keep
    // reporting the cleanup wrapper as a generic execution failure.
    await provider.close();
    expect(result.error.cleanupIncomplete).toBe(false);
    expect(projectAnalysisError(result.error).code).toBe("provider_timeout");
  } finally {
    execution.failure = undefined;
    await provider.close().catch(() => undefined);
  }
});
