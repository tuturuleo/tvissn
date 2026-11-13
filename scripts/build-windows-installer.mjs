import { readFile, writeFile, readdir, mkdir, access, rm } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { unzipSync } from "fflate";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));

async function main() {
  const release = await readJson("extension/release.json");
  let manifest;
  try {
    manifest = await readJson("extension-dist/manifest.json");
  } catch {
    throw new Error("Missing prepared extension-dist/manifest.json. Run npm run build first.");
  }
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(release.version) ||
      release.version.split(".").some((n) => Number(n) > 65535) ||
      manifest.version !== release.version) {
    throw new Error("extension-dist/manifest.json version must match extension/release.json. Run npm run build.");
  }
  const identity = await readJson("extension/identity.json");
  if (manifest.key !== identity.key) throw new Error("Prepared extension has a different identity key.");
  const metadata = await readJson("dist/extension/latest.json");
  const archive = await readFile("dist/extension/tvissn-extension.zip");
  if (Object.entries(release).some(([key, value]) => metadata[key] !== value) ||
      metadata.sha256 !== sha256(archive) ||
      metadata.extensionId !== identity.id) {
    throw new Error("ZIP/latest.json do not match the prepared release. Run npm run build.");
  }
  const files = [];
  async function collect(dir, prefix = "") {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const name = prefix + entry.name;
      // These names are embedded into Inno Setup source, not evaluated as code.
      if (!/^[a-zA-Z0-9_. /-]+$/.test(name)) throw new Error(`Unsupported package filename: ${name}`);
      if (entry.isDirectory()) await collect(join(dir, entry.name), name + "/");
      else if (entry.isFile()) files.push(name);
      else throw new Error(`Unsupported package entry: ${name}`);
    }
  }
  await collect("extension-dist");
  files.sort();
  const zipped = unzipSync(archive);
  const zippedFiles = Object.keys(zipped).filter((name) => !name.endsWith("/")).sort();
  if (JSON.stringify(files) !== JSON.stringify(zippedFiles)) throw new Error("ZIP and extension-dist contain different files.");
  const payload = new Map();
  for (const name of files) {
    const data = await readFile(join("extension-dist", name));
    if (sha256(data) !== sha256(zipped[name])) throw new Error(`ZIP content mismatch: ${name}`);
    payload.set(name, sha256(data));
  }

  const candidates = process.env.ISCC_PATH ? [process.env.ISCC_PATH] : [
    "ISCC.exe",
    ...[process.env["ProgramFiles(x86)"], process.env.ProgramFiles, process.env.LOCALAPPDATA]
      .filter(Boolean).map((dir) => join(dir, "Inno Setup 6", "ISCC.exe")),
  ];
  const compiler = candidates.find((candidate) => {
    const result = spawnSync(candidate, ["/?"], { stdio: "ignore", windowsHide: true });
    return !result.error && result.status === 0;
  });
  if (!compiler) throw new Error("Inno Setup compiler not found. Install Inno Setup 6 locally or set ISCC_PATH to ISCC.exe. No tools are downloaded by this script.");

  const generated = resolve("dist/installer");
  await mkdir(generated, { recursive: true });
  const entries = files.map((name) => {
    const parent = dirname(name).replaceAll("/", "\\");
    return `Source: "{#ExtensionDir}\\${name.replaceAll("/", "\\")}"; DestDir: "{app}${parent === "." ? "" : "\\" + parent}"; Flags: ignoreversion`;
  });
  await writeFile(join(generated, "package-files.iss"), entries.join("\n") + "\n");
  const checks = [...payload].map(([name, hash]) => {
    const target = `ExpandConstant('{app}\\${name.replaceAll("/", "\\")}')`;
    return `  if not FileExists(${target}) then RaiseException('Missing installed file: ${name}');\n  if CompareText(GetSHA256OfFile(${target}), '${hash}') <> 0 then RaiseException('Failed to write installed file: ${name}');`;
  });
  await writeFile(join(generated, "verify-files.iss"),
    "procedure VerifyInstalledFiles;\nbegin\n" + checks.join("\n") + "\nend;\n");
  const output = resolve("dist/extension/tvissn-extension-setup.exe");
  await rm(output, { force: true });
  const result = spawnSync(compiler, [
    `/DAppVersion=${release.version}`,
    `/DExtensionDir=${resolve("extension-dist")}`,
    `/DGeneratedDir=${generated}`,
    `/DOutputDir=${resolve("dist/extension")}`,
    resolve("installer/windows/tvissn.iss"),
  ], { stdio: "inherit", windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`Inno Setup compilation failed: ${result.error?.message ?? result.status}`);
  await access(output);
  // Keep all existing ZIP metadata; the Windows job adds only installer metadata.
  metadata.windowsInstaller = {
    fileName: "tvissn-extension-setup.exe",
    sha256: sha256(await readFile(output)),
  };
  await writeFile("dist/extension/latest.json", JSON.stringify(metadata, null, 2) + "\n");
  console.log(`Built ${output} (version ${release.version})`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
