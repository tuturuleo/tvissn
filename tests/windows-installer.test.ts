import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, copyFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { zipSync } from "fflate";
import identity from "../extension/identity.json";

// Isolated fixtures exercise the actual packaging script, without a Windows
// compiler and without changing this checkout's release metadata or payload.
async function fixture(run: (root: string, invoke: () => ReturnType<typeof spawnSync>) => Promise<void>) {
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
    await run(root, () => spawnSync(process.execPath, [join(root, "scripts/build-windows-installer.mjs")], {
      encoding: "utf8",
      env: { ...process.env, ISCC_PATH: join(root, "missing-compiler.exe") },
    }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("installer fails clearly when no local compiler is available", async () => {
  await fixture(async (_root, invoke) => {
    const result = invoke();
    assert.equal(result.status, 1);
    assert.match(String(result.stderr), /Inno Setup compiler not found.*ISCC_PATH.*No tools are downloaded/);
  });
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
