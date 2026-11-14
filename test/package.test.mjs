import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const outDir = join(root, "node_modules", ".cache", "package-test");

// Vitest resolves imports the way a bundler does, so the other tests would
// pass even if the built package could not be loaded by Node itself.
describe("the built package", () => {
  it("loads in plain Node and exports its public functions", () => {
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "package.json"), '{ "type": "module" }');
    execFileSync(
      process.execPath,
      [
        join(root, "node_modules", "typescript", "bin", "tsc"),
        "-p",
        "tsconfig.json",
        "--outDir",
        outDir,
        "--declaration",
        "false",
        "--declarationMap",
        "false",
        "--sourceMap",
        "false",
      ],
      { cwd: root, stdio: "pipe" },
    );

    const script = `
      const m = await import(${JSON.stringify(join(outDir, "index.js"))});
      console.log(JSON.stringify(Object.keys(m).sort().map((k) => [k, typeof m[k]])));
    `;
    const output = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", script],
      { cwd: root, encoding: "utf8" },
    );

    expect(JSON.parse(output)).toEqual([
      ["elasticsearchAdapter", "function"],
      ["migrate", "function"],
      ["purgeExpired", "function"],
    ]);
  }, 60_000);
});
