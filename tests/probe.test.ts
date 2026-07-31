import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { probeFirstmate, probeTool, runDoctor } from "../src/probe.ts";

describe("runtime probe", () => {
  test("reports missing tools with an executable next step", () => {
    const report = runDoctor({ cwd: process.cwd(), env: { PATH: "" } });
    const git = report.tools.find((tool) => tool.id === "git");

    expect(git?.status).toBe("missing");
    expect(git?.nextStep).toContain("git");
    expect(report.summary.ready).toBe(false);
  });

  test("uses runtime output instead of hard-coded success", () => {
    const dir = mkdtempSync(join(tmpdir(), "acm-probe-"));
    try {
      const fakeGit = join(dir, "git");
      writeFileSync(fakeGit, "#!/bin/sh\necho 'git version 9.9.9-test'\n");
      chmodSync(fakeGit, 0o755);

      const probe = probeTool("git", { cwd: process.cwd(), env: { PATH: dir } });

      expect(probe.status).toBe("ok");
      expect(probe.version).toBe("git version 9.9.9-test");
      expect(probe.path).toBe(fakeGit);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("firstmate is treated as a pinned distro, not a CLI", () => {
    const dir = mkdtempSync(join(tmpdir(), "acm-firstmate-cli-"));
    try {
      const fakeFirstmate = join(dir, "firstmate");
      writeFileSync(fakeFirstmate, "#!/bin/sh\necho 'this should not be used'\n");
      chmodSync(fakeFirstmate, 0o755);

      const probe = probeFirstmate({ cwd: dir, env: { PATH: dir } });

      expect(probe.status).toBe("missing");
      expect(probe.command).toContain("FIRSTMATE_ROOT");
      expect(probe.command).not.toContain("firstmate --version");
      expect(probe.detail).toBe("尚未 bootstrap: kunchenguid/firstmate@e595611291247368b982eb729097c54f2b45aa78");
      expect(probe.ref).toBe("e595611291247368b982eb729097c54f2b45aa78");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("finds the canonical bootstrap-firstmate install without environment overrides", () => {
    const dir = mkdtempSync(join(tmpdir(), "acm-firstmate-bootstrap-"));
    try {
      const binDir = join(dir, "bin");
      const firstmateRoot = join(dir, "state", "upstream", "firstmate");
      mkdirSync(binDir, { recursive: true });
      mkdirSync(firstmateRoot, { recursive: true });
      const fakeGit = join(binDir, "git");
      writeFileSync(
        fakeGit,
        "#!/bin/sh\necho 'e595611291247368b982eb729097c54f2b45aa78'\n",
      );
      chmodSync(fakeGit, 0o755);

      const probe = probeFirstmate({ cwd: dir, env: { PATH: binDir } });

      expect(probe.status).toBe("ok");
      expect(probe.root).toBe(firstmateRoot);
      expect(probe.currentRef).toBe("e595611291247368b982eb729097c54f2b45aa78");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
