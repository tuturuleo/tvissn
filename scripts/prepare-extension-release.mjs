import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
const previous = JSON.parse(await readFile("extension/release.json", "utf8"));
const committedAt = Number(
  execFileSync("git", ["show", "-s", "--format=%ct", "HEAD"], {
    encoding: "utf8",
  }).trim(),
);
const buildEpoch = Math.max(committedAt, previous.buildEpoch + 1);
const version = `0.2.${Math.floor(buildEpoch / 65536)}.${buildEpoch % 65536}`;
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
await writeFile(
  "extension/release.json",
  JSON.stringify({ version, buildEpoch, sourceCommit }, null, 2) + "\n",
);
console.log(version);
