import { readFile, writeFile, readdir, mkdir, access, rm, stat } from "node:fs/promises";
import { resolve, join, dirname, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { unzipSync } from "fflate";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));

// A help invocation need not return zero, so only the file is resolved here;
// the actual compilation reports launch errors and compiler failures. Every
// candidate is recorded with its verdict so a CI log shows why none matched.
async function findCompiler() {
  const checked = [];
  const check = async (path, from) => {
    try {
      const info = await stat(path);
      if (info.isFile()) {
        checked.push({ path, from, verdict: "found" });
        return true;
      }
      checked.push({ path, from, verdict: "rejected: not a regular file" });
    } catch (error) {
      checked.push({ path, from, verdict: `rejected: ${error.code ?? error.message}` });
    }
    return false;
  };
  const explicit = process.env.ISCC_PATH?.trim();
  if (explicit) {
    // Quotes copied from a shell/GITHUB_ENV line are not part of a Windows path.
    const path = explicit.replace(/^"(.*)"$/, "$1");
    return { compiler: await check(path, "ISCC_PATH") ? path : undefined, source: "ISCC_PATH", checked };
  }
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const trimmed = dir.trim().replace(/^"(.*)"$/, "$1");
    if (!trimmed) continue;
    const path = resolve(trimmed, "ISCC.exe");
    if (await check(path, "PATH")) return { compiler: path, source: "PATH", checked };
  }
  for (const name of ["ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"]) {
    if (!process.env[name]) continue;
    const path = join(process.env[name], "Inno Setup 6", "ISCC.exe");
    if (await check(path, name)) return { compiler: path, source: name, checked };
  }
  return { compiler: undefined, source: undefined, checked };
}

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

  const { compiler, source, checked } = await findCompiler();
  if (!compiler) {
    throw new Error("Inno Setup compiler not found. Install Inno Setup 6 locally or set ISCC_PATH to ISCC.exe. No tools are downloaded by this script.\n" +
      (checked.length ? "Checked candidates:\n" + checked.map(({ path, from, verdict }) => `  - ${path} (${from}): ${verdict}`).join("\n") :
        "No candidates: ISCC_PATH, PATH, ProgramFiles(x86), ProgramFiles and LOCALAPPDATA are empty."));
  }
  for (const { path, from, verdict } of checked) console.log(`Inno Setup candidate (${from}): ${path} -> ${verdict}`);
  console.log(`Using Inno Setup compiler: ${compiler} (${source})`);

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
  const outputDir = resolve("dist/extension");
  const args = [
    `/DAppVersion=${release.version}`,
    `/DExtensionDir=${resolve("extension-dist")}`,
    `/DGeneratedDir=${generated}`,
    `/DOutputDir=${outputDir}`,
    resolve("installer/windows/tvissn.iss"),
  ];
  // No shell: each argument reaches ISCC as one argv entry even with spaces.
  // The quoted form below is only for the log.
  console.log(`Running: ${[compiler, ...args].map((arg) => /[\s"]/.test(arg) ? `"${arg}"` : arg).join(" ")}`);
  const result = spawnSync(compiler, args, { stdio: "inherit", windowsHide: true });
  if (result.error) {
    throw new Error(`Inno Setup compilation failed: ${result.error.message}` +
      ` (launch error${result.error.code ? " " + result.error.code : ""}, compiler ${compiler})`);
  }
  if (result.status !== 0) {
    throw new Error(`Inno Setup compilation failed: ${result.signal ? `signal ${result.signal}` : `exit code ${result.status}`}` +
      ` (compiler ${compiler})`);
  }
  console.log("ISCC exit code: 0");
  try {
    await access(output);
  } catch {
    const present = await readdir(outputDir).catch((error) => [`<unreadable: ${error.code ?? error.message}>`]);
    throw new Error(`ISCC exited with 0 but did not produce ${output}. ${outputDir} contains: ${present.join(", ") || "<empty>"}`);
  }
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
