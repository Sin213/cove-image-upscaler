// Navigation-deny contract for the main window.
//
// The renderer is local: only the packaged dist directory and the configured
// Vite dev origin may be navigated to. Everything else fails closed.

import test from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { isNavigationAllowed } = require("../dist-electron/navigation-policy.js");

const APP_DIST = path.resolve("/opt/cove/resources/app.asar/dist");
const INDEX_URL = pathToFileURL(path.join(APP_DIST, "index.html")).href;
const DEV_URL = "http://localhost:5173";

test("the packaged application's own dist file URL is allowed", () => {
  assert.equal(isNavigationAllowed({ targetUrl: INDEX_URL, appDistDir: APP_DIST }), true);
});

test("an unrelated local file URL is denied", () => {
  assert.equal(
    isNavigationAllowed({ targetUrl: "file:///etc/passwd", appDistDir: APP_DIST }),
    false,
  );
});

test("the configured development origin is allowed only when supplied", () => {
  assert.equal(
    isNavigationAllowed({
      targetUrl: `${DEV_URL}/index.html`,
      appDistDir: APP_DIST,
      devServerUrl: DEV_URL,
    }),
    true,
  );
  assert.equal(
    isNavigationAllowed({ targetUrl: `${DEV_URL}/index.html`, appDistDir: APP_DIST }),
    false,
  );
});

test("a different localhost port is denied", () => {
  assert.equal(
    isNavigationAllowed({
      targetUrl: "http://localhost:5174/index.html",
      appDistDir: APP_DIST,
      devServerUrl: DEV_URL,
    }),
    false,
  );
});

test("an external https origin is denied", () => {
  assert.equal(
    isNavigationAllowed({
      targetUrl: "https://evil.test",
      appDistDir: APP_DIST,
      devServerUrl: DEV_URL,
    }),
    false,
  );
});

test("a javascript: URL is denied", () => {
  assert.equal(
    isNavigationAllowed({
      targetUrl: "javascript:alert(1)",
      appDistDir: APP_DIST,
      devServerUrl: DEV_URL,
    }),
    false,
  );
});

test("a data: URL is denied", () => {
  assert.equal(
    isNavigationAllowed({
      targetUrl: "data:text/html,<script>alert(1)</script>",
      appDistDir: APP_DIST,
      devServerUrl: DEV_URL,
    }),
    false,
  );
});

test("an invalid URL string fails closed rather than throwing", () => {
  assert.equal(isNavigationAllowed({ targetUrl: "not a url", appDistDir: APP_DIST }), false);
  assert.equal(isNavigationAllowed({ targetUrl: "", appDistDir: APP_DIST }), false);
});

test("a dist-relative traversal escaping the dist directory is denied", () => {
  const escaped = pathToFileURL(path.join(APP_DIST, "..", "secret.html")).href;
  assert.equal(isNavigationAllowed({ targetUrl: escaped, appDistDir: APP_DIST }), false);
});
