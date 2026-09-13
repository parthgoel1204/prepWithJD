/**
 * @prepwithjd/cli — real batch evaluator.
 *
 * Thin argument parser over the SAME code path the API uses: reads cases.json,
 * calls pipeline.evaluate() (which is runPipeline() per case), writes kits.json
 * in the exact Appendix B shape. One failing case never aborts the batch.
 *
 * Usage:
 *   npm run evaluate -- --input tooling/cases.json --output tooling/kits.json
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { evaluate, type EvaluateInput } from "@prepwithjd/pipeline";

const ROOT = join(import.meta.dirname, "..", "..", "..");
try {
  process.loadEnvFile(join(ROOT, "apps/api/.env"));
} catch {
  /* env missing — pipeline will fail loudly if keys are absent */
}

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
function argPresent(args: string[], name: string): boolean {
  return args.includes(name);
}

async function main() {
  const args = process.argv.slice(2);
  if (argPresent(args, "--help") || argPresent(args, "-h")) {
    console.log("evaluate --input <cases.json> --output <kits.json>  (defaults: cases.json / kits.json)");
    return;
  }
  const inputPathRaw = argValue(args, "--input") ?? "cases.json";
  const outputPathRaw = argValue(args, "--output") ?? "kits.json";
  // resolves relative to the repo root, NOT the workspace cwd that npm runs in
  const abs = (p: string) => (p.startsWith("/") ? p : join(ROOT, p));
  const inputPath = abs(inputPathRaw);
  const outputPath = abs(outputPathRaw);

  let raw: string;
  try {
    raw = readFileSync(inputPath, "utf8");
  } catch {
    console.error(`cannot read input file: ${inputPath}`);
    process.exit(1);
  }
  const cases = JSON.parse(raw) as EvaluateInput[];
  console.log(`[cli] ${cases.length} case(s) from ${inputPath}`);

  const started = Date.now();
  const output = await evaluate(cases);
  const wall = Date.now() - started;

  writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`[cli] wrote ${outputPath}`);

  const ok = output.kits.filter((k) => k.status === "ok").length;
  const failed = output.kits.length - ok;
  console.log(`[cli] total wall ${wall}ms; ${ok} ok, ${failed} failed`);
  if (failed === output.kits.length) process.exit(2);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});