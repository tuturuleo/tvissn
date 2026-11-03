import { build } from "esbuild";
import { zipSync } from "fflate";
import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
const identity = JSON.parse(await readFile("extension/identity.json", "utf8"));
const release = JSON.parse(await readFile("extension/release.json", "utf8"));
const out = resolve("extension-dist");
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const keyId = [
  ...createHash("sha256")
    .update(Buffer.from(identity.key, "base64"))
    .digest()
    .subarray(0, 16),
]
  .flatMap((b) => [b >> 4, b & 15])
  .map((n) => String.fromCharCode(97 + n))
  .join("");
if (keyId !== identity.id)
  throw new Error("Stable extension ID does not match its public key");
if (
  !/^\d+\.\d+\.\d+\.\d+$/.test(release.version) ||
  release.version.split(".").some((n) => Number(n) > 65535)
)
  throw new Error("Invalid Chrome version");
const manifest = {
  manifest_version: 3,
  name: "tvissn — смотрим вместе",
  description: "Совместный просмотр на сайтах с плавающим виджетом tvissn.",
  version: release.version,
  minimum_chrome_version: "116",
  key: identity.key,
  permissions: ["storage", "activeTab", "scripting", "clipboardWrite", "offscreen", "downloads"],
  optional_host_permissions: ["https://*/*", "http://*/*"],
  action: { default_title: "tvissn", default_popup: "popup.html" },
  background: { service_worker: "background.js", type: "module" },
  content_security_policy: {
    extension_pages: "script-src 'self'; object-src 'self'",
  },
};
await writeFile(
  out + "/manifest.json",
  JSON.stringify(manifest, null, 2) + "\n",
);
await build({
  entryPoints: ["extension/src/background.ts"],
  outfile: out + "/background.js",
  bundle: true,
  format: "esm",
  target: "chrome116",
  minify: true,
});
await build({entryPoints:["extension/src/offscreen.ts"],outfile:out+"/offscreen.js",bundle:true,format:"iife",target:"chrome116",minify:true});
await writeFile(out+"/offscreen.html",'<!doctype html><html><head><meta charset="utf-8"><title>P2P connection</title></head><body><script src="offscreen.js"></script></body></html>');
await build({
  entryPoints: ["extension/src/content.ts"],
  outfile: out + "/content.js",
  bundle: true,
  format: "iife",
  target: "chrome116",
  minify: true,
});
await build({
  entryPoints: ["extension/src/popup.tsx"],
  outfile: out + "/popup.js",
  bundle: true,
  format: "iife",
  target: "chrome116",
  jsx: "automatic",
  minify: true,
  alias: { "@": resolve("src") },
  define: { "process.env.NODE_ENV": '"production"' },
});
const cssFiles = (await readdir("dist/assets")).filter((n) =>
  n.endsWith(".css"),
);
let css = "";
for (const f of cssFiles) css += await readFile("dist/assets/" + f, "utf8");
css +=
  "\nbody{width:380px;min-height:180px;margin:0}.extension-root{width:380px;background:#09090b;color:#fafafa}.extension-header{padding:17px 20px;border-bottom:1px solid #27272a;display:flex;align-items:center;justify-content:space-between}.extension-header strong{font-size:20px;letter-spacing:-.7px}.extension-update{margin:16px 20px 0;padding:14px;border:1px solid #486351;background:#18251d;border-radius:9px;font-size:12px}.extension-update p{color:#b2c3b6;font-size:11px;line-height:1.7;margin:8px 0 12px}.extension-footer{border-top:1px solid #27272a;padding:8px 14px 8px 20px;display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:10px;color:#a1a1aa}";
await writeFile(out + "/popup.css", css);
await writeFile(
  out + "/popup.html",
  '<!doctype html><html lang="ru" class="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>tvissn</title><link rel="stylesheet" href="popup.css"></head><body><div id="root"></div><script src="popup.js"></script></body></html>',
);
await writeFile(
  out + "/INSTALL.txt",
  `tvissn ${release.version}\nID: ${identity.id}\n\nChrome/Chromium: extract the ZIP to a permanent folder; open chrome://extensions, enable Developer mode and choose Load unpacked. Select this folder.\n\nUpdate: replace the contents of the SAME folder with the new ZIP, then click Reload on chrome://extensions. Do not delete the extension. Its ID and settings remain stable.\n`,
);
await writeFile(out + "/LUCIDE-LICENSE.txt", await readFile("node_modules/lucide/LICENSE", "utf8"));
const files = {};
for (const name of (await readdir(out)).sort())
  files[name] = [
    new Uint8Array(await readFile(out + "/" + name)),
    { mtime: new Date(2020, 0, 1, 0, 0, 0) },
  ];
const archive = zipSync(files, { level: 9 });
const destination = "dist/extension";
await mkdir(destination, { recursive: true });
await writeFile(destination + "/tvissn-extension.zip", archive);
const sha256 = createHash("sha256").update(archive).digest("hex");
await writeFile(
  destination + "/latest.json",
  JSON.stringify(
    {
      ...release,
      extensionId: identity.id,
      sha256,
      downloadPath: "/extension/tvissn-extension.zip",
    },
    null,
    2,
  ) + "\n",
);
console.log(
  JSON.stringify({
    version: release.version,
    extensionId: identity.id,
    bytes: archive.length,
    sha256,
  }),
);
