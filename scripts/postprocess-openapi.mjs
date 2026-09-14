// openapi-typescript emits the recursive `JsonValue` schema as a
// self-referencing indexed access (`components['schemas']['JsonValue'][]`),
// which TypeScript rejects (TS2502). Point it at a standalone recursive alias.
import { readFile, writeFile } from 'node:fs/promises';

const file = new URL('../src/generated/openapi.ts', import.meta.url);
let source = await readFile(file, 'utf8');

const q = `["']`;
const ref = `components\\[${q}schemas${q}\\]\\[${q}JsonValue${q}\\]`;
const pattern = new RegExp(
  `JsonValue:\\s*\\|?\\s*string\\s*\\|\\s*number\\s*\\|\\s*boolean\\s*\\|\\s*null\\s*\\|\\s*${ref}\\[\\]\\s*\\|\\s*\\{\\s*\\[key: string\\]: ${ref};\\s*\\};`,
);
if (!pattern.test(source)) {
  if (!source.includes('JsonValue: JsonValue;')) {
    console.error(
      'postprocess-openapi: JsonValue shape changed; update scripts/postprocess-openapi.mjs',
    );
    process.exit(1);
  }
} else {
  source = source.replace(pattern, 'JsonValue: JsonValue;');
  source += `\nexport type JsonValue =\n  | string\n  | number\n  | boolean\n  | null\n  | JsonValue[]\n  | { [key: string]: JsonValue };\n`;
}
await writeFile(file, source);
