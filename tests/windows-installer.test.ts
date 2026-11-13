import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, readFile, copyFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { zipSync } from "fflate";
import identity from "../extension/identity.json";

type InvokeOptions = { env?: NodeJS.ProcessEnv; imports?: string[] };

// Isolated fixtures exercise the actual packaging script, without a Windows
// compiler and without changing this checkout's release metadata or payload.
async function fixture(run: (root: string, invoke: (options?: InvokeOptions) => ReturnType<typeof spawnSync>) => Promise<void>) {
  await mkdir("dist", { recursive: true });
  const root = await mkdtemp(resolve("dist/installer-test-"));
  try {
    for (const dir of ["scripts", "extension", "extension-dist", "dist/extension"]) {
      await mkdir(join(root, dir), { recursive: true });
    }
    await copyFile("scripts/build-windows-installer.mjs", join(root, "scripts/build-windows-installer.mjs"));
    const manifest = JSON.stringify({ version: "0.2.1.2", key: identity.key });
    const archive = zipSync({ "manifest.json": new TextEncoder().encode(manifest) });
    await writeFile(join(root, "extension/identity.json"), JSON.stringify(identity));
    await writeFile(join(root, "extension/release.json"), JSON.stringify({ version: "0.2.1.2" }));
    await writeFile(join(root, "extension-dist/manifest.json"), manifest);
    await writeFile(join(root, "dist/extension/tvissn-extension.zip"), archive);
    await writeFile(join(root, "dist/extension/latest.json"), JSON.stringify({
      version: "0.2.1.2", extensionId: identity.id,
      sha256: createHash("sha256").update(archive).digest("hex"),
    }));
    await run(root, (options = {}) => spawnSync(process.execPath, [
      ...(options.imports ?? []).flatMap((file) => ["--import", file]),
      join(root, "scripts/build-windows-installer.mjs"),
    ], {
      encoding: "utf8",
      env: { ...process.env, ISCC_PATH: join(root, "missing-compiler.exe"), ...options.env },
    }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// A preload replaces only the compiler process; packaging, file discovery and
// metadata updates still run in the copied script with real fixture files.
async function controlledCompiler(root: string, mode = "success"): Promise<InvokeOptions> {
  const compiler = join(root, "Inno Setup 6", "ISCC.exe");
  const preload = join(root, "compiler-mock.mjs");
  await mkdir(join(root, "Inno Setup 6"));
  await writeFile(compiler, "controlled compiler");
  await writeFile(preload, `
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const root = ${JSON.stringify(root)};
const compiler = ${JSON.stringify(compiler)};
const calls = [];
childProcess.spawnSync = (command, args, options) => {
  calls.push({ command, args, options });
  writeFileSync(join(root, "compiler-calls.json"), JSON.stringify(calls));
  if (command !== compiler) throw new Error("Unexpected compiler: " + command);
  if (args[0] === "/?") return { status: 1 };
  if (${JSON.stringify(mode)} === "launch-error") return { error: new Error("spawn EACCES"), status: null };
  if (${JSON.stringify(mode)} === "failure") return { status: 2, signal: null };
  if (${JSON.stringify(mode)} === "signal") return { status: null, signal: "SIGTERM" };
  if (${JSON.stringify(mode)} !== "missing-output") {
    const outputDir = args.find((arg) => arg.startsWith("/DOutputDir=")).slice("/DOutputDir=".length);
    writeFileSync(join(outputDir, "tvissn-extension-setup.exe"), "controlled installer bytes");
  }
  return { status: 0 };
};
syncBuiltinESMExports();
`);
  return { env: { ISCC_PATH: compiler }, imports: [pathToFileURL(preload).href] };
}

test("installer compiles with a compiler whose help returns nonzero and preserves ZIP metadata", async () => {
  await fixture(async (root, invoke) => {
    const options = await controlledCompiler(root);
    const latestPath = join(root, "dist/extension/latest.json");
    const metadata = JSON.parse(await readFile(latestPath, "utf8"));
    metadata.sourceCommit = "fixture-commit";
    metadata.extra = { preserved: true };
    await writeFile(latestPath, JSON.stringify(metadata));
    const result = invoke(options);
    assert.equal(result.status, 0, String(result.stderr));
    const stdout = String(result.stdout);
    assert.ok(stdout.includes(`Inno Setup candidate (ISCC_PATH): ${options.env!.ISCC_PATH} -> found`), stdout);
    assert.ok(stdout.includes(`Using Inno Setup compiler: ${options.env!.ISCC_PATH} (ISCC_PATH)`), stdout);
    // The logged command quotes arguments with spaces exactly like a shell would need.
    assert.ok(stdout.includes(`Running: "${options.env!.ISCC_PATH}" /DAppVersion=0.2.1.2`), stdout);
    assert.match(stdout, /ISCC exit code: 0/);
    const calls = JSON.parse(await readFile(join(root, "compiler-calls.json"), "utf8"));
    const compilation = calls.filter((call: { args: string[] }) => call.args[0] !== "/?");
    assert.equal(compilation.length, 1);
    assert.equal(compilation[0].command, options.env!.ISCC_PATH);
    assert.deepEqual(compilation[0].args, [
      "/DAppVersion=0.2.1.2",
      `/DExtensionDir=${join(root, "extension-dist")}`,
      `/DGeneratedDir=${join(root, "dist/installer")}`,
      `/DOutputDir=${join(root, "dist/extension")}`,
      join(root, "installer/windows/tvissn.iss"),
    ]);
    assert.equal(compilation[0].options.shell ?? false, false);
    const exe = await readFile(join(root, "dist/extension/tvissn-extension-setup.exe"));
    assert.equal(exe.toString(), "controlled installer bytes");
    assert.deepEqual(JSON.parse(await readFile(latestPath, "utf8")), {
      ...metadata,
      windowsInstaller: {
        fileName: "tvissn-extension-setup.exe",
        sha256: createHash("sha256").update(exe).digest("hex"),
      },
    });
  });
});

for (const source of ["PATH", "standard directory", "explicit missing path"] as const) {
  test(`installer discovery respects ${source}`, async () => {
    await fixture(async (root, invoke) => {
      const options = await controlledCompiler(root);
      options.env = {
        ISCC_PATH: source === "explicit missing path" ? join(root, "missing-compiler.exe") : "",
        PATH: source === "standard directory" ? "" : join(root, "Inno Setup 6"),
        "ProgramFiles(x86)": source === "standard directory" ? root : "",
        ProgramFiles: "",
        LOCALAPPDATA: "",
      };
      const result = invoke(options);
      if (source === "explicit missing path") {
        assert.equal(result.status, 1);
        assert.match(String(result.stderr), /Inno Setup compiler not found/);
        assert.ok(String(result.stderr).includes(`${join(root, "missing-compiler.exe")} (ISCC_PATH): rejected: ENOENT`), String(result.stderr));
        await assert.rejects(readFile(join(root, "compiler-calls.json")), /ENOENT/);
      } else {
        assert.equal(result.status, 0, String(result.stderr));
        await readFile(join(root, "dist/extension/tvissn-extension-setup.exe"));
      }
    });
  });
}

for (const [mode, error] of [
  ["failure", /Inno Setup compilation failed: exit code 2 \(compiler .*ISCC\.exe\)/],
  ["signal", /Inno Setup compilation failed: signal SIGTERM/],
  ["launch-error", /Inno Setup compilation failed: spawn EACCES \(launch error, compiler .*ISCC\.exe\)/],
  ["missing-output", /ISCC exited with 0 but did not produce .*tvissn-extension-setup\.exe\. .* contains: latest\.json, tvissn-extension\.zip/],
] as const) {
  test(`installer rejects ${mode} without publishing installer metadata`, async () => {
    await fixture(async (root, invoke) => {
      const options = await controlledCompiler(root, mode);
      const latestPath = join(root, "dist/extension/latest.json");
      const before = await readFile(latestPath, "utf8");
      // A previous build's EXE must not mask a missing output or compiler failure.
      await writeFile(join(root, "dist/extension/tvissn-extension-setup.exe"), "stale output");
      const result = invoke(options);
      assert.equal(result.status, 1);
      assert.match(String(result.stderr), error);
      assert.equal(await readFile(latestPath, "utf8"), before);
      await assert.rejects(readFile(join(root, "dist/extension/tvissn-extension-setup.exe")), /ENOENT/);
    });
  });
}

test("installer fails clearly when no local compiler is available", async () => {
  await fixture(async (_root, invoke) => {
    const result = invoke();
    assert.equal(result.status, 1);
    assert.match(String(result.stderr), /Inno Setup compiler not found.*ISCC_PATH.*No tools are downloaded/);
  });
});

test("installer reports every rejected candidate when discovery fails", async () => {
  await fixture(async (root, invoke) => {
    await mkdir(join(root, "Program Files (x86)", "Inno Setup 6", "ISCC.exe"), { recursive: true });
    const result = invoke({ env: {
      ISCC_PATH: "", PATH: join(root, "bin"),
      "ProgramFiles(x86)": join(root, "Program Files (x86)"), ProgramFiles: "", LOCALAPPDATA: "",
    } });
    assert.equal(result.status, 1);
    const stderr = String(result.stderr);
    assert.match(stderr, /Checked candidates:/);
    assert.ok(stderr.includes(`${join(root, "bin", "ISCC.exe")} (PATH): rejected: ENOENT`), stderr);
    assert.ok(stderr.includes(
      `${join(root, "Program Files (x86)", "Inno Setup 6", "ISCC.exe")} (ProgramFiles(x86)): rejected: not a regular file`), stderr);
  });
});

test("installer accepts a quoted ISCC_PATH with surrounding whitespace", async () => {
  await fixture(async (root, invoke) => {
    const options = await controlledCompiler(root);
    const compiler = options.env!.ISCC_PATH!;
    options.env = { ISCC_PATH: ` "${compiler}"\r` };
    const result = invoke(options);
    assert.equal(result.status, 0, String(result.stderr));
    const calls = JSON.parse(await readFile(join(root, "compiler-calls.json"), "utf8"));
    assert.equal(calls[0].command, compiler);
  });
});

test("Inno Setup script includes generated files through preprocessor expressions", async () => {
  const script = await readFile("installer/windows/tvissn.iss", "utf8");
  const directives = script.split(/\r?\n/).filter((line) => line.trimStart().startsWith("#"));
  // Inline {#...} directives are not expanded inside directive lines.
  assert.deepEqual(directives.filter((line) => line.includes("{#")), []);
  assert.deepEqual(directives.filter((line) => line.startsWith("#include")), [
    '#include GeneratedDir + "\\package-files.iss"',
    '#include GeneratedDir + "\\verify-files.iss"',
  ]);
  assert.match(script, /^OutputBaseFilename=tvissn-extension-setup\r?$/m);
  assert.match(script, /^OutputDir=\{#OutputDir\}\r?$/m);
});

test("installer rejects missing payload and stale extension versions before compiling", async () => {
  await fixture(async (root, invoke) => {
    await writeFile(join(root, "extension-dist/manifest.json"), JSON.stringify({ version: "0.2.1.1" }));
    assert.match(String(invoke().stderr), /version must match/);
    await rm(join(root, "extension-dist"), { recursive: true });
    assert.match(String(invoke().stderr), /Missing prepared extension-dist/);
  });
});

test("installer rejects a changed payload even if its manifest version matches", async () => {
  await fixture(async (root, invoke) => {
    await writeFile(join(root, "extension-dist/manifest.json"),
      JSON.stringify({ version: "0.2.1.2", key: identity.key, name: "modified" }));
    const result = invoke();
    assert.equal(result.status, 1);
    assert.match(String(result.stderr), /ZIP content mismatch: manifest.json/);
  });
});

test("installer rejects corrupted ZIP and additional unpacked files", async () => {
  await fixture(async (root, invoke) => {
    await writeFile(join(root, "extension-dist/unexpected.txt"), "not in ZIP");
    assert.match(String(invoke().stderr), /different files/);
    await writeFile(join(root, "dist/extension/tvissn-extension.zip"), "corrupted");
    assert.match(String(invoke().stderr), /ZIP\/latest.json do not match/);
  });
});
