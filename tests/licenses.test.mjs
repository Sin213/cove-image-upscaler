// Deterministic integrity checks for the third-party license bundle.
// These assert file mapping and packaging wiring only - never legal interpretation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
const LICENSE_DIR = join(ROOT, 'resources', 'licenses');
const NOTICES = join(LICENSE_DIR, 'THIRD_PARTY_NOTICES.txt');

const notices = readFileSync(NOTICES, 'utf8');

/** Every `License text:  <path>` reference in the notice file. */
const referenced = [...notices.matchAll(/^\s*License text:\s+(\S+)/gm)].map((m) => m[1]);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

test('notice file is present and non-empty', () => {
  assert.ok(notices.trim().length > 0);
});

test('notice file references at least one license text per section', () => {
  assert.ok(referenced.length >= 30, `only ${referenced.length} license texts referenced`);
});

test('every referenced license path exists, is non-empty and stays inside the license dir', () => {
  for (const ref of referenced) {
    const full = resolve(LICENSE_DIR, ref);
    const rel = relative(LICENSE_DIR, full);
    assert.ok(rel && !rel.startsWith('..') && !rel.startsWith(sep), `escapes license dir: ${ref}`);
    assert.ok(statSync(full).size > 0, `empty license file: ${ref}`);
  }
});

test('every license file on disk is referenced by the notice file', () => {
  const onDisk = walk(LICENSE_DIR)
    .map((f) => relative(LICENSE_DIR, f).split(sep).join('/'))
    .filter((f) => f !== 'THIRD_PARTY_NOTICES.txt');
  const refSet = new Set(referenced.map((r) => r.split(sep).join('/')));
  // The upstream sharp-libvips notice is incorporated by name, not by a
  // "License text:" reference.
  refSet.add('sharp-libvips/THIRD-PARTY-NOTICES.md');
  for (const f of onDisk) assert.ok(refSet.has(f), `unreferenced license file: ${f}`);
});

/**
 * Package name -> version the notice must record, for every packaged target.
 * Cove ships Windows x64 and Linux x64 only; macOS is not a build target, so
 * no darwin sharp package is distributed and none is asserted here.
 */
const EXPECTED_PACKAGES = {
  sharp: '0.35.3',
  '@img/colour': '1.1.0',
  '@img/sharp-linux-x64': '0.35.3',
  '@img/sharp-libvips-linux-x64': '1.3.2',
  '@img/sharp-win32-x64': '0.35.3',
};

test('notice file records the exact shipped package versions', () => {
  for (const [name, version] of Object.entries(EXPECTED_PACKAGES)) {
    const row = new RegExp(`^\\s*${name.replace(/[/@-]/g, '\\$&')}\\s+${version.replace(/\./g, '\\.')}\\s`, 'm');
    assert.match(notices, row, `notice file does not record ${name} ${version}`);
  }
  assert.ok(notices.includes('libvips version 8.18.3'));
});

test('notice file covers every platform electron-builder targets', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  // Every configured platform must have its sharp packages named in the notice.
  const perPlatform = { linux: '@img/sharp-linux-x64', win: '@img/sharp-win32-x64' };
  for (const [platform, packageName] of Object.entries(perPlatform)) {
    if (!pkg.build[platform]) continue;
    assert.ok(notices.includes(packageName), `${platform} is a build target but ${packageName} is not in the notice`);
  }
});

test('notice file matches the installed sharp and libvips versions', () => {
  // Read the versions from sharp itself rather than from a platform-specific
  // @img package, so this runs on every supported target.
  const sharp = createRequire(import.meta.url)('sharp');
  assert.equal(EXPECTED_PACKAGES.sharp, sharp.versions.sharp);
  assert.ok(notices.includes(`libvips version ${sharp.versions.vips}`));
});

test('no license file leaks a local absolute or scratch path', () => {
  for (const file of walk(LICENSE_DIR)) {
    const text = readFileSync(file, 'utf8');
    for (const bad of ['/home/', 'Claude-Handoff', 'C:\\Users', '/tmp/']) {
      assert.ok(!text.includes(bad), `${relative(ROOT, file)} contains ${bad}`);
    }
  }
});

test('electron-builder packages the license directory into every target', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const entry = pkg.build.extraResources.find((r) => r.from === 'resources/licenses');
  assert.ok(entry, 'resources/licenses is not listed in build.extraResources');
  assert.equal(entry.to, 'licenses');
});
