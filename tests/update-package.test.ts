import test from "node:test";
import assert from "node:assert/strict";
import { selectUpdatePackage } from "../extension/src/update-package";

const base = "https://github.com/tuturuleo/tvissn/releases/download/extension-v0.2.1.2/";
const zip = { name: "tvissn-extension.zip", browser_download_url: base + "tvissn-extension.zip" };
const exe = { name: "tvissn-extension-setup.exe", browser_download_url: base + "tvissn-extension-setup.exe" };

test("Windows selects the EXE even when ZIP comes first", () => {
  assert.deepEqual(selectUpdatePackage([zip, exe], "win"), {
    downloadUrl: exe.browser_download_url, packageType: "exe",
  });
});

test("other platforms select ZIP even when an EXE is available", () => {
  for (const os of ["mac", "linux", "cros", "android", "openbsd"]) {
    assert.deepEqual(selectUpdatePackage([exe, zip], os), {
      downloadUrl: zip.browser_download_url, packageType: "zip",
    });
    assert.equal(selectUpdatePackage([exe], os), null);
  }
});

test("Windows supports old ZIP-only releases", () => {
  assert.deepEqual(selectUpdatePackage([zip], "win"), {
    downloadUrl: zip.browser_download_url, packageType: "zip",
  });
});

test("untrusted and malformed URLs are never selected", () => {
  for (const url of [
    "https://evil.example/tvissn-extension-setup.exe",
    exe.browser_download_url.replace("github.com", "github.com.evil.example"),
    exe.browser_download_url.replace("https:", "http:"),
    exe.browser_download_url.replace("tuturuleo/tvissn", "someone/else"),
    exe.browser_download_url.replace("github.com", "user:pass@github.com"),
    exe.browser_download_url + "?redirect=elsewhere",
    exe.browser_download_url + "#fragment",
    base + "other.exe",
    "javascript:alert(1)", "not a URL",
  ]) {
    const unsafe = { ...exe, browser_download_url: url };
    assert.equal(selectUpdatePackage([unsafe], "win"), null, url);
    assert.deepEqual(selectUpdatePackage([unsafe, zip], "win"), {
      downloadUrl: zip.browser_download_url, packageType: "zip",
    }, "invalid EXE falls back to safe ZIP");
  }
  assert.equal(selectUpdatePackage([{ ...zip, browser_download_url: "https://evil.example/file.zip" }], "linux"), null);
  for (const assets of [null, {}, [null, {}, { name: zip.name }]]) {
    assert.equal(selectUpdatePackage(assets, "win"), null);
  }
});
