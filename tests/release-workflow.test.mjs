// Structural guards for the 2.2.0 release scope.
//
// Two things must stay true and neither is observable from unit tests of the
// bootstrap itself:
//
//   1. Release packaging is gated on a *strict* AI payload bootstrap. A
//      network or upstream failure must stop the run before electron-builder,
//      never produce installers where Photo and Anime mode are missing their
//      executables or models while Pixel mode still works.
//   2. macOS is not a build, bootstrap or release target.
//
// GitHub Actions cannot run locally here, so the workflow is asserted by
// structure (ordering and shell tolerance), not by a snapshot of its text.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const WORKFLOW = path.join(ROOT, ".github", "workflows", "release.yml");

const workflow = readFileSync(WORKFLOW, "utf8");
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));

/**
 * Text of one top-level job block, from its key to the next job key, with
 * comment lines dropped so ordering assertions read the executed steps rather
 * than prose that happens to name a command.
 */
function job(name) {
  const keys = [...workflow.matchAll(/^ {2}([A-Za-z0-9_-]+):$/gm)];
  const start = keys.find((m) => m[1] === name);
  assert.ok(start, `release.yml has no job named ${name}`);
  const next = keys.find((m) => m.index > start.index);
  return workflow
    .slice(start.index, next ? next.index : workflow.length)
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

// ---------------------------------------------------------------------------
// mandatory release payload gate
// ---------------------------------------------------------------------------

test("package.json exposes a strict per-platform release payload gate", () => {
  assert.equal(pkg.scripts["release:payload"], "node scripts/download-binaries.mjs");
  assert.equal(pkg.scripts["release:payload:win"], "node scripts/download-binaries.mjs win");
  assert.equal(pkg.scripts["release:payload:linux"], "node scripts/download-binaries.mjs linux");
});

test("every production packaging script runs the payload gate before electron-builder", () => {
  const gated = {
    dist: "release:payload",
    "dist:linux": "release:payload:linux",
    "dist:linux:full": "release:payload:linux",
    "dist:win": "release:payload:win",
    "dist:win:portable": "release:payload:win",
  };
  for (const [script, gate] of Object.entries(gated)) {
    const body = pkg.scripts[script];
    assert.ok(body, `package.json has no ${script} script`);
    assert.ok(
      body.startsWith(`npm run ${gate} && `),
      `${script} must start with "npm run ${gate} && ", got: ${body}`,
    );
    assert.ok(
      body.indexOf(gate) < body.indexOf("electron-builder"),
      `${script} runs electron-builder before its payload gate`,
    );
  }
});

test("the release script gates both shipped platforms before packaging", () => {
  const body = pkg.scripts.release;
  assert.ok(body, "package.json has no release script");
  for (const gate of ["release:payload:linux", "release:payload:win"]) {
    assert.ok(body.includes(`npm run ${gate}`), `release does not run ${gate}`);
    assert.ok(
      body.indexOf(gate) < body.indexOf("electron-builder"),
      `release runs electron-builder before ${gate}`,
    );
  }
});

test("no packaging script tolerates a failed payload gate", () => {
  for (const [name, body] of Object.entries(pkg.scripts)) {
    if (!body.includes("download-binaries") && !body.includes("release:payload")) continue;
    if (name === "postinstall") continue; // development install stays tolerant
    assert.ok(!body.includes("|| true"), `${name} tolerates gate failure: ${body}`);
    assert.ok(!body.includes("|| echo"), `${name} tolerates gate failure: ${body}`);
    assert.ok(!body.includes("; "), `${name} sequences past a failed gate: ${body}`);
  }
});

test("development postinstall stays tolerant and generic commands stay payload-free", () => {
  // Ordinary `npm install` must not hard-fail on a download outage.
  assert.match(pkg.scripts.postinstall, /download-binaries\.mjs \|\| echo/);
  // ...and no generic build/test command may drag in hundreds of MB.
  for (const name of ["build", "build:renderer", "build:electron", "typecheck", "test"]) {
    assert.ok(
      !pkg.scripts[name].includes("download-binaries") &&
        !pkg.scripts[name].includes("release:payload"),
      `${name} must not invoke the payload bootstrap`,
    );
  }
});

test("each release job runs its own strict platform bootstrap before packaging", () => {
  const cases = [
    ["build-linux", "npm run release:payload:linux"],
    ["build-windows", "npm run release:payload:win"],
  ];
  for (const [name, gate] of cases) {
    const body = job(name);
    assert.ok(body.includes(gate), `${name} does not run ${gate}`);
    assert.ok(
      body.indexOf(gate) < body.indexOf("electron-builder"),
      `${name} reaches electron-builder before ${gate}`,
    );
  }
});

test("the release workflow bootstraps exactly one platform per job", () => {
  assert.ok(!workflow.includes("--all"), "release CI must not download every platform payload");
  assert.ok(!job("build-linux").includes("release:payload:win"));
  assert.ok(!job("build-windows").includes("release:payload:linux"));
});

test("no release step tolerates a nonzero exit", () => {
  for (const tolerant of ["continue-on-error", "|| true", "|| echo"]) {
    assert.ok(!workflow.includes(tolerant), `release.yml uses ${tolerant}`);
  }
});

// ---------------------------------------------------------------------------
// negative proof: a failing gate never reaches packaging
// ---------------------------------------------------------------------------

test("a nonzero payload gate stops the npm script chain before packaging", async () => {
  // Runs the real npm script runner over the same `gate && package` shape the
  // dist scripts use, with the gate stubbed to fail. Proves the composition,
  // without touching the real payload tree.
  const dir = mkdtempSync(path.join(tmpdir(), "cove-gate-"));
  try {
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({
        name: "gate-fixture",
        version: "0.0.0",
        private: true,
        scripts: {
          "release:payload:linux": 'node -e "process.exit(1)"',
          package: `node -e "require('fs').writeFileSync('packaged.txt','x')"`,
          "dist:linux": "npm run release:payload:linux && npm run package",
        },
      }),
    );

    const result = await new Promise((resolve) => {
      execFile(
        process.platform === "win32" ? "npm.cmd" : "npm",
        ["run", "dist:linux"],
        { cwd: dir },
        (err) => resolve({ code: err ? (err.code ?? 1) : 0 }),
      );
    });

    assert.notEqual(result.code, 0, "a failed payload gate must fail the packaging script");
    assert.ok(
      !existsSync(path.join(dir, "packaged.txt")),
      "packaging ran even though the payload gate failed",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// macOS is out of scope
// ---------------------------------------------------------------------------

test("no macOS packaging configuration remains", () => {
  assert.equal(pkg.build.mac, undefined, "build.mac is still configured");
  assert.equal(pkg.build.dmg, undefined, "build.dmg is still configured");
  assert.equal(pkg.build.mas, undefined, "build.mas is still configured");
  assert.equal(pkg.build.afterSign, undefined, "notarization hook is still configured");
  assert.deepEqual(
    Object.keys(pkg.scripts).filter((s) => /mac$/.test(s) || /:mac:/.test(s)),
    [],
    "a macOS script is still defined",
  );
  for (const [name, body] of Object.entries(pkg.scripts)) {
    assert.ok(!body.includes("--mac"), `${name} still builds for macOS`);
  }
});

test("no default production command builds macOS", () => {
  // Bare `electron-builder` targets the host platform. Every such script is
  // gated on the host bootstrap first, which refuses an unsupported host, so
  // a macOS checkout cannot reach packaging at all.
  for (const [name, body] of Object.entries(pkg.scripts)) {
    if (!body.includes("electron-builder")) continue;
    if (/--(win|linux)\b/.test(body)) continue;
    assert.ok(
      body.startsWith("npm run release:payload && "),
      `${name} reaches host packaging without a host payload gate: ${body}`,
    );
  }
});

test("macOS is absent from the release matrix", () => {
  for (const token of ["macos", "macOS", "darwin", "--mac", "dmg", "Apple"]) {
    assert.ok(!workflow.includes(token), `release.yml still references ${token}`);
  }
});

// ---------------------------------------------------------------------------
// Debian runtime dependencies
// ---------------------------------------------------------------------------

test("the Debian package declares the Vulkan loader the AI executables need", () => {
  // The bundled NCNN executables link against libvulkan.so.1. Without an
  // explicit dependency the .deb installs cleanly and Photo and Anime mode
  // then fail at launch while Pixel mode keeps working.
  const depends = pkg.build?.deb?.depends;
  assert.ok(Array.isArray(depends), "build.deb.depends is not configured as an array");
  assert.ok(depends.includes("libvulkan1"), "build.deb.depends is missing libvulkan1");
});

test("declaring libvulkan1 does not drop electron-builder's stock Debian dependencies", () => {
  // An explicit depends array replaces the defaults rather than extending
  // them, so the stock runtime requirements have to be restated.
  const depends = pkg.build.deb.depends;
  for (const stock of ["libgtk-3-0", "libnotify4", "libnss3", "libxss1", "libxtst6", "xdg-utils", "libatspi2.0-0", "libuuid1", "libsecret-1-0"]) {
    assert.ok(depends.includes(stock), `build.deb.depends dropped stock dependency ${stock}`);
  }
});

test("no GPU vendor driver package is declared", () => {
  // The package declares the loader only. Vendor ICDs stay the OS's job.
  for (const banned of ["mesa", "nvidia", "amdgpu", "vulkan-sdk", "-dev"]) {
    for (const dep of pkg.build.deb.depends) {
      assert.ok(!dep.includes(banned), `build.deb.depends declares a GPU/driver package: ${dep}`);
    }
  }
});

// ---------------------------------------------------------------------------
// blockmap checksum sidecars
// ---------------------------------------------------------------------------

test("both release jobs checksum .blockmap assets", () => {
  for (const name of ["build-linux", "build-windows"]) {
    const body = job(name);
    const loop = body.match(/for f in ([^;]+); do/);
    assert.ok(loop, `${name} job has no sidecar loop`);
    assert.ok(
      loop[1].includes("*.blockmap"),
      `${name} sidecar loop does not cover *.blockmap: ${loop[1].trim()}`,
    );
  }
});

test("each release asset keeps its own .sha256 sidecar", () => {
  for (const name of ["build-linux", "build-windows"]) {
    assert.ok(
      job(name).includes('sha256sum "$f" > "$f.sha256"'),
      `${name} job no longer writes an individual sidecar per asset`,
    );
  }
  assert.ok(
    !workflow.includes("checksums-sha256"),
    "release.yml introduces a combined checksum manifest",
  );
});

// ---------------------------------------------------------------------------
// updater dependency floor
// ---------------------------------------------------------------------------

test("electron-updater is pinned to a release with the 6.8.9 fixes", () => {
  assert.equal(pkg.dependencies["electron-updater"], "^6.8.9");
});
