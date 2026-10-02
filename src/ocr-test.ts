// Shows how well text recognition reads an image (e.g. a screenshot of MATH 135 notes),
// comparing both engines with language correction on and off.
//   npm run ocr-test -- ~/Desktop/notes.png
// Your image is only read, never changed or deleted. A report is saved to sessions/ocr-tests/.
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { VisionHelper, type OcrOptions } from "./helper.ts";

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.log("Usage: npm run ocr-test -- <image.png> [more images...]");
  process.exit(1);
}

const variants: { label: string; opts: OcrOptions }[] = [
  { label: "document engine, language correction OFF (session default)", opts: { engine: "document", languageCorrection: false } },
  { label: "document engine, language correction ON", opts: { engine: "document", languageCorrection: true } },
  { label: "lines engine, language correction OFF", opts: { engine: "lines", languageCorrection: false } },
  { label: "lines engine, language correction ON", opts: { engine: "lines", languageCorrection: true } },
];

const outDir = fileURLToPath(new URL("../sessions/ocr-tests", import.meta.url));
mkdirSync(outDir, { recursive: true });
const helper = new VisionHelper();

for (const p of paths) {
  const file = resolve(p);
  let report = `# Text recognition test: ${basename(file)}\n`;
  for (const v of variants) {
    try {
      const r = await helper.ocrFile(file, v.opts);
      const avg = r.blocks.length ? r.blocks.reduce((s, b) => s + b.confidence, 0) / r.blocks.length : 0;
      const text = r.blocks.map((b) => b.text).join("\n\n");
      report += `\n## ${v.label}\n\n_${r.ms} ms · ${r.blocks.length} blocks · average confidence ${avg.toFixed(2)}_\n\n\`\`\`text\n${text}\n\`\`\`\n`;
    } catch (err) {
      report += `\n## ${v.label}\n\nError: ${(err as Error).message}\n`;
    }
  }
  const outPath = join(outDir, basename(file).replace(/\.[^.]+$/, "") + ".md");
  writeFileSync(outPath, report);
  console.log(report);
  console.log(`Report saved: ${outPath}\n`);
}
helper.close();
