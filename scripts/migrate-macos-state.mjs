#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseDotenv } from "dotenv";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultTargetDir = () => join(homedir(), "Library", "Application Support", "ChatKJB Terminal");
const receiptName = "migration-receipt.json";
const environmentName = ".env";
const sessionRelativePath = join("data", "telegram-gui.session");
const allowedEnvironmentKeys = Object.freeze([
  "TELEGRAM_API_ID",
  "TELEGRAM_API_HASH",
  "TELEGRAM_CHAT_ID",
  "TELEGRAM_ALLOWED_USER_ID",
  "TELEGRAM_ALLOWED_USER_IDS"
]);
const allowedEnvironmentKeySet = new Set(allowedEnvironmentKeys);
const sourceSessionPathKey = "TELEGRAM_GUI_SESSION_PATH";
const recognizedSourceEnvironmentKeySet = new Set([
  ...allowedEnvironmentKeys,
  sourceSessionPathKey
]);
const requiredEnvironmentKeys = Object.freeze([
  "TELEGRAM_API_ID",
  "TELEGRAM_API_HASH",
  "TELEGRAM_CHAT_ID"
]);
const fileMode = 0o600;
const directoryMode = 0o700;
const maximumEnvironmentBytes = 1024 * 1024;
const maximumSessionBytes = 16 * 1024 * 1024;
const maximumReceiptBytes = 64 * 1024;
const noFollow = constants.O_NOFOLLOW ?? 0;

class MigrationError extends Error {
  constructor(code) {
    super(code);
    this.name = "MigrationError";
    this.code = code;
  }
}

function fail(code) {
  throw new MigrationError(code);
}

function currentUid() {
  const uid = process.getuid?.();
  if (!Number.isInteger(uid) || uid < 0) fail("OWNER_UNAVAILABLE");
  return uid;
}

function permissions(stat) {
  return stat.mode & 0o777;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isPathInside(root, candidate, allowEqual = false) {
  const child = relative(resolve(root), resolve(candidate));
  if (child === "") return allowEqual;
  return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function scopeRootFor(candidate, roots, allowEqual) {
  const absolute = resolve(candidate);
  const root = roots.find((item) => isPathInside(item, absolute, allowEqual));
  if (!root) fail("PATH_OUT_OF_SCOPE");
  return resolve(root);
}

function assertNoSymlinkComponents(root, candidate) {
  const suffix = relative(root, candidate);
  if (!suffix) return;
  let cursor = root;
  for (const component of suffix.split(sep)) {
    cursor = join(cursor, component);
    if (!existsSync(cursor)) continue;
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink()) fail("SYMLINK_FORBIDDEN");
  }
}

function assertOwnedDirectory(path, { mode, code }) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    fail(code);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail(code);
  if (stat.uid !== currentUid()) fail("OWNER_MISMATCH");
  if (mode !== undefined && permissions(stat) !== mode) fail("DIRECTORY_MODE_UNSAFE");
  return stat;
}

function validateSourceDirectory(path) {
  const absolute = resolve(path);
  const root = scopeRootFor(absolute, [projectDir, homedir(), tmpdir()], true);
  assertNoSymlinkComponents(root, absolute);
  assertOwnedDirectory(absolute, { code: "SOURCE_DIRECTORY_UNSAFE" });
  return absolute;
}

function ensureTargetDirectory(path) {
  const absolute = resolve(path);
  const root = scopeRootFor(absolute, [homedir(), tmpdir()], false);
  assertOwnedDirectory(root, { code: "TARGET_SCOPE_UNSAFE" });
  assertNoSymlinkComponents(root, absolute);

  let cursor = root;
  const suffix = relative(root, absolute);
  for (const component of suffix.split(sep)) {
    cursor = join(cursor, component);
    if (!existsSync(cursor)) {
      try {
        mkdirSync(cursor, { mode: directoryMode });
      } catch {
        fail("TARGET_DIRECTORY_CREATE_FAILED");
      }
    }
    const isTarget = cursor === absolute;
    assertOwnedDirectory(cursor, {
      mode: isTarget ? directoryMode : undefined,
      code: "TARGET_DIRECTORY_UNSAFE"
    });
  }
  return absolute;
}

function validateExistingTargetDirectory(path) {
  const absolute = resolve(path);
  const root = scopeRootFor(absolute, [homedir(), tmpdir()], false);
  assertOwnedDirectory(root, { code: "TARGET_SCOPE_UNSAFE" });
  assertNoSymlinkComponents(root, absolute);
  assertOwnedDirectory(absolute, { mode: directoryMode, code: "TARGET_DIRECTORY_UNSAFE" });
  return absolute;
}

function ensurePrivateChildDirectory(parent, name) {
  const path = join(parent, name);
  assertNoSymlinkComponents(parent, path);
  let created = false;
  if (!existsSync(path)) {
    try {
      mkdirSync(path, { mode: directoryMode });
      created = true;
    } catch {
      fail("TARGET_DIRECTORY_CREATE_FAILED");
    }
  }
  assertOwnedDirectory(path, { mode: directoryMode, code: "TARGET_DIRECTORY_UNSAFE" });
  return { path, created };
}

function readOwnedRegularFile(path, { maximumBytes, requireNonempty, unsafeCode }) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | noFollow);
  } catch {
    fail(unsafeCode);
  }
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.uid !== currentUid() || before.nlink !== 1) fail(unsafeCode);
    if (permissions(before) !== fileMode) fail("FILE_MODE_UNSAFE");
    if ((requireNonempty && before.size < 1) || before.size > maximumBytes) fail(unsafeCode);
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || bytes.length !== after.size
    ) fail("FILE_CHANGED_DURING_READ");
    return { bytes, stat: after };
  } finally {
    closeSync(descriptor);
  }
}

function scanEnvironmentAssignments(contents, { strictAllowlist }) {
  const keys = [];
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/);
    if (!match) fail("ENVIRONMENT_INVALID");
    if (strictAllowlist && !allowedEnvironmentKeySet.has(match[1])) {
      fail("ENVIRONMENT_NOT_GUI_ONLY");
    }
    if (recognizedSourceEnvironmentKeySet.has(match[1])) {
      if (keys.includes(match[1])) fail("ENVIRONMENT_DUPLICATE_GUI_KEY");
      keys.push(match[1]);
    }
  }
  return keys;
}

function validatePositiveInteger(value, code) {
  if (!/^[1-9]\d*$/.test(value)) fail(code);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail(code);
}

function validateEnvironmentValues(values) {
  for (const key of requiredEnvironmentKeys) {
    if (typeof values[key] !== "string" || values[key].length === 0) {
      fail("ENVIRONMENT_REQUIRED_KEY_MISSING");
    }
  }
  validatePositiveInteger(values.TELEGRAM_API_ID, "ENVIRONMENT_API_ID_INVALID");
  if (!/^[a-f0-9]{32}$/i.test(values.TELEGRAM_API_HASH)) fail("ENVIRONMENT_API_HASH_INVALID");
  if (!/^-\d+$/.test(values.TELEGRAM_CHAT_ID)) fail("ENVIRONMENT_CHAT_ID_INVALID");
  const chatId = Number(values.TELEGRAM_CHAT_ID);
  if (!Number.isSafeInteger(chatId) || chatId >= 0) fail("ENVIRONMENT_CHAT_ID_INVALID");

  const single = values.TELEGRAM_ALLOWED_USER_ID;
  const multiple = values.TELEGRAM_ALLOWED_USER_IDS;
  if (!single && !multiple) fail("ENVIRONMENT_ALLOWED_USER_MISSING");
  if (single) validatePositiveInteger(single, "ENVIRONMENT_ALLOWED_USER_INVALID");
  if (multiple) {
    const ids = multiple.split(",").map((item) => item.trim());
    if (ids.length === 0 || ids.some((item) => item.length === 0)) {
      fail("ENVIRONMENT_ALLOWED_USER_INVALID");
    }
    for (const id of ids) validatePositiveInteger(id, "ENVIRONMENT_ALLOWED_USER_INVALID");
  }
}

function selectedEnvironment(contents, strictAllowlist) {
  const assignmentKeys = scanEnvironmentAssignments(contents, { strictAllowlist });
  let parsed;
  try {
    parsed = parseDotenv(contents);
  } catch {
    fail("ENVIRONMENT_INVALID");
  }
  const selected = Object.fromEntries(
    allowedEnvironmentKeys
      .filter((key) => Object.hasOwn(parsed, key))
      .map((key) => [key, parsed[key].trim()])
  );
  for (const key of assignmentKeys) {
    if (allowedEnvironmentKeySet.has(key) && !Object.hasOwn(selected, key)) {
      fail("ENVIRONMENT_INVALID");
    }
  }
  validateEnvironmentValues(selected);
  return selected;
}

function canonicalEnvironment(values) {
  return Buffer.from([
    `TELEGRAM_API_ID=${values.TELEGRAM_API_ID}`,
    `TELEGRAM_API_HASH=${values.TELEGRAM_API_HASH}`,
    `TELEGRAM_CHAT_ID=${values.TELEGRAM_CHAT_ID}`,
    ...(values.TELEGRAM_ALLOWED_USER_ID
      ? [`TELEGRAM_ALLOWED_USER_ID=${values.TELEGRAM_ALLOWED_USER_ID}`]
      : []),
    ...(values.TELEGRAM_ALLOWED_USER_IDS
      ? [`TELEGRAM_ALLOWED_USER_IDS=${values.TELEGRAM_ALLOWED_USER_IDS}`]
      : []),
    ""
  ].join("\n"), "utf8");
}

function configuredSourceSessionPath(contents, sourceDir) {
  let parsed;
  try {
    parsed = parseDotenv(contents);
  } catch {
    fail("ENVIRONMENT_INVALID");
  }
  const configured = Object.hasOwn(parsed, sourceSessionPathKey)
    ? parsed[sourceSessionPathKey].trim()
    : sessionRelativePath;
  if (!configured || /[\0\r\n]/.test(configured)) fail("SOURCE_SESSION_PATH_INVALID");

  let candidate;
  let boundary;
  if (configured === "~" || configured.startsWith("~/")) {
    candidate = resolve(homedir(), configured === "~" ? "." : configured.slice(2));
    boundary = scopeRootFor(candidate, [homedir()], true);
  } else if (isAbsolute(configured)) {
    candidate = resolve(configured);
    boundary = scopeRootFor(candidate, [projectDir, homedir(), tmpdir()], true);
  } else {
    candidate = resolve(sourceDir, configured);
    if (!isPathInside(sourceDir, candidate, false)) fail("SOURCE_SESSION_PATH_OUT_OF_SCOPE");
    boundary = sourceDir;
  }
  if (candidate === resolve(sourceDir, environmentName)) fail("SOURCE_SESSION_PATH_COLLISION");
  assertNoSymlinkComponents(boundary, candidate);
  return candidate;
}

function validateSession(bytes) {
  if (bytes.length < 1 || bytes.length > maximumSessionBytes) fail("SESSION_INVALID");
}

function inspectExistingTarget(path, validator, unsafeCode) {
  if (!existsSync(path)) return null;
  const result = readOwnedRegularFile(path, {
    maximumBytes: validator === validateSession ? maximumSessionBytes : maximumEnvironmentBytes,
    requireNonempty: true,
    unsafeCode
  });
  validator(result.bytes);
  return result;
}

function atomicCreateFile(path, bytes) {
  const temporary = join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${randomUUID()}`);
  let descriptor;
  let linked = false;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      fileMode
    );
    writeFileSync(descriptor, bytes);
    fchmodSync(descriptor, fileMode);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    linkSync(temporary, path);
    linked = true;
  } catch {
    fail("ATOMIC_CREATE_FAILED");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary name is absent after normal completion.
    }
  }
  try {
    const created = readOwnedRegularFile(path, {
      maximumBytes: Math.max(maximumSessionBytes, maximumReceiptBytes),
      requireNonempty: true,
      unsafeCode: "CREATED_FILE_UNSAFE"
    });
    if (sha256(created.bytes) !== sha256(bytes)) fail("ATOMIC_CREATE_MISMATCH");
  } catch (error) {
    if (linked) safeRemoveCreatedFile(path, sha256(bytes));
    throw error;
  }
}

function receiptFileRecord(path, action, bytes) {
  return {
    path: path.split(sep).join("/"),
    action,
    sha256: sha256(bytes),
    mode: "0600"
  };
}

function safeRemoveCreatedFile(path, expectedHash) {
  if (!existsSync(path)) return;
  try {
    const current = readOwnedRegularFile(path, {
      maximumBytes: maximumSessionBytes,
      requireNonempty: true,
      unsafeCode: "ROLLBACK_FILE_UNSAFE"
    });
    if (sha256(current.bytes) === expectedHash) unlinkSync(path);
  } catch {
    // Cleanup must never remove a file whose identity is uncertain.
  }
}

function validateReceipt(receipt) {
  if (
    !receipt
    || receipt.schemaVersion !== 1
    || typeof receipt.deploymentId !== "string"
    || !/^[a-f0-9-]{36}$/i.test(receipt.deploymentId)
    || typeof receipt.createdAt !== "string"
    || receipt.targetDirectoryMode !== "0700"
    || !receipt.files
    || !receipt.directories
  ) fail("RECEIPT_INVALID");
  const expected = {
    environment: environmentName,
    guiSession: sessionRelativePath.split(sep).join("/")
  };
  for (const [name, path] of Object.entries(expected)) {
    const record = receipt.files[name];
    if (
      !record
      || record.path !== path
      || !["created", "reused"].includes(record.action)
      || !/^[a-f0-9]{64}$/.test(record.sha256)
      || record.mode !== "0600"
    ) fail("RECEIPT_INVALID");
  }
  if (Object.keys(receipt.files).sort().join(",") !== "environment,guiSession") {
    fail("RECEIPT_INVALID");
  }
  const expectedDirectories = { target: ".", data: "data" };
  for (const [name, path] of Object.entries(expectedDirectories)) {
    const record = receipt.directories[name];
    if (
      !record
      || record.path !== path
      || !/^\d+$/.test(record.device)
      || !/^\d+$/.test(record.inode)
      || record.mode !== "0700"
    ) fail("RECEIPT_INVALID");
  }
  if (Object.keys(receipt.directories).sort().join(",") !== "data,target") {
    fail("RECEIPT_INVALID");
  }
  return receipt;
}

function directoryReceiptRecord(targetDir, path) {
  const stat = assertOwnedDirectory(path, { mode: directoryMode, code: "TARGET_DIRECTORY_UNSAFE" });
  return {
    path: path === targetDir ? "." : relative(targetDir, path).split(sep).join("/"),
    device: String(stat.dev),
    inode: String(stat.ino),
    mode: "0700"
  };
}

function assertReceiptDirectory(targetDir, record) {
  const path = resolve(targetDir, record.path);
  if (record.path !== "." && !isPathInside(targetDir, path, false)) fail("RECEIPT_INVALID");
  let stat;
  try {
    if (record.path !== ".") assertNoSymlinkComponents(targetDir, path);
    stat = assertOwnedDirectory(path, { mode: directoryMode, code: "ROLLBACK_DIRECTORY_UNSAFE" });
  } catch {
    fail("ROLLBACK_DIRECTORY_UNSAFE");
  }
  if (String(stat.dev) !== record.device || String(stat.ino) !== record.inode) {
    fail("ROLLBACK_DIRECTORY_UNSAFE");
  }
  return path;
}

function assertRollbackDirectoryTree(targetDir, receipt) {
  const target = assertReceiptDirectory(targetDir, receipt.directories.target);
  const data = assertReceiptDirectory(targetDir, receipt.directories.data);
  return { target, data };
}

function targetEnvironmentValidator(bytes) {
  const values = selectedEnvironment(bytes.toString("utf8"), true);
  if (!bytes.equals(canonicalEnvironment(values))) fail("ENVIRONMENT_NATIVE_INCOMPATIBLE");
}

export function migrateMacosState(options = {}) {
  const sourceDir = validateSourceDirectory(options.sourceDir ?? projectDir);
  const sourceEnvironmentPath = join(sourceDir, environmentName);
  const sourceEnvironment = readOwnedRegularFile(sourceEnvironmentPath, {
    maximumBytes: maximumEnvironmentBytes,
    requireNonempty: true,
    unsafeCode: "SOURCE_ENVIRONMENT_UNSAFE"
  });
  const sourceEnvironmentText = sourceEnvironment.bytes.toString("utf8");
  const sourceValues = selectedEnvironment(sourceEnvironmentText, false);
  const environmentBytes = canonicalEnvironment(sourceValues);
  const sourceSessionPath = configuredSourceSessionPath(sourceEnvironmentText, sourceDir);
  const sourceSession = readOwnedRegularFile(sourceSessionPath, {
    maximumBytes: maximumSessionBytes,
    requireNonempty: true,
    unsafeCode: "SOURCE_SESSION_UNSAFE"
  });
  validateSession(sourceSession.bytes);

  const targetDir = ensureTargetDirectory(options.targetDir ?? defaultTargetDir());
  if (resolve(targetDir) === resolve(sourceDir)) fail("SOURCE_TARGET_COLLISION");
  const targetEnvironmentPath = join(targetDir, environmentName);
  const targetReceiptPath = join(targetDir, receiptName);
  if (existsSync(targetReceiptPath)) fail("RECEIPT_ALREADY_EXISTS");

  const existingEnvironment = inspectExistingTarget(
    targetEnvironmentPath,
    targetEnvironmentValidator,
    "TARGET_ENVIRONMENT_UNSAFE"
  );
  const dataDirectory = ensurePrivateChildDirectory(targetDir, "data");
  const targetSessionPath = join(dataDirectory.path, "telegram-gui.session");
  const existingSession = inspectExistingTarget(
    targetSessionPath,
    validateSession,
    "TARGET_SESSION_UNSAFE"
  );

  const environmentAction = existingEnvironment ? "reused" : "created";
  const sessionAction = existingSession ? "reused" : "created";
  const finalEnvironmentBytes = existingEnvironment?.bytes ?? environmentBytes;
  const finalSessionBytes = existingSession?.bytes ?? sourceSession.bytes;
  const created = [];
  try {
    if (!existingEnvironment) {
      atomicCreateFile(targetEnvironmentPath, environmentBytes);
      created.push({ path: targetEnvironmentPath, hash: sha256(environmentBytes) });
    }
    if (!existingSession) {
      atomicCreateFile(targetSessionPath, sourceSession.bytes);
      created.push({ path: targetSessionPath, hash: sha256(sourceSession.bytes) });
    }

    const receipt = {
      schemaVersion: 1,
      deploymentId: randomUUID(),
      createdAt: new Date().toISOString(),
      targetDirectoryMode: "0700",
      directories: {
        target: directoryReceiptRecord(targetDir, targetDir),
        data: directoryReceiptRecord(targetDir, dataDirectory.path)
      },
      files: {
        environment: receiptFileRecord(environmentName, environmentAction, finalEnvironmentBytes),
        guiSession: receiptFileRecord(sessionRelativePath, sessionAction, finalSessionBytes)
      }
    };
    const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    atomicCreateFile(targetReceiptPath, receiptBytes);
    return { targetDir, receiptPath: targetReceiptPath, receipt };
  } catch (error) {
    for (const item of created.reverse()) safeRemoveCreatedFile(item.path, item.hash);
    if (dataDirectory.created) {
      try {
        rmdirSync(dataDirectory.path);
      } catch {
        // A non-empty directory may contain a concurrent user file and is preserved.
      }
    }
    throw error;
  }
}

export function rollbackMacosState(options = {}) {
  const targetDir = validateExistingTargetDirectory(options.targetDir ?? defaultTargetDir());
  const receiptPath = join(targetDir, receiptName);
  const receiptFile = readOwnedRegularFile(receiptPath, {
    maximumBytes: maximumReceiptBytes,
    requireNonempty: true,
    unsafeCode: "RECEIPT_UNSAFE"
  });
  let parsed;
  try {
    parsed = JSON.parse(receiptFile.bytes.toString("utf8"));
  } catch {
    fail("RECEIPT_INVALID");
  }
  const receipt = validateReceipt(parsed);
  const directories = assertRollbackDirectoryTree(targetDir, receipt);
  const removals = [];
  for (const [name, record] of Object.entries(receipt.files)) {
    if (record.action !== "created") continue;
    assertRollbackDirectoryTree(targetDir, receipt);
    const path = resolve(targetDir, record.path);
    if (!isPathInside(targetDir, path, false)) fail("RECEIPT_INVALID");
    const expectedParent = name === "environment" ? directories.target : directories.data;
    if (dirname(path) !== expectedParent) fail("RECEIPT_INVALID");
    if (!existsSync(path)) continue;
    const current = readOwnedRegularFile(path, {
      maximumBytes: maximumSessionBytes,
      requireNonempty: true,
      unsafeCode: "ROLLBACK_FILE_UNSAFE"
    });
    assertRollbackDirectoryTree(targetDir, receipt);
    if (sha256(current.bytes) !== record.sha256) fail("ROLLBACK_USER_CHANGE_DETECTED");
    removals.push({ path, hash: record.sha256 });
  }
  for (const item of removals) {
    assertRollbackDirectoryTree(targetDir, receipt);
    const current = readOwnedRegularFile(item.path, {
      maximumBytes: maximumSessionBytes,
      requireNonempty: true,
      unsafeCode: "ROLLBACK_FILE_UNSAFE"
    });
    if (sha256(current.bytes) !== item.hash) fail("ROLLBACK_USER_CHANGE_DETECTED");
  }
  for (const item of removals) {
    assertRollbackDirectoryTree(targetDir, receipt);
    unlinkSync(item.path);
  }
  return { targetDir, receiptPath, removed: removals.length };
}

function usage() {
  return [
    "Usage:",
    "  node scripts/migrate-macos-state.mjs migrate [--source DIR] [--target DIR]",
    "  node scripts/migrate-macos-state.mjs rollback [--target DIR]"
  ].join("\n");
}

export function parseArguments(argv) {
  const values = [...argv];
  let command = "migrate";
  if (values[0] === "migrate" || values[0] === "rollback") command = values.shift();
  if (values[0] === "--help" || values[0] === "-h") return { help: true };
  const options = {};
  while (values.length > 0) {
    const flag = values.shift();
    if (flag !== "--source" && flag !== "--target") fail("ARGUMENT_INVALID");
    const value = values.shift();
    if (!value || value.startsWith("--")) fail("ARGUMENT_INVALID");
    if (flag === "--source") options.sourceDir = value;
    if (flag === "--target") options.targetDir = value;
  }
  if (command === "rollback" && options.sourceDir) fail("ARGUMENT_INVALID");
  return { command, options };
}

export function main(argv = process.argv.slice(2)) {
  try {
    const parsed = parseArguments(argv);
    if (parsed.help) {
      process.stdout.write(`${usage()}\n`);
      return 0;
    }
    if (parsed.command === "rollback") {
      const result = rollbackMacosState(parsed.options);
      process.stdout.write(`CHATKJB_MACOS_STATE_ROLLBACK_OK removed=${result.removed}\n`);
    } else {
      migrateMacosState(parsed.options);
      process.stdout.write("CHATKJB_MACOS_STATE_MIGRATION_OK\n");
    }
    return 0;
  } catch (error) {
    const code = error instanceof MigrationError ? error.code : "UNEXPECTED_FAILURE";
    process.stderr.write(`CHATKJB_MACOS_STATE_ERROR ${code}\n`);
    return 1;
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) process.exitCode = main();
