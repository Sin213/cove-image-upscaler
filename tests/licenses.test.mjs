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
  assert.ok(referenced.length >= 41, `only ${referenced.length} license texts referenced`);
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

/**
 * AI payload projects the notice must cover, mapped to the license file that
 * must exist on disk and the substrings that file must contain. Substring
 * checks only - the license texts are copied verbatim from upstream and are
 * never snapshotted here.
 */
const EXPECTED_AI_LICENSES = {
  'realesrgan-ncnn-vulkan': {
    file: 'ai/realesrgan-ncnn-vulkan/LICENSE',
    contains: ['MIT', 'Xintao Wang', 'nihui'],
  },
  'Real-ESRGAN': {
    file: 'ai/real-esrgan/LICENSE',
    contains: ['BSD 3-Clause License', 'Xintao Wang'],
  },
  'realcugan-ncnn-vulkan': {
    file: 'ai/realcugan-ncnn-vulkan/LICENSE',
    contains: ['MIT', 'nihui'],
  },
  'Real-CUGAN': {
    file: 'ai/real-cugan/LICENSE',
    contains: ['MIT', 'bilibili'],
  },
  ncnn: {
    file: 'ai/ncnn/LICENSE.txt',
    contains: ['THL A29 Limited', 'BSD 3-Clause License'],
  },
};

test('every AI payload license file exists and is non-empty', () => {
  for (const [project, { file }] of Object.entries(EXPECTED_AI_LICENSES)) {
    const full = join(LICENSE_DIR, file);
    assert.ok(statSync(full).size > 0, `empty or missing license file for ${project}: ${file}`);
  }
});

test('each AI payload license file carries its expected identifier and copyright holder', () => {
  for (const [project, { file, contains }] of Object.entries(EXPECTED_AI_LICENSES)) {
    const text = readFileSync(join(LICENSE_DIR, file), 'utf8');
    for (const needle of contains) {
      assert.ok(text.includes(needle), `${file} (${project}) does not contain ${needle}`);
    }
  }
});

test('notice file names every AI payload project', () => {
  for (const project of Object.keys(EXPECTED_AI_LICENSES)) {
    assert.ok(notices.includes(project), `notice file does not name ${project}`);
  }
});

test('notice file records the exact distributed AI release tokens', () => {
  for (const token of ['v0.2.5.0', '20220424', '20220728']) {
    assert.ok(notices.includes(token), `notice file does not record release token ${token}`);
  }
});

/**
 * The bootstrap copies the complete upstream model directories and
 * build.extraResources packages resources/models wholesale, so the notice must
 * name every shipped model family - not only the ones the app invokes.
 */
test('notice file names every shipped model family, not only the ones used at runtime', () => {
  for (const family of [
    'realesrgan-x4plus',
    'realesrgan-x4plus-anime',
    'realesr-animevideov3',
    'models-se',
    'models-pro',
    'models-nose',
  ]) {
    assert.ok(notices.includes(family), `notice file does not name shipped model family ${family}`);
  }
});

test('notice file records that ncnn is statically linked into both executables', () => {
  assert.match(notices, /ncnn/);
  assert.match(notices, /statically linked/i);
  assert.match(notices, /both\s+(AI\s+)?executables/i);
});

test('notice file records vcomp140.dll and that no debug runtime is distributed', () => {
  assert.ok(notices.includes('vcomp140.dll'), 'notice file does not mention vcomp140.dll');
  assert.match(notices, /no debug runtime is distributed/i);
  assert.ok(!notices.includes('vcomp140d.dll'), 'notice file must not describe a distributed debug runtime');
});

test('notice file carries no stale macOS content', () => {
  for (const token of ['darwin', 'macOS', '.dmg', 'app bundle']) {
    assert.ok(!notices.includes(token), `notice file still contains macOS token: ${token}`);
  }
});

test('the absolute-path leak check covers the AI license directory', () => {
  const aiFiles = walk(join(LICENSE_DIR, 'ai')).map((f) => relative(LICENSE_DIR, f).split(sep).join('/'));
  assert.ok(aiFiles.length >= Object.keys(EXPECTED_AI_LICENSES).length);
  const walked = walk(LICENSE_DIR).map((f) => relative(LICENSE_DIR, f).split(sep).join('/'));
  for (const f of aiFiles) assert.ok(walked.includes(f), `leak walk misses ${f}`);
});

test('electron-builder packages the license directory into every target', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const entry = pkg.build.extraResources.find((r) => r.from === 'resources/licenses');
  assert.ok(entry, 'resources/licenses is not listed in build.extraResources');
  assert.equal(entry.to, 'licenses');
});
