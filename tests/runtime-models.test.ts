import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  loadHighIntensityModelConfig,
  loadNativeReviewModelConfig,
} from "../src/config/runtime-models.ts";

describe("runtime model policy", () => {
  test("loads native review and high-intensity assignments from one config", () => {
    const root = mkdtempSync(join(tmpdir(), "aicoding-mate-model-policy-"));
    const path = join(root, "runtime-models.yaml");
    writeFileSync(path, [
      "version: 1",
      "native_review:",
      "  alias: configured-reviewer",
      "  model: configured-review-model",
      "  family: configured-review-family",
      "high_intensity:",
      "  search:",
      "    alias: configured-search",
      "    model: configured-search-model",
      "    family: configured-search-family",
      "  author:",
      "    alias: configured-author",
      "    model: configured-author-model",
      "    family: configured-author-family",
      "  challenger:",
      "    alias: configured-challenger",
      "    model: configured-challenger-model",
      "    family: configured-challenger-family",
      "  judge:",
      "    alias: configured-judge",
      "    model: configured-judge-model",
      "    family: configured-judge-family",
      "",
    ].join("\n"));
    const env = { ACM_RUNTIME_MODEL_CONFIG: path };

    expect(loadNativeReviewModelConfig(env)).toEqual({
      alias: "configured-reviewer",
      model: "configured-review-model",
      family: "configured-review-family",
    });
    expect(loadHighIntensityModelConfig(env).map((entry) => entry.model)).toEqual([
      "configured-search-model",
      "configured-author-model",
      "configured-challenger-model",
      "configured-judge-model",
    ]);
  });

  test("fails closed when a required model assignment is absent", () => {
    const root = mkdtempSync(join(tmpdir(), "aicoding-mate-model-policy-"));
    const path = join(root, "runtime-models.yaml");
    writeFileSync(path, [
      "version: 1",
      "native_review:",
      "  alias: configured-reviewer",
      "  model: configured-review-model",
      "  family: configured-review-family",
      "high_intensity:",
      "  search:",
      "    alias: configured-search",
      "    model: configured-search-model",
      "    family: configured-search-family",
      "",
    ].join("\n"));

    expect(() =>
      loadHighIntensityModelConfig({ ACM_RUNTIME_MODEL_CONFIG: path })
    ).toThrow("high_intensity_model_role_missing:author");
  });
});
