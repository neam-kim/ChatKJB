#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const buildsDir = join(projectDir, ".dist-builds");
const buildDir = join(buildsDir, `${Date.now()}-${process.pid}`);
const distLink = join(projectDir, "dist");
const nextLink = join(projectDir, `.dist-next-${process.pid}`);
const tsc = join(projectDir, "node_modules", "typescript", "bin", "tsc");

mkdirSync(buildsDir, { recursive: true });
rmSync(buildDir, { recursive: true, force: true });
execFileSync(process.execPath, [tsc, "-p", "tsconfig.build.json", "--outDir", buildDir], {
  cwd: projectDir,
  stdio: "inherit"
});
cpSync(join(projectDir, "src", "gui", "web"), join(buildDir, "gui", "web"), { recursive: true });

symlinkSync(relative(projectDir, buildDir), nextLink, "dir");
if (existsSync(distLink) && !lstatSync(distLink).isSymbolicLink()) {
  rmSync(distLink, { recursive: true, force: true });
}
renameSync(nextLink, distLink);

const completed = (await import("node:fs/promises")).readdir(buildsDir, { withFileTypes: true });
const entries = (await completed)
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
for (const entry of entries.slice(0, -2)) rmSync(join(buildsDir, entry), { recursive: true, force: true });
