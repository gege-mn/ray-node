// Refreshes openapi/openapi.json, the snapshot `pnpm generate` turns into
// src/generated/openapi.ts.
//
//   pnpm generate                                   # fetch from the live API
//   RAY_OPENAPI=../ray/apps/docs/public/openapi.json pnpm generate   # copy a local file
//   RAY_OPENAPI=https://staging.example/openapi.json pnpm generate   # another URL
import { copyFile, mkdir, writeFile } from 'node:fs/promises';

const source = process.env.RAY_OPENAPI ?? 'https://ray-api.gege.mn/openapi.json';
const target = new URL('../openapi/openapi.json', import.meta.url);
await mkdir(new URL('../openapi/', import.meta.url), { recursive: true });

if (/^https?:\/\//.test(source)) {
  const res = await fetch(source);
  if (!res.ok) {
    console.error(`GET ${source} failed: ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  const spec = await res.json();
  await writeFile(target, `${JSON.stringify(spec, null, 2)}\n`);
} else {
  await copyFile(source, target);
}
console.log(`openapi/openapi.json <- ${source}`);
