import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { runValidation } from "../bin/lib/validate.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function captureStream() {
  let output = "";
  return {
    stream: {
      write(chunk) {
        output += String(chunk);
      },
    },
    output() {
      return output;
    },
  };
}

test("validate succeeds in a published package without docs directory", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "qiushi-skill-published-"));
  const packageRoot = path.join(tempRoot, "package");
  const stdout = captureStream();
  const stderr = captureStream();

  try {
    await cp(repoRoot, packageRoot, {
      recursive: true,
      filter(source) {
        const relative = path.relative(repoRoot, source);
        return !relative.startsWith(".git")
          && !relative.startsWith("docs")
          && !relative.includes(`${path.sep}node_modules${path.sep}`)
          && !relative.startsWith("tests");
      },
    });

    const result = await runValidation({
      repoRoot: packageRoot,
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    assert.equal(result.ok, true, stderr.output());
    assert.match(
      await readFile(path.join(packageRoot, "README.md"), "utf8"),
      /https:\/\/github\.com\/HughYau\/qiushi-skill\/blob\/main\/docs\/assets\/tangping_editorial_perspective\.md/
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("validate rejects an inverted host and user instruction hierarchy", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "qiushi-skill-priority-"));
  const packageRoot = path.join(tempRoot, "package");
  const stdout = captureStream();
  const stderr = captureStream();

  try {
    await cp(repoRoot, packageRoot, {
      recursive: true,
      filter(source) {
        const relative = path.relative(repoRoot, source);
        return !relative.startsWith(".git")
          && !relative.includes(`${path.sep}node_modules${path.sep}`)
          && !relative.startsWith("tests");
      },
    });

    const armingPath = path.join(packageRoot, "skills", "arming-thought", "SKILL.md");
    const armingThought = await readFile(armingPath, "utf8");
    await writeFile(
      armingPath,
      armingThought.replace(
        "宿主平台的系统、开发者规则与安全约束 > 用户明确指示与项目约束 > 本方法论",
        "用户明确指示 > 宿主平台的系统规则与安全约束 > 本方法论"
      ),
      "utf8"
    );

    const result = await runValidation({
      repoRoot: packageRoot,
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    assert.equal(result.ok, false);
    assert.match(stderr.output(), /instruction hierarchy/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
