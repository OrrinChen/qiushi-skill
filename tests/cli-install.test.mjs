import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  chmod,
  cp,
  link,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { installTarget, installTargets, uninstallTarget } from "../bin/lib/install.mjs";
import { normalizeTargets } from "../bin/lib/detect-platform.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);

async function withTempHome(fn) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "qiushi-skill-test-"));
  const homeDir = path.join(tempRoot, "home");
  const cwd = path.join(tempRoot, "project");

  try {
    await fn({ tempRoot, homeDir, cwd });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function readInstalled(relativePath, context) {
  return readFile(path.join(context.homeDir, relativePath), "utf8");
}

test("codex installs skills directly into the Codex skills directory", async () => {
  await withTempHome(async (context) => {
    const result = await installTarget("codex", {
      packageRoot: repoRoot,
      homeDir: context.homeDir,
      cwd: context.cwd,
    });

    assert.equal(result.kind, "copied");
    assert.equal(result.targetRoot, path.join(context.homeDir, ".codex", "skills"));
    assert.match(
      await readInstalled(path.join(".codex", "skills", "arming-thought", "SKILL.md"), context),
      /name:\s*arming-thought/
    );
  });
});

test("opencode installs both skills and slash command files", async () => {
  await withTempHome(async (context) => {
    const result = await installTarget("opencode", {
      packageRoot: repoRoot,
      homeDir: context.homeDir,
      cwd: context.cwd,
    });

    assert.equal(result.kind, "copied");
    assert.deepEqual(result.targetRoots, [
      path.join(context.homeDir, ".config", "opencode", "skills"),
      path.join(context.homeDir, ".config", "opencode", "commands"),
    ]);
    assert.match(
      await readInstalled(path.join(".config", "opencode", "skills", "arming-thought", "SKILL.md"), context),
      /name:\s*arming-thought/
    );
    assert.match(
      await readInstalled(path.join(".config", "opencode", "commands", "contradiction-analysis.md"), context),
      /name:\s*contradiction-analysis/
    );
  });
});

test("all targets include nanobot and install into its workspace skills directory", async () => {
  await withTempHome(async (context) => {
    assert.ok(normalizeTargets(["all"], context).includes("nanobot"));

    const result = await installTarget("nanobot", {
      packageRoot: repoRoot,
      homeDir: context.homeDir,
      cwd: context.cwd,
    });

    assert.equal(result.kind, "copied");
    assert.equal(result.targetRoot, path.join(context.homeDir, ".nanobot", "workspace", "skills"));
    assert.match(
      await readInstalled(path.join(".nanobot", "workspace", "skills", "arming-thought", "SKILL.md"), context),
      /name:\s*arming-thought/
    );
  });
});

test("uninstall removes managed skill-directory installs without deleting the root", async () => {
  await withTempHome(async (context) => {
    await installTarget("codex", {
      packageRoot: repoRoot,
      homeDir: context.homeDir,
      cwd: context.cwd,
    });

    const result = await uninstallTarget("codex", {
      homeDir: context.homeDir,
      cwd: context.cwd,
    });

    assert.equal(result.kind, "removed");
    await assert.rejects(
      readInstalled(path.join(".codex", "skills", "arming-thought", "SKILL.md"), context),
      { code: "ENOENT" }
    );
  });
});

test("codex adopts a CRLF-normalized legacy install and keeps a byte-exact backup", async () => {
  await withTempHome(async (context) => {
    const skillRoot = path.join(context.homeDir, ".codex", "skills");
    const legacySkill = path.join(repoRoot, "tests", "fixtures", "legacy-1.3.1", "arming-thought");
    const installedLegacySkill = path.join(skillRoot, "arming-thought");
    await mkdir(skillRoot, { recursive: true });
    await cp(legacySkill, installedLegacySkill, { recursive: true });
    const crlfLegacy = (await readFile(path.join(installedLegacySkill, "SKILL.md"), "utf8"))
      .replace(/\r?\n/g, "\r\n");
    await writeFile(path.join(installedLegacySkill, "SKILL.md"), crlfLegacy, "utf8");

    const result = await installTarget("codex", {
      packageRoot: repoRoot,
      homeDir: context.homeDir,
      cwd: context.cwd,
      adoptLegacy: true,
    });

    assert.equal(result.backupRoots.length, 1);
    assert.equal(
      await readFile(path.join(result.backupRoots[0], "arming-thought", "SKILL.md"), "utf8"),
      crlfLegacy
    );
    assert.match(
      await readInstalled(path.join(".codex", "skills", "arming-thought", "SKILL.md"), context),
      /宿主平台的系统、开发者规则与安全约束 > 用户明确指示与项目约束/
    );

    const manifest = JSON.parse(await readInstalled(path.join(".codex", "skills", ".qiushi-skill-install.json"), context));
    assert.equal(manifest.packageName, "qiushi-skill");
    assert.ok(manifest.entries.some((entry) => entry.path === "arming-thought"));
  });
});

test("legacy adoption rejects modified skills before copying anything", async () => {
  await withTempHome(async (context) => {
    const skillRoot = path.join(context.homeDir, ".codex", "skills");
    const modifiedSkill = path.join(skillRoot, "mass-line");
    await mkdir(modifiedSkill, { recursive: true });
    await writeFile(
      path.join(modifiedSkill, "SKILL.md"),
      "---\nname: mass-line\ndescription: |\n  locally modified\n---\n",
      "utf8"
    );

    await assert.rejects(
      installTarget("codex", {
        packageRoot: repoRoot,
        homeDir: context.homeDir,
        cwd: context.cwd,
        adoptLegacy: true,
      }),
      /Refusing to adopt modified or unsupported legacy skill 'mass-line'/
    );

    await assert.rejects(
      readInstalled(path.join(".codex", "skills", "arming-thought", "SKILL.md"), context),
      { code: "ENOENT" }
    );
    assert.match(await readFile(path.join(modifiedSkill, "SKILL.md"), "utf8"), /locally modified/);
  });
});

test("upgrades remove entries owned by the previous manifest", async () => {
  await withTempHome(async (context) => {
    const skillRoot = path.join(context.homeDir, ".codex", "skills");
    await installTarget("codex", {
      packageRoot: repoRoot,
      homeDir: context.homeDir,
      cwd: context.cwd,
    });

    const reducedPackage = path.join(context.tempRoot, "reduced-package");
    await cp(repoRoot, reducedPackage, {
      recursive: true,
      filter(source) {
        const relative = path.relative(repoRoot, source);
        return !relative.startsWith(".git") && !relative.includes(`${path.sep}node_modules${path.sep}`);
      },
    });
    await rm(path.join(reducedPackage, "skills", "mass-line"), { recursive: true });

    await installTarget("codex", {
      packageRoot: reducedPackage,
      homeDir: context.homeDir,
      cwd: context.cwd,
    });

    await assert.rejects(stat(path.join(skillRoot, "mass-line")), { code: "ENOENT" });
  });
});

test("invalid manifests are rejected before install or uninstall mutates managed paths", async () => {
  const cases = [
    [null],
    [{ path: "arming-thought", type: "file", source: "skills" }],
    [{ path: "arming-thought", type: "directory", source: "other" }],
    [{ path: "personal-notes", type: "directory", source: "skills" }],
    [
      { path: "arming-thought", type: "directory", source: "skills" },
      { path: "arming-thought", type: "directory", source: "skills" },
    ],
    [
      { path: "arming-thought", type: "directory", source: "skills" },
      { path: "../outside", type: "directory", source: "skills" },
    ],
  ];

  for (const entries of cases) {
    await withTempHome(async (context) => {
      const skillRoot = path.join(context.homeDir, ".codex", "skills");
      const installedSkill = path.join(skillRoot, "arming-thought");
      await mkdir(installedSkill, { recursive: true });
      await writeFile(path.join(installedSkill, "SKILL.md"), "keep-me\n", "utf8");
      const manifestText = `${JSON.stringify({
        packageName: "qiushi-skill",
        version: 1,
        entries,
      }, null, 2)}\n`;
      await writeFile(path.join(skillRoot, ".qiushi-skill-install.json"), manifestText, "utf8");

      await assert.rejects(installTarget("codex", {
        packageRoot: repoRoot,
        homeDir: context.homeDir,
        cwd: context.cwd,
      }));
      assert.equal(await readFile(path.join(installedSkill, "SKILL.md"), "utf8"), "keep-me\n");
      assert.equal(await readFile(path.join(skillRoot, ".qiushi-skill-install.json"), "utf8"), manifestText);

      await assert.rejects(uninstallTarget("codex", {
        homeDir: context.homeDir,
        cwd: context.cwd,
      }));
      assert.equal(await readFile(path.join(installedSkill, "SKILL.md"), "utf8"), "keep-me\n");
    });
  }
});

test("manifest symlinks and dangling skill symlinks are rejected without following them", {
  skip: process.platform === "win32",
}, async () => {
  await withTempHome(async (context) => {
    const skillRoot = path.join(context.homeDir, ".codex", "skills");
    const externalManifest = path.join(context.tempRoot, "external-manifest.json");
    const manifestPath = path.join(skillRoot, ".qiushi-skill-install.json");
    const danglingSkill = path.join(skillRoot, "arming-thought");
    const original = `${JSON.stringify({ packageName: "qiushi-skill", version: 1, entries: [], sentinel: true })}\n`;
    await mkdir(skillRoot, { recursive: true });
    await writeFile(externalManifest, original, "utf8");
    await symlink(externalManifest, manifestPath);

    await assert.rejects(installTarget("codex", {
      packageRoot: repoRoot,
      homeDir: context.homeDir,
      cwd: context.cwd,
    }), /regular, non-symlink file/);
    assert.equal(await readFile(externalManifest, "utf8"), original);
    assert.ok((await lstat(manifestPath)).isSymbolicLink());

    await rm(manifestPath);
    await symlink(path.join(context.tempRoot, "missing-skill"), danglingSkill);
    await assert.rejects(installTarget("codex", {
      packageRoot: repoRoot,
      homeDir: context.homeDir,
      cwd: context.cwd,
    }), /unmanaged paths/);
    assert.ok((await lstat(danglingSkill)).isSymbolicLink());
  });
});

test("atomic manifest replacement does not rewrite an external hard link", async () => {
  await withTempHome(async (context) => {
    const skillRoot = path.join(context.homeDir, ".codex", "skills");
    const externalManifest = path.join(context.tempRoot, "external-manifest.json");
    const manifestPath = path.join(skillRoot, ".qiushi-skill-install.json");
    const original = `${JSON.stringify({ packageName: "qiushi-skill", version: 1, entries: [], sentinel: true })}\n`;
    await mkdir(skillRoot, { recursive: true });
    await writeFile(externalManifest, original, "utf8");
    await link(externalManifest, manifestPath);

    await installTarget("codex", {
      packageRoot: repoRoot,
      homeDir: context.homeDir,
      cwd: context.cwd,
    });

    assert.equal(await readFile(externalManifest, "utf8"), original);
    const installedManifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(installedManifest.entries.length, 11);
  });
});

test("a read-only manifest can be replaced without a partial install", {
  skip: process.platform === "win32",
}, async () => {
  await withTempHome(async (context) => {
    const options = {
      packageRoot: repoRoot,
      homeDir: context.homeDir,
      cwd: context.cwd,
    };
    await installTarget("codex", options);
    const manifestPath = path.join(context.homeDir, ".codex", "skills", ".qiushi-skill-install.json");
    await chmod(manifestPath, 0o444);

    const result = await installTarget("codex", options);
    assert.equal(result.kind, "copied");
    assert.equal(JSON.parse(await readFile(manifestPath, "utf8")).entries.length, 11);
  });
});

test("OpenCode preflights command conflicts before creating its skills tree", async () => {
  await withTempHome(async (context) => {
    const commandRoot = path.join(context.cwd, ".opencode", "commands");
    const commandPath = path.join(commandRoot, "mass-line.md");
    await mkdir(commandRoot, { recursive: true });
    await writeFile(commandPath, "user-command\n", "utf8");

    await assert.rejects(installTarget("opencode", {
      packageRoot: repoRoot,
      homeDir: context.homeDir,
      cwd: context.cwd,
      scope: "project",
    }), /unmanaged paths/);

    assert.equal(await readFile(commandPath, "utf8"), "user-command\n");
    await assert.rejects(stat(path.join(context.cwd, ".opencode", "skills")), { code: "ENOENT" });
  });
});

test("OpenCode rejects physically overlapping roots reached through directory symlinks", {
  skip: process.platform === "win32",
}, async () => {
  await withTempHome(async (context) => {
    const openCodeRoot = path.join(context.cwd, ".opencode");
    const sharedRoot = path.join(context.tempRoot, "shared");
    const nestedRoot = path.join(sharedRoot, "nested");
    await mkdir(openCodeRoot, { recursive: true });
    await mkdir(nestedRoot, { recursive: true });
    await symlink(nestedRoot, path.join(openCodeRoot, "skills"));
    await symlink(sharedRoot, path.join(openCodeRoot, "commands"));

    await assert.rejects(installTarget("opencode", {
      packageRoot: repoRoot,
      homeDir: context.homeDir,
      cwd: context.cwd,
      scope: "project",
    }), /overlapping physical install roots/);

    assert.deepEqual(await readdir(sharedRoot), ["nested"]);
  });
});

test("multi-target legacy options are rejected before the first target is written", async () => {
  await withTempHome(async (context) => {
    await assert.rejects(installTargets(["codex", "opencode"], {
      packageRoot: repoRoot,
      homeDir: context.homeDir,
      cwd: context.cwd,
      adoptLegacy: true,
    }), /skills-only targets/);
    await assert.rejects(stat(path.join(context.homeDir, ".codex", "skills")), { code: "ENOENT" });
  });
});

test("a missing late bundle asset leaves both bundle and earlier targets unchanged", async () => {
  await withTempHome(async (context) => {
    const packageRoot = path.join(context.tempRoot, "incomplete-package");
    const bundleRoot = path.join(context.homeDir, ".claude", "plugins", "qiushi-skill");
    const existingSkill = path.join(bundleRoot, "skills", "existing", "SKILL.md");
    const existingMetadata = path.join(bundleRoot, ".claude-plugin", "sentinel.txt");
    await cp(repoRoot, packageRoot, {
      recursive: true,
      filter(source) {
        const relative = path.relative(repoRoot, source);
        return !relative.startsWith(".git") && !relative.includes(`${path.sep}node_modules${path.sep}`);
      },
    });
    await rm(path.join(packageRoot, ".claude-plugin"), { recursive: true, force: true });
    await mkdir(path.dirname(existingSkill), { recursive: true });
    await mkdir(path.dirname(existingMetadata), { recursive: true });
    await writeFile(existingSkill, "keep-skill\n", "utf8");
    await writeFile(existingMetadata, "keep-metadata\n", "utf8");

    await assert.rejects(installTargets(["codex", "claude-code"], {
      packageRoot,
      homeDir: context.homeDir,
      cwd: context.cwd,
    }), /Missing or unsafe bundle asset/);

    assert.equal(await readFile(existingSkill, "utf8"), "keep-skill\n");
    assert.equal(await readFile(existingMetadata, "utf8"), "keep-metadata\n");
    await assert.rejects(
      stat(path.join(context.homeDir, ".codex", "skills")),
      { code: "ENOENT" }
    );
  });
});

test("bundle install and uninstall refuse a symlinked package root", {
  skip: process.platform === "win32",
}, async () => {
  await withTempHome(async (context) => {
    const bundleParent = path.join(context.cwd, ".claude", "plugins");
    const bundleLink = path.join(bundleParent, "qiushi-skill");
    const externalBundle = path.join(context.tempRoot, "external-bundle");
    const sentinel = path.join(externalBundle, "sentinel.txt");
    await mkdir(bundleParent, { recursive: true });
    await mkdir(externalBundle, { recursive: true });
    await writeFile(sentinel, "keep-external\n", "utf8");
    await symlink(externalBundle, bundleLink);

    await assert.rejects(installTarget("claude-code", {
      packageRoot: repoRoot,
      homeDir: context.homeDir,
      cwd: context.cwd,
      scope: "project",
    }), /symlinked target/);
    await assert.rejects(uninstallTarget("claude-code", {
      homeDir: context.homeDir,
      cwd: context.cwd,
      scope: "project",
    }), /symlinked target/);

    assert.ok((await lstat(bundleLink)).isSymbolicLink());
    assert.equal(await readFile(sentinel, "utf8"), "keep-external\n");
    assert.deepEqual(await readdir(externalBundle), ["sentinel.txt"]);
  });
});

test("bundle installs restore executable permissions from normalized package modes", {
  skip: process.platform === "win32",
}, async () => {
  await withTempHome(async (context) => {
    const packageRoot = path.join(context.tempRoot, "package");
    await cp(repoRoot, packageRoot, {
      recursive: true,
      filter(source) {
        const relative = path.relative(repoRoot, source);
        return !relative.startsWith(".git") && !relative.includes(`${path.sep}node_modules${path.sep}`);
      },
    });
    await chmod(path.join(packageRoot, "hooks", "session-start"), 0o644);
    await chmod(path.join(packageRoot, "hooks", "run-hook.cmd"), 0o644);

    const result = await installTarget("claude-code", {
      packageRoot,
      homeDir: context.homeDir,
      cwd: context.cwd,
    });
    const hookRoot = path.join(result.targetRoot, "hooks");
    assert.notEqual((await stat(path.join(hookRoot, "session-start"))).mode & 0o111, 0);
    assert.notEqual((await stat(path.join(hookRoot, "run-hook.cmd"))).mode & 0o111, 0);

    const { stdout } = await execFileAsync(
      "/bin/sh",
      ["-c", `"${path.join(hookRoot, "run-hook.cmd")}" session-start`],
      { env: { ...process.env, CLAUDE_PLUGIN_ROOT: result.targetRoot } }
    );
    assert.match(JSON.parse(stdout).hookSpecificOutput.additionalContext, /qiushi:arming-thought/);
  });
});
