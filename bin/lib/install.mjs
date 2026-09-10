import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { PACKAGE_NAME, formatTargetPath, getPlatformById, isCopyPlatform } from "./detect-platform.mjs";

const MANIFEST_FILE = ".qiushi-skill-install.json";
const TRANSACTION_PREFIX = ".qiushi-skill-transaction-";
const BACKUP_DIRECTORY = ".qiushi-skill-backups";

// Official pre-manifest tree at HughYau/qiushi-skill@v1.3.1. Markdown line
// endings are canonicalized before hashing so Git and npm copies are equal.
const LEGACY_SKILL_TREE_SHA256 = new Map(Object.entries({
  "arming-thought": "66f541bdabd3b41dcc683837b04070ceced27761d581ccf50b33bfef103f451f",
  "concentrate-forces": "d2d21ec3a18a9b515895464dc90bf301e0ff474eedf8447bedc58dae551bed95",
  "contradiction-analysis": "3f60b28a572cf48d36d7e93150583aa3e1e3cb5fc8f81c217899ede646ebb5c5",
  "criticism-self-criticism": "b695e7036559edb496fb372d3d4144d7568fc39421baa4f7c86e00b5edc569be",
  "investigation-first": "e56f0279db623d11deffc6fb03601667a80731d0778611b5bbf15734866a02f2",
  "mass-line": "95ed8a282ceb8ee9a388d9ff010cf6b00b3f8988e06f6254015efa0c33042151",
  "overall-planning": "1eb7a71abe694a892b1c92babff759380035e23fd3bae9dc6fc01ab30b148144",
  "practice-cognition": "04ffaf263250ca42676892e721e222970780e35866e667947ed137cdd28229ba",
  "protracted-strategy": "f4227b71bb117cc036b829b0835c89e38ad2c4a30e1b358be8362e56db2ef360",
  "spark-prairie-fire": "afc67c94a22426cfb77e3635ca0b45e82b13f428a96413ddbf33ff6ec1509f18",
  workflows: "361d30d59de7a29a02fb66f4b3b3292ca5fe2c0425c268f4ac93fda8ca3a0eff",
}));

const KNOWN_COMMAND_NAMES = new Set([
  "concentrate-forces.md",
  "contradiction-analysis.md",
  "criticism-self-criticism.md",
  "investigation-first.md",
  "mass-line.md",
  "overall-planning.md",
  "practice-cognition.md",
  "protracted-strategy.md",
  "spark-prairie-fire.md",
  "workflows.md",
]);

function normalizePath(targetPath) {
  const resolved = path.resolve(targetPath).replace(/[\\\/]+$/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function lstatOrNull(targetPath) {
  try {
    return await lstat(targetPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function exists(targetPath) {
  return (await lstatOrNull(targetPath)) !== null;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertRelativeEntry(entryName) {
  if (
    typeof entryName !== "string"
    || !entryName
    || entryName.includes("/")
    || entryName.includes("\\")
    || entryName === "."
    || entryName === ".."
    || entryName === MANIFEST_FILE
    || entryName === BACKUP_DIRECTORY
    || entryName.startsWith(TRANSACTION_PREFIX)
  ) {
    throw new Error(`Refusing to install invalid entry name: ${entryName}`);
  }
}

function resolveManagedEntry(targetRoot, entryName) {
  assertRelativeEntry(entryName);
  const resolvedRoot = path.resolve(targetRoot);
  const destination = path.resolve(targetRoot, entryName);
  const relative = path.relative(resolvedRoot, destination);

  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to touch path outside managed install root: ${destination}`);
  }

  return destination;
}

function assertManagedTarget(platform, scope, targetPath, options = {}) {
  const expectedTarget = formatTargetPath(platform, scope);
  if (!expectedTarget) {
    throw new Error(`Platform '${platform.id}' does not define a managed install target.`);
  }

  if (normalizePath(targetPath) !== normalizePath(expectedTarget)) {
    throw new Error(`Refusing to touch unexpected target path: ${targetPath}`);
  }

  if ((platform.installKind ?? "bundle") === "bundle" && path.basename(targetPath) !== PACKAGE_NAME) {
    throw new Error(`Refusing to touch unexpected bundle path: ${targetPath}`);
  }

  return options.cwd ?? process.cwd();
}

async function assertDirectoryOrMissing(targetRoot) {
  const entryStat = await lstatOrNull(targetRoot);
  if (!entryStat) {
    return;
  }

  const followedStat = await stat(targetRoot).catch(() => null);
  if (!followedStat?.isDirectory()) {
    throw new Error(`Install target is not a directory: ${targetRoot}`);
  }
}

async function resolvePhysicalTarget(targetRoot) {
  const missingSegments = [];
  let existingAncestor = path.resolve(targetRoot);

  while (!(await lstatOrNull(existingAncestor))) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) {
      throw new Error(`Could not resolve an existing parent for install target: ${targetRoot}`);
    }
    missingSegments.push(path.basename(existingAncestor));
    existingAncestor = parent;
  }

  const followedStat = await stat(existingAncestor).catch(() => null);
  if (!followedStat?.isDirectory()) {
    throw new Error(`Install target parent is not a directory: ${existingAncestor}`);
  }

  return path.join(await realpath(existingAncestor), ...missingSegments.reverse());
}

function rootsOverlap(leftRoot, rightRoot) {
  const left = normalizePath(leftRoot);
  const right = normalizePath(rightRoot);
  const isWithin = (parent, child) => {
    const relative = path.relative(parent, child);
    return relative === ""
      || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
  };
  return isWithin(left, right) || isWithin(right, left);
}

export function getAssetsForPlatform(platform, { includeHooks = true } = {}) {
  const assets = [...(platform.assets ?? [])];

  if (!includeHooks) {
    return assets.filter((asset) => asset !== "hooks");
  }

  return assets;
}

function sha256Bytes(content) {
  return createHash("sha256").update(content).digest("hex");
}

function manifestContents(entries) {
  const manifest = {
    packageName: PACKAGE_NAME,
    version: 1,
    entries: [...entries].sort((left, right) => left.path.localeCompare(right.path)),
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function manifestIdentity(entryStat, content) {
  if (!entryStat) {
    return null;
  }
  return {
    dev: entryStat.dev,
    ino: entryStat.ino,
    hash: sha256Bytes(content),
  };
}

function sameIdentity(left, right) {
  if (!left || !right) {
    return left === right;
  }
  return left.dev === right.dev && left.ino === right.ino && left.hash === right.hash;
}

async function readManifest(targetRoot, expected) {
  const manifestPath = path.join(targetRoot, MANIFEST_FILE);
  const entryStat = await lstatOrNull(manifestPath);
  if (!entryStat) {
    return {
      packageName: PACKAGE_NAME,
      version: 1,
      entries: [],
      present: false,
      identity: null,
    };
  }

  if (entryStat.isSymbolicLink() || !entryStat.isFile()) {
    throw new Error(`Invalid install manifest at ${manifestPath}: expected a regular, non-symlink file`);
  }

  try {
    const content = await readFile(manifestPath);
    const parsed = JSON.parse(content.toString("utf8"));
    if (!isPlainObject(parsed)
      || parsed.packageName !== PACKAGE_NAME
      || parsed.version !== 1
      || !Array.isArray(parsed.entries)) {
      throw new Error("manifest identity, version, or entries are invalid");
    }

    const seen = new Set();
    for (const entry of parsed.entries) {
      if (!isPlainObject(entry)) {
        throw new Error("manifest entries must be objects");
      }
      assertRelativeEntry(entry.path);
      if (entry.type !== expected.type || entry.source !== expected.source) {
        throw new Error(`manifest entry '${entry.path}' has an unexpected type or source`);
      }
      if (seen.has(entry.path)) {
        throw new Error(`manifest contains duplicate entry '${entry.path}'`);
      }
      seen.add(entry.path);
    }

    return {
      packageName: parsed.packageName,
      version: parsed.version,
      entries: parsed.entries,
      present: true,
      identity: manifestIdentity(entryStat, content),
    };
  } catch (error) {
    throw new Error(`Invalid install manifest at ${manifestPath}: ${error.message}`);
  }
}

function canonicalFileBytes(fileName, content) {
  if (path.extname(fileName).toLowerCase() !== ".md") {
    return content;
  }
  return Buffer.from(content.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
}

async function sha256Directory(rootPath) {
  const hash = createHash("sha256");

  async function visit(directory, relativeDirectory = "") {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const fullPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        hash.update(`D\0${relativePath}\0`);
        await visit(fullPath, relativePath);
      } else if (entry.isFile()) {
        const content = canonicalFileBytes(entry.name, await readFile(fullPath));
        hash.update(`F\0${relativePath}\0${content.length}\0`);
        hash.update(content);
      } else {
        throw new Error(`Refusing to use a directory with non-file entries: ${fullPath}`);
      }
    }
  }

  await visit(rootPath);
  return hash.digest("hex");
}

async function hashPath(targetPath, entryType) {
  if (entryType === "directory") {
    return sha256Directory(targetPath);
  }
  return sha256Bytes(await readFile(targetPath));
}

async function snapshotPath(targetPath, entryType) {
  const entryStat = await lstatOrNull(targetPath);
  if (!entryStat) {
    return null;
  }
  if (entryStat.isSymbolicLink()
    || (entryType === "directory" ? !entryStat.isDirectory() : !entryStat.isFile())) {
    throw new Error(`Refusing to replace an unexpected or symlinked path: ${targetPath}`);
  }
  return {
    dev: entryStat.dev,
    ino: entryStat.ino,
    hash: await hashPath(targetPath, entryType),
  };
}

async function assertAdoptableLegacySkill(packageRoot, sourceDir, destination, entryName) {
  if (sourceDir !== "skills") {
    throw new Error(`Legacy adoption is only supported for skill directories: ${destination}`);
  }

  const destinationStat = await lstat(destination);
  if (!destinationStat.isDirectory() || destinationStat.isSymbolicLink()) {
    throw new Error(`Refusing to adopt a non-directory or symlinked skill: ${destination}`);
  }

  const installedSkill = path.join(destination, "SKILL.md");
  const installedSkillStat = await lstatOrNull(installedSkill);
  if (!installedSkillStat?.isFile() || installedSkillStat.isSymbolicLink()) {
    throw new Error(`Refusing to adopt a directory without a regular SKILL.md: ${destination}`);
  }

  const installedHash = await sha256Directory(destination);
  const sourceHash = await sha256Directory(path.join(packageRoot, sourceDir, entryName));
  if (installedHash !== sourceHash && installedHash !== LEGACY_SKILL_TREE_SHA256.get(entryName)) {
    throw new Error(
      `Refusing to adopt modified or unsupported legacy skill '${entryName}'. `
      + "Back it up and reconcile it manually."
    );
  }
  return installedHash;
}

async function inspectUnmanagedEntries(packageRoot, sourceDir, targetRoot, sources, manifestEntries, adoptLegacy) {
  const unmanaged = [];

  for (const source of sources) {
    const destination = resolveManagedEntry(targetRoot, source.name);
    if ((await exists(destination)) && !manifestEntries.has(source.name)) {
      unmanaged.push({ destination, entryName: source.name });
    }
  }

  if (unmanaged.length > 0 && !adoptLegacy) {
    const paths = unmanaged.map(({ destination }) => destination).join(", ");
    throw new Error(
      `Refusing to overwrite unmanaged paths: ${paths}. `
      + "For an unmodified pre-manifest Qiushi install, rerun with --adopt-legacy."
    );
  }

  for (const entry of unmanaged) {
    entry.hash = await assertAdoptableLegacySkill(
      packageRoot,
      sourceDir,
      entry.destination,
      entry.entryName
    );
  }

  return unmanaged;
}

function allowedManagedNames(sourceDir, sourceNames) {
  if (sourceDir === "skills") {
    return new Set([...sourceNames, ...LEGACY_SKILL_TREE_SHA256.keys()]);
  }
  return new Set([...sourceNames, ...KNOWN_COMMAND_NAMES]);
}

async function prepareInstallPlan(
  packageRoot,
  sourceDir,
  targetRoot,
  { entryType, extension = null, adoptLegacy = false } = {}
) {
  await assertDirectoryOrMissing(targetRoot);
  targetRoot = await resolvePhysicalTarget(targetRoot);
  const manifest = await readManifest(targetRoot, { type: entryType, source: sourceDir });
  const sourceRoot = path.join(packageRoot, sourceDir);
  const dirEntries = await readdir(sourceRoot, { withFileTypes: true });

  for (const entry of dirEntries) {
    const valid = entryType === "directory"
      ? entry.isDirectory()
      : entry.isFile() && (!extension || entry.name.endsWith(extension));
    if (!valid) {
      throw new Error(`Unexpected source entry in ${sourceRoot}: ${entry.name}`);
    }
  }

  const sources = [];
  for (const entry of dirEntries.sort((left, right) => left.name.localeCompare(right.name))) {
    assertRelativeEntry(entry.name);
    const source = path.join(sourceRoot, entry.name);
    sources.push({
      name: entry.name,
      source,
      entryType,
      hash: await hashPath(source, entryType),
    });
  }

  const sourceNames = new Set(sources.map((entry) => entry.name));
  const allowedNames = allowedManagedNames(sourceDir, sourceNames);
  for (const entry of manifest.entries) {
    if (!allowedNames.has(entry.path)) {
      throw new Error(
        `Invalid install manifest at ${path.join(targetRoot, MANIFEST_FILE)}: `
        + `unknown managed path '${entry.path}'`
      );
    }
  }

  const manifestEntries = new Set(manifest.entries.map((entry) => entry.path));
  const unmanagedEntries = await inspectUnmanagedEntries(
    packageRoot,
    sourceDir,
    targetRoot,
    sources,
    manifestEntries,
    adoptLegacy
  );
  const affectedNames = [...new Set([...sourceNames, ...manifestEntries])].sort();
  const snapshots = new Map();
  for (const entryName of affectedNames) {
    snapshots.set(entryName, await snapshotPath(resolveManagedEntry(targetRoot, entryName), entryType));
  }

  return {
    targetRoot,
    sourceDir,
    entryType,
    entryTypes: new Map(affectedNames.map((entryName) => [entryName, entryType])),
    sources,
    manifest,
    nextEntries: sources.map((entry) => ({
      path: entry.name,
      type: entryType,
      source: sourceDir,
    })),
    unmanagedEntries,
    affectedNames,
    snapshots,
    manifestAction: "write",
    backupRoot: null,
    transaction: null,
  };
}

async function prepareRemovalPlan(targetRoot, { entryType, sourceDir }) {
  await assertDirectoryOrMissing(targetRoot);
  targetRoot = await resolvePhysicalTarget(targetRoot);
  const manifest = await readManifest(targetRoot, { type: entryType, source: sourceDir });
  if (!manifest.present) {
    return null;
  }

  const allowedNames = sourceDir === "skills"
    ? new Set(LEGACY_SKILL_TREE_SHA256.keys())
    : KNOWN_COMMAND_NAMES;
  for (const entry of manifest.entries) {
    if (!allowedNames.has(entry.path)) {
      throw new Error(
        `Invalid install manifest at ${path.join(targetRoot, MANIFEST_FILE)}: `
        + `unknown managed path '${entry.path}'`
      );
    }
  }

  const affectedNames = manifest.entries.map((entry) => entry.path).sort();
  const snapshots = new Map();
  for (const entryName of affectedNames) {
    snapshots.set(entryName, await snapshotPath(resolveManagedEntry(targetRoot, entryName), entryType));
  }

  return {
    targetRoot,
    sourceDir,
    entryType,
    entryTypes: new Map(affectedNames.map((entryName) => [entryName, entryType])),
    sources: [],
    manifest,
    nextEntries: [],
    unmanagedEntries: [],
    affectedNames,
    snapshots,
    manifestAction: "remove",
    backupRoot: null,
    transaction: null,
  };
}

async function stagePlan(plan) {
  const rootExisted = await exists(plan.targetRoot);
  const transactionRoot = path.join(
    plan.targetRoot,
    `${TRANSACTION_PREFIX}${process.pid}-${randomUUID()}`
  );
  const nextRoot = path.join(transactionRoot, "next");
  const previousRoot = path.join(transactionRoot, "previous");
  const nextManifestPath = path.join(transactionRoot, "next-manifest.json");
  plan.transaction = {
    rootExisted,
    transactionRoot,
    nextRoot,
    previousRoot,
    nextManifestPath,
    movedPrevious: [],
    installedNext: [],
    oldManifestMoved: false,
    oldManifestCopied: false,
    newManifestInstalled: false,
  };

  await mkdir(plan.targetRoot, { recursive: true });
  if (normalizePath(await realpath(plan.targetRoot)) !== normalizePath(plan.targetRoot)) {
    throw new Error(`Install target changed while preparing transaction: ${plan.targetRoot}`);
  }
  await mkdir(transactionRoot, { mode: 0o700 });
  await mkdir(nextRoot, { mode: 0o700 });
  await mkdir(previousRoot, { mode: 0o700 });

  for (const source of plan.sources) {
    const stagedPath = path.join(nextRoot, source.name);
    await cp(source.source, stagedPath, {
      recursive: source.entryType === "directory",
      force: false,
      errorOnExist: true,
    });
    if (await hashPath(stagedPath, source.entryType) !== source.hash) {
      throw new Error(`Staged copy did not match its source: ${source.source}`);
    }
  }

  for (const executablePath of plan.executablePaths ?? []) {
    await chmod(path.join(nextRoot, executablePath), 0o755);
  }

  if (plan.manifestAction === "write") {
    await writeFile(nextManifestPath, manifestContents(plan.nextEntries), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o644,
    });
    if (plan.manifest.present) {
      await cp(
        path.join(plan.targetRoot, MANIFEST_FILE),
        path.join(previousRoot, MANIFEST_FILE),
        { force: false, errorOnExist: true }
      );
      plan.transaction.oldManifestCopied = true;
    }
  }
}

async function backUpUnmanagedEntries(plan) {
  if (plan.unmanagedEntries.length === 0) {
    return;
  }

  const backupParent = path.join(plan.targetRoot, BACKUP_DIRECTORY);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupRoot = path.join(backupParent, `${stamp}-${process.pid}-${randomUUID()}`);
  plan.backupRoot = backupRoot;
  const backupParentStat = await lstatOrNull(backupParent);
  if (backupParentStat
    && (backupParentStat.isSymbolicLink() || !backupParentStat.isDirectory())) {
    throw new Error(`Refusing to use an unsafe legacy backup directory: ${backupParent}`);
  }
  await mkdir(backupParent, { recursive: true });
  await mkdir(backupRoot, { mode: 0o700 });

  for (const { destination, entryName } of plan.unmanagedEntries) {
    await cp(destination, path.join(backupRoot, entryName), {
      recursive: true,
      verbatimSymlinks: true,
    });
  }
}

async function currentManifestIdentity(plan) {
  const manifestPath = path.join(plan.targetRoot, MANIFEST_FILE);
  const entryStat = await lstatOrNull(manifestPath);
  if (!entryStat) {
    return null;
  }
  if (entryStat.isSymbolicLink() || !entryStat.isFile()) {
    throw new Error(`Install manifest changed to an unsafe file during installation: ${manifestPath}`);
  }
  return manifestIdentity(entryStat, await readFile(manifestPath));
}

async function verifyPlanUnchanged(plan) {
  if (plan.manifestAction !== "none"
    && !sameIdentity(plan.manifest.identity, await currentManifestIdentity(plan))) {
    throw new Error(`Install manifest changed during installation: ${path.join(plan.targetRoot, MANIFEST_FILE)}`);
  }

  for (const entryName of plan.affectedNames) {
    const current = await snapshotPath(
      resolveManagedEntry(plan.targetRoot, entryName),
      plan.entryTypes.get(entryName)
    );
    if (!sameIdentity(plan.snapshots.get(entryName), current)) {
      throw new Error(`Install path changed during installation: ${resolveManagedEntry(plan.targetRoot, entryName)}`);
    }
  }
}

async function swapPlan(plan) {
  const transaction = plan.transaction;
  for (const entryName of plan.affectedNames) {
    const destination = resolveManagedEntry(plan.targetRoot, entryName);
    if (await exists(destination)) {
      await rename(destination, path.join(transaction.previousRoot, entryName));
      transaction.movedPrevious.push(entryName);
    }
  }

  for (const source of plan.sources) {
    await rename(path.join(transaction.nextRoot, source.name), resolveManagedEntry(plan.targetRoot, source.name));
    transaction.installedNext.push(source.name);
  }

  const manifestPath = path.join(plan.targetRoot, MANIFEST_FILE);
  if (plan.manifest.present && plan.manifestAction === "remove") {
    await rename(manifestPath, path.join(transaction.previousRoot, MANIFEST_FILE));
    transaction.oldManifestMoved = true;
  }

  if (plan.manifestAction === "write") {
    await rename(transaction.nextManifestPath, manifestPath);
    transaction.newManifestInstalled = true;
  }
}

async function rollbackPlan(plan) {
  const transaction = plan.transaction;
  if (!transaction) {
    return [];
  }

  const errors = [];
  const attempt = async (operation) => {
    try {
      await operation();
    } catch (error) {
      errors.push(error);
    }
  };

  const manifestPath = path.join(plan.targetRoot, MANIFEST_FILE);
  if (transaction.newManifestInstalled) {
    await attempt(() => rm(manifestPath, { force: true }));
  }

  for (const entryName of [...transaction.installedNext].reverse()) {
    await attempt(() => rm(resolveManagedEntry(plan.targetRoot, entryName), { recursive: true, force: true }));
  }
  for (const entryName of [...transaction.movedPrevious].reverse()) {
    await attempt(() => rename(
      path.join(transaction.previousRoot, entryName),
      resolveManagedEntry(plan.targetRoot, entryName)
    ));
  }

  if (transaction.oldManifestMoved
    || (transaction.oldManifestCopied && transaction.newManifestInstalled)) {
    await attempt(() => rename(path.join(transaction.previousRoot, MANIFEST_FILE), manifestPath));
  }

  if (errors.length === 0) {
    await attempt(() => rm(transaction.transactionRoot, { recursive: true, force: true }));
    if (plan.backupRoot) {
      await attempt(() => rm(plan.backupRoot, { recursive: true, force: true }));
      await rmdir(path.dirname(plan.backupRoot)).catch(() => {});
    }
    if (!transaction.rootExisted) {
      await rmdir(plan.targetRoot).catch(() => {});
    }
  }

  return errors;
}

async function executePlans(plans) {
  if (plans.length === 0) {
    return;
  }

  try {
    for (const plan of plans) {
      await stagePlan(plan);
    }
    for (const plan of plans) {
      await backUpUnmanagedEntries(plan);
    }
    for (const plan of plans) {
      await verifyPlanUnchanged(plan);
    }
    for (const plan of plans) {
      await swapPlan(plan);
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const plan of [...plans].reverse()) {
      rollbackErrors.push(...await rollbackPlan(plan));
    }
    if (rollbackErrors.length > 0) {
      const recoveryRoots = plans
        .map((plan) => plan.transaction?.transactionRoot)
        .filter(Boolean)
        .join(", ");
      throw new Error(
        `${error.message}; rollback was incomplete. Recovery data remains at: ${recoveryRoots}`,
        { cause: error }
      );
    }
    throw error;
  }

  for (const plan of plans) {
    await rm(plan.transaction.transactionRoot, { recursive: true, force: true }).catch(() => {});
  }
}

function validateLegacyOption(platform, adoptLegacy) {
  if (!adoptLegacy || !isCopyPlatform(platform)) {
    return;
  }
  if ((platform.installKind ?? "bundle") !== "skills") {
    throw new Error("--adopt-legacy currently supports skills-only targets such as Codex.");
  }
}

async function prepareSkillTarget(platform, options) {
  const { packageRoot, scope, adoptLegacy, cwd } = options;
  const installKind = platform.installKind;
  const targetRoot = formatTargetPath(platform, scope);
  assertManagedTarget(platform, scope, targetRoot, { cwd });

  const plans = [await prepareInstallPlan(packageRoot, "skills", targetRoot, {
    entryType: "directory",
    adoptLegacy,
  })];
  const targetRoots = [targetRoot];

  if (installKind === "skills-commands") {
    const commandRoot = platform.commandPaths?.[scope];
    if (!commandRoot) {
      throw new Error(`Platform '${platform.id}' does not define a command install target for scope '${scope}'.`);
    }
    plans.push(await prepareInstallPlan(packageRoot, "commands", commandRoot, {
      entryType: "file",
      extension: ".md",
    }));
    targetRoots.push(commandRoot);
  }

  return { platform, targetRoot, targetRoots, plans };
}

async function prepareBundleTarget(platform, options) {
  const { packageRoot, scope, includeHooks, cwd } = options;
  const targetRoot = formatTargetPath(platform, scope);
  assertManagedTarget(platform, scope, targetRoot, { cwd });
  const targetStat = await lstatOrNull(targetRoot);
  if (targetStat?.isSymbolicLink()) {
    throw new Error(`Refusing to install a bundle through a symlinked target: ${targetRoot}`);
  }
  await assertDirectoryOrMissing(targetRoot);
  const physicalTargetRoot = await resolvePhysicalTarget(targetRoot);

  const assets = getAssetsForPlatform(platform, { includeHooks });
  const sources = [];
  for (const asset of assets) {
    assertRelativeEntry(asset);
    const source = path.join(packageRoot, asset);
    const sourceStat = await lstatOrNull(source);
    if (!sourceStat || sourceStat.isSymbolicLink()
      || (!sourceStat.isDirectory() && !sourceStat.isFile())) {
      throw new Error(`Missing or unsafe bundle asset: ${source}`);
    }
    const entryType = sourceStat.isDirectory() ? "directory" : "file";
    sources.push({
      name: asset,
      source,
      entryType,
      hash: await hashPath(source, entryType),
    });
  }

  const entryTypes = new Map(sources.map((source) => [source.name, source.entryType]));
  const snapshots = new Map();
  for (const asset of assets) {
    snapshots.set(
      asset,
      await snapshotPath(resolveManagedEntry(physicalTargetRoot, asset), entryTypes.get(asset))
    );
  }

  return {
    platform,
    targetRoot,
    plans: [{
      targetRoot: physicalTargetRoot,
      sourceDir: "bundle",
      entryType: null,
      entryTypes,
      sources,
      manifest: { present: false, identity: null },
      nextEntries: [],
      unmanagedEntries: [],
      affectedNames: [...assets].sort(),
      snapshots,
      manifestAction: "none",
      executablePaths: assets.includes("hooks")
        ? [path.join("hooks", "session-start"), path.join("hooks", "run-hook.cmd")]
        : [],
      backupRoot: null,
      transaction: null,
    }],
    assets,
  };
}

export async function installTargets(targets, options = {}) {
  const {
    packageRoot,
    scope = "user",
    includeHooks = true,
    adoptLegacy = false,
    cwd = process.cwd(),
    homeDir = os.homedir(),
    env = process.env,
  } = options;
  const resolved = targets.map((target) => {
    const platform = getPlatformById(target, { cwd, homeDir, env });
    if (!platform) {
      throw new Error(`Unknown platform: ${target}`);
    }
    validateLegacyOption(platform, adoptLegacy);
    return platform;
  });

  const preparedById = new Map();
  const allPlans = [];
  for (const platform of resolved) {
    const installKind = platform.installKind ?? "bundle";
    if (isCopyPlatform(platform) && (installKind === "skills" || installKind === "skills-commands")) {
      const prepared = await prepareSkillTarget(platform, { packageRoot, scope, adoptLegacy, cwd });
      preparedById.set(platform.id, prepared);
      allPlans.push(...prepared.plans);
    } else if (isCopyPlatform(platform)) {
      const prepared = await prepareBundleTarget(platform, { packageRoot, scope, includeHooks, cwd });
      preparedById.set(platform.id, prepared);
      allPlans.push(...prepared.plans);
    }
  }

  for (let left = 0; left < allPlans.length; left += 1) {
    for (let right = left + 1; right < allPlans.length; right += 1) {
      if (rootsOverlap(allPlans[left].targetRoot, allPlans[right].targetRoot)) {
        throw new Error(
          "Refusing to use overlapping physical install roots: "
          + `${allPlans[left].targetRoot}, ${allPlans[right].targetRoot}`
        );
      }
    }
  }
  await executePlans(allPlans);

  const results = [];
  for (const platform of resolved) {
    if (!isCopyPlatform(platform)) {
      results.push({
        platform,
        kind: "guide",
        commands: platform.guide ?? [],
      });
      continue;
    }

    const prepared = preparedById.get(platform.id);
    if ((platform.installKind ?? "bundle") !== "bundle") {
      results.push({
        platform,
        kind: "copied",
        scope,
        targetRoot: prepared.targetRoot,
        targetRoots: prepared.targetRoots,
        assets: prepared.plans.flatMap((plan) => (
          plan.nextEntries.map((entry) => `${plan.sourceDir}/${entry.path}`)
        )),
        backupRoots: prepared.plans.map((plan) => plan.backupRoot).filter(Boolean),
      });
      continue;
    }

    results.push({
      platform,
      kind: "copied",
      scope,
      targetRoot: prepared.targetRoot,
      assets: prepared.assets,
    });
  }
  return results;
}

export async function installTarget(platformId, options = {}) {
  return (await installTargets([platformId], options))[0];
}

export async function uninstallTarget(platformId, options = {}) {
  const {
    scope = "user",
    cwd = process.cwd(),
    homeDir = os.homedir(),
    env = process.env,
  } = options;
  const platform = getPlatformById(platformId, { cwd, homeDir, env });

  if (!platform) {
    throw new Error(`Unknown platform: ${platformId}`);
  }

  if (!isCopyPlatform(platform)) {
    return {
      platform,
      kind: "guide",
    };
  }

  const installKind = platform.installKind ?? "bundle";
  const targetRoot = formatTargetPath(platform, scope);
  assertManagedTarget(platform, scope, targetRoot, { cwd });

  if (installKind === "skills" || installKind === "skills-commands") {
    const plans = [];
    const skillPlan = await prepareRemovalPlan(targetRoot, { entryType: "directory", sourceDir: "skills" });
    if (skillPlan) {
      plans.push(skillPlan);
    }
    const targetRoots = [targetRoot];

    if (installKind === "skills-commands") {
      const commandRoot = platform.commandPaths?.[scope];
      if (commandRoot) {
        const commandPlan = await prepareRemovalPlan(commandRoot, { entryType: "file", sourceDir: "commands" });
        if (commandPlan) {
          plans.push(commandPlan);
        }
        targetRoots.push(commandRoot);
      }
    }

    await executePlans(plans);
    return {
      platform,
      kind: "removed",
      targetRoot,
      targetRoots,
      removed: plans.flatMap((plan) => plan.affectedNames),
    };
  }

  const targetStat = await lstatOrNull(targetRoot);
  if (targetStat?.isSymbolicLink()) {
    throw new Error(`Refusing to uninstall a bundle through a symlinked target: ${targetRoot}`);
  }
  if (targetStat && !targetStat.isDirectory()) {
    throw new Error(`Bundle target is not a directory: ${targetRoot}`);
  }
  await rm(targetRoot, { recursive: true, force: true });
  return {
    platform,
    kind: "removed",
    targetRoot,
  };
}
