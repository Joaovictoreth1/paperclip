import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

import cliEsbuildConfig from "../cli/esbuild.config.mjs";
import { bundledCliNpmDependencies } from "./cli-bundled-npm-dependencies.mjs";
import {
  createBundledInstallManifest,
  materializePublishManifest,
  selectBundledDependencyPatches,
} from "./prepare-bundled-package.mjs";

const resolvePath = (relativePath) => fileURLToPath(new URL(relativePath, import.meta.url));
const readText = (relativePath) => readFile(resolvePath(relativePath), "utf8");
const readJson = async (relativePath) => JSON.parse(await readText(relativePath));

const [
  rootPackage,
  adapterUtilsPackage,
  runnerPackage,
  serverPackage,
  dbPackage,
  releaseScript,
  releaseLib,
  buildNpmScript,
  acpxRuntimePatch,
  claudeAcpPatch,
] = await Promise.all([
  readJson("../package.json"),
  readJson("../packages/adapter-utils/package.json"),
  readJson("../packages/paperclip-runner/package.json"),
  readJson("../server/package.json"),
  readJson("../packages/db/package.json"),
  readText("./release.sh"),
  readText("./release-lib.sh"),
  readText("./build-npm.sh"),
  readText("../patches/acpx@0.13.1.patch"),
  readText("../patches/@agentclientprotocol__claude-agent-acp@0.73.0.patch"),
]);

function createTempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeFakeInstalledPackage(baseDir, name, version) {
  const packageDir = join(baseDir, "node_modules", ...name.split("/"));
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name, version }));
  return packageDir;
}

function writeExecutable(binDir, name, scriptLines) {
  writeFileSync(join(binDir, name), `#!/usr/bin/env bash\nset -euo pipefail\n${scriptLines.join("\n")}\n`, {
    mode: 0o755,
  });
}

function assertPortableUnifiedDiff(patchContent, versionLabel) {
  const HUNK_HEADER_REGEX = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const lines = patchContent.split("\n");
  let hunkCount = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const header = lines[index].match(HUNK_HEADER_REGEX);
    if (!header) continue;

    hunkCount += 1;
    const oldStart = header[1];
    const expectedOldCount = Number(header[2] ?? 1);
    const expectedNewCount = Number(header[4] ?? 1);

    const body = [];
    let oldLines = 0;
    let newLines = 0;

    while (
      index + 1 < lines.length &&
      (oldLines < expectedOldCount || newLines < expectedNewCount)
    ) {
      const line = lines[++index];
      // Unified diff's EOF marker is metadata, not a source/destination line.
      if (line === "\\ No newline at end of file") continue;

      assert.ok(line === "" || /^[ +\-]/.test(line), `invalid unified hunk line: ${line}`);
      const normalized = line === "" ? " " : line;
      body.push(normalized);

      if (!normalized.startsWith("+")) oldLines += 1;
      if (!normalized.startsWith("-")) newLines += 1;
    }

    assert.equal(body.filter((line) => !line.startsWith("+")).length, expectedOldCount);
    assert.equal(body.filter((line) => !line.startsWith("-")).length, expectedNewCount);

    const prefix = body.findIndex((line) => !line.startsWith(" "));
    const suffix = body.findLastIndex((line) => !line.startsWith(" "));
    const trailingContext = suffix === -1 ? -1 : body.length - 1 - suffix;

    // pnpm patch-commit emits up to 3 context lines. Asymmetric manual context
    // can cause GNU patch's locate_hunk() to fail where git apply succeeds.
    assert.ok(
      prefix >= 0 && prefix <= 3,
      `regenerate ${versionLabel} hunk at old line ${oldStart} with pnpm patch-commit (prefix ${prefix})`,
    );
    assert.ok(
      trailingContext >= 0 && trailingContext <= 3,
      `regenerate ${versionLabel} hunk at old line ${oldStart} with pnpm patch-commit (suffix ${trailingContext})`,
    );
  }

  assert.ok(hunkCount > 0, `expected at least one hunk in ${versionLabel} patch`);
}

describe("Runtime Patches & Integrity", () => {
  for (const version of ["0.12.0", "0.13.1"]) {
    test(`ACPX ${version} release patch uses portable generated unified hunks`, async () => {
      const patch = await readText(`../patches/acpx@${version}.patch`);
      assertPortableUnifiedDiff(patch, version);
    });
  }

  test("published packages preserve the patched ACPX runtime", () => {
    const { patchedDependencies } = rootPackage.pnpm;

    assert.equal(patchedDependencies["acpx@0.12.0"], "patches/acpx@0.12.0.patch");
    assert.equal(patchedDependencies["acpx@0.13.1"], "patches/acpx@0.13.1.patch");

    assert.equal(adapterUtilsPackage.dependencies.acpx, "0.12.0");
    assert.deepEqual(adapterUtilsPackage.bundleDependencies, ["acpx"]);

    assert.equal(serverPackage.dependencies.acpx, "0.13.1");
    assert.ok(serverPackage.bundleDependencies.includes("acpx"));

    assert.equal(bundledCliNpmDependencies.has("acpx"), true);
    assert.equal(cliEsbuildConfig.external.includes("acpx"), false);
  });

  test("Paperclip Runner pins the qualified ACPX host callbacks", () => {
    const { patchedDependencies } = rootPackage.pnpm;

    assert.equal(patchedDependencies["acpx@0.13.1"], "patches/acpx@0.13.1.patch");
    assert.equal(
      patchedDependencies["@agentclientprotocol/claude-agent-acp@0.73.0"],
      "patches/@agentclientprotocol__claude-agent-acp@0.73.0.patch",
    );
    assert.equal(runnerPackage.dependencies.acpx, "0.13.1");
    assert.equal(runnerPackage.dependencies["@agentclientprotocol/claude-agent-acp"], "0.73.0");
    assert.equal(runnerPackage.dependencies["@agentclientprotocol/codex-acp"], "1.6.2");

    const expectedCallbacks = [
      "spawnEnvironment",
      "spawnCwd",
      "spawnAgent",
      "isPlainStringEnvironment",
      "onAgentSpawn",
      "onAgentStderr",
      "onAgentExit",
      "onSessionNotification",
      "onClientOperation",
    ];

    for (const callback of expectedCallbacks) {
      assert.match(acpxRuntimePatch, new RegExp(`\\b${callback}\\b`));
    }

    assert.match(claudeAcpPatch, /usage: \{/);
    assert.match(claudeAcpPatch, /cache_creation_input_tokens/);
  });

  test("published packages preserve the patched embedded-postgres runtime", () => {
    assert.equal(
      rootPackage.pnpm.patchedDependencies["embedded-postgres@18.1.0-beta.16"],
      "patches/embedded-postgres@18.1.0-beta.16.patch",
    );
    assert.deepEqual(dbPackage.bundleDependencies, ["embedded-postgres"]);
    assert.equal(bundledCliNpmDependencies.has("embedded-postgres"), true);
    assert.equal(cliEsbuildConfig.external.includes("embedded-postgres"), false);
  });

  test("installed ACPX runtime persists and restores optional goal capabilities", () => {
    const requireRunner = createRequire(resolvePath("../packages/paperclip-runner/package.json"));
    const runtimeSource = readFileSync(requireRunner.resolve("acpx/runtime"), "utf8");

    const start = runtimeSource.indexOf("function persistedGoalCapability(");
    const end = runtimeSource.indexOf("function planUpdateEvent(", start);
    assert.ok(start >= 0 && end > start, "the installed patch must define both goal helpers");

    const helpers = runInNewContext(
      `${runtimeSource.slice(start, end)};({ persistedGoalCapability, restoredGoalCapability })`,
      {
        isRecord: (value) => value !== null && typeof value === "object" && !Array.isArray(value),
      },
    );

    assert.equal(helpers.persistedGoalCapability(undefined), undefined);
    assert.equal(helpers.restoredGoalCapability(undefined), undefined);

    const goal = { version: 1, controlMethod: "_session/goal", actions: ["set", "pause", "clear"] };
    const saved = structuredClone(helpers.persistedGoalCapability(goal));

    assert.equal(saved.control_method, "_session/goal");
    assert.deepEqual(structuredClone(helpers.restoredGoalCapability(saved)), goal);
    assert.equal(helpers.persistedGoalCapability({ ...goal, version: 2 }), undefined);
    assert.equal(helpers.persistedGoalCapability({ ...goal, actions: ["set"] }), undefined);
  });
});

describe("Manifest Materialization", () => {
  test("materializes publishConfig entrypoints", () => {
    const staged = materializePublishManifest(adapterUtilsPackage);

    assert.equal(staged.publishConfig, undefined);
    assert.equal(staged.main, "./dist/index.js");
    assert.equal(staged.types, "./dist/index.d.ts");
    assert.deepEqual(staged.exports, adapterUtilsPackage.publishConfig.exports);
  });

  test("materializes workspace dependency versions", () => {
    const staged = materializePublishManifest({
      name: "@paperclipai/example",
      version: "2026.723.0",
      dependencies: {
        exact: "workspace:*",
        caret: "workspace:^",
        tilde: "workspace:~",
      },
    });

    assert.deepEqual(staged.dependencies, {
      exact: "2026.723.0",
      caret: "^2026.723.0",
      tilde: "~2026.723.0",
    });
  });

  test("installs only dependencies included in the tarball without mutating input manifest", () => {
    const publishManifest = {
      name: "@paperclipai/db",
      version: "2026.723.0-canary.8",
      dependencies: {
        "@paperclipai/shared": "2026.723.0-canary.8",
        "drizzle-orm": "^0.45.2",
        "embedded-postgres": "^18.1.0-beta.16",
      },
      devDependencies: {
        "@paperclipai/paperclip-runner": "2026.723.0-canary.8",
      },
      bundleDependencies: ["embedded-postgres"],
    };

    const installManifest = createBundledInstallManifest(publishManifest, ["embedded-postgres"]);

    assert.deepEqual(installManifest.dependencies, {
      "embedded-postgres": "^18.1.0-beta.16",
    });
    assert.equal(installManifest.devDependencies, undefined);
    assert.deepEqual(publishManifest.devDependencies, {
      "@paperclipai/paperclip-runner": "2026.723.0-canary.8",
    });
    assert.deepEqual(installManifest.bundleDependencies, ["embedded-postgres"]);
  });
});

describe("Bundled Dependency Patch Selection", () => {
  const configuredAcpxPatches = Object.freeze({
    "acpx@0.12.0": "patches/acpx@0.12.0.patch",
    "acpx@0.13.1": "patches/acpx@0.13.1.patch",
  });

  test("selects only the installed dependency version's patch", (t) => {
    const destinationDir = createTempDir(t, "paperclip-bundled-patch-selection-");
    writeFakeInstalledPackage(destinationDir, "acpx", "0.12.0");

    assert.deepEqual(
      selectBundledDependencyPatches(destinationDir, ["acpx"], configuredAcpxPatches),
      [
        {
          packageName: "acpx",
          specifier: "acpx@0.12.0",
          patchPath: "patches/acpx@0.12.0.patch",
        },
      ],
    );
  });

  test("handles scoped package names", (t) => {
    const destinationDir = createTempDir(t, "paperclip-scoped-patch-selection-");
    writeFakeInstalledPackage(destinationDir, "@example/runtime", "1.2.3");

    assert.deepEqual(
      selectBundledDependencyPatches(destinationDir, ["@example/runtime"], {
        "@example/runtime@1.2.3": "patches/runtime@1.2.3.patch",
        "@example/runtime@2.0.0": "patches/runtime@2.0.0.patch",
      }),
      [
        {
          packageName: "@example/runtime",
          specifier: "@example/runtime@1.2.3",
          patchPath: "patches/runtime@1.2.3.patch",
        },
      ],
    );
  });

  test("reports missing installed metadata", (t) => {
    const destinationDir = createTempDir(t, "paperclip-missing-patch-metadata-");

    assert.throws(
      () => selectBundledDependencyPatches(destinationDir, ["acpx"], configuredAcpxPatches),
      /Cannot select a patch for bundled dependency acpx: failed to read/,
    );
  });

  test("rejects an unpatched installed version", (t) => {
    const destinationDir = createTempDir(t, "paperclip-unmatched-patch-version-");
    writeFakeInstalledPackage(destinationDir, "acpx", "0.14.0");

    assert.throws(
      () => selectBundledDependencyPatches(destinationDir, ["acpx"], configuredAcpxPatches),
      /installed acpx@0\.14\.0, but configured patches are acpx@0\.12\.0, acpx@0\.13\.1/,
    );
  });
});

describe("End-to-End Staging & Release Scripts", () => {
  test("server package staging applies every bundled runtime patch and preserves the vendored runner", (t) => {
    const fixtureDir = createTempDir(t, "paperclip-bundled-stage-");
    const sourceDir = join(fixtureDir, "source");
    const destinationDir = join(fixtureDir, "destination");
    const binDir = join(fixtureDir, "bin");
    const callLog = join(fixtureDir, "calls.log");

    mkdirSync(join(sourceDir, "dist"), { recursive: true });
    mkdirSync(destinationDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });

    writeFileSync(join(sourceDir, "dist", "index.js"), "export {};\n");
    writeFileSync(
      join(sourceDir, "package.json"),
      JSON.stringify({ ...serverPackage, files: ["dist"] }),
    );
    writeFileSync(callLog, "");

    writeExecutable(binDir, "pnpm", [
      'printf "pnpm %s\\n" "$*" >> "$FAKE_CALL_LOG"',
      'destination="${!#}"',
      'cp "$FAKE_SOURCE_PACKAGE" "$destination/package.json"',
      'mkdir -p "$destination/node_modules/.pnpm"',
    ]);

    writeExecutable(binDir, "npm", [
      'printf "npm %s\\n" "$*" >> "$FAKE_CALL_LOG"',
      '[ "$*" = "install --omit=dev --ignore-scripts --no-audit --no-fund" ]',
      `node -e '
        const fs = require("node:fs");
        const pkg = require("./package.json");
        if ("devDependencies" in pkg) process.exit(1);
        for (const [name, version] of Object.entries(pkg.dependencies)) {
          const dir = "node_modules/" + name;
          fs.mkdirSync(dir + "/dist", { recursive: true });
          fs.writeFileSync(dir + "/package.json", JSON.stringify({ name, version }));
        }
      '`,
      "mkdir -p node_modules/acpx/dist",
      'printf "unpatched runtime\\n" > node_modules/acpx/dist/runtime.js',
      'printf \'{"name":"acpx","version":"0.13.1"}\\n\' > node_modules/acpx/package.json',
    ]);

    writeExecutable(binDir, "patch", [
      'printf "patch %s\\n" "$*" >> "$FAKE_CALL_LOG"',
      'target=""',
      'while [ "$#" -gt 0 ]; do',
      '  if [ "$1" = "-d" ]; then target="$2"; shift 2; else shift; fi',
      "done",
      'patch_input="$(cat)"',
      'printf "%s\\n" "$patch_input" > "$target/applied.patch"',
      'if [[ "$target" != */acpx ]]; then exit 0; fi',
      'grep -q spawnEnvironment <<< "$patch_input"',
      'grep -q spawnAgent <<< "$patch_input"',
      'grep -q onAgentStderr <<< "$patch_input"',
      'printf "patched spawnEnvironment runtime\\n" > "$target/dist/runtime.js"',
    ]);

    execFileSync(
      process.execPath,
      [resolvePath("./prepare-bundled-package.mjs"), sourceDir, destinationDir],
      {
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          FAKE_CALL_LOG: callLog,
          FAKE_SOURCE_PACKAGE: join(sourceDir, "package.json"),
        },
        stdio: "pipe",
      },
    );

    const stagedAcpxDir = join(destinationDir, "node_modules", "acpx");
    const stats = lstatSync(stagedAcpxDir);
    assert.equal(stats.isDirectory(), true);
    assert.equal(stats.isSymbolicLink(), false);
    assert.equal(existsSync(join(destinationDir, "node_modules", ".pnpm")), false);
    assert.match(readFileSync(join(stagedAcpxDir, "dist", "runtime.js"), "utf8"), /spawnEnvironment/);

    const loggedCalls = readFileSync(callLog, "utf8");
    assert.match(loggedCalls, /patch -p1 --forward -d .*node_modules\/acpx/);
    assert.equal(
      loggedCalls.split("\n").filter((line) => line.startsWith("patch ")).length,
      serverPackage.bundleDependencies.length,
    );

    for (const name of serverPackage.bundleDependencies) {
      const specifier = `${name}@${serverPackage.dependencies[name]}`;
      const patchPath = rootPackage.pnpm.patchedDependencies[specifier];
      const expectedPatch = `${readFileSync(resolvePath(`../${patchPath}`), "utf8").trimEnd()}\n`;
      const actualPatch = readFileSync(
        join(destinationDir, "node_modules", name, "applied.patch"),
        "utf8",
      );

      assert.equal(actualPatch, expectedPatch, `${specifier} receives its own full configured patch`);
    }
  });

  test("bundled package dry runs preview without querying published versions", () => {
    assert.match(releaseScript, /run_bundled_npm_pack pack --pack-destination "\$publish_dir"/);
    assert.match(releaseLib, /BUNDLED_NPM_PACK_VERSION="10\.9\.7"/);
    assert.match(releaseLib, /BUNDLED_NPM_PUBLISH_VERSION="11\.18\.0"/);
    assert.match(releaseLib, /npx --yes "npm@\$BUNDLED_NPM_PACK_VERSION" "\$@" --ignore-scripts/);
    assert.match(releaseLib, /npx --yes "npm@\$BUNDLED_NPM_PUBLISH_VERSION" "\$@" --ignore-scripts/);
    assert.match(releaseLib, /"\$@" --ignore-scripts --loglevel verbose/);
    assert.match(releaseLib, /run_bundled_npm_publish publish --tag "\$dist_tag"/);
    assert.doesNotMatch(releaseLib, /run_bundled_npm_publish publish "\.\/\$tarball"/);
  });

  test("npm builds use corepack instead of requiring a global pnpm", () => {
    assert.match(buildNpmScript, /corepack pnpm -r typecheck/);
    assert.doesNotMatch(buildNpmScript, /^\s*pnpm -r typecheck/m);
  });
});
