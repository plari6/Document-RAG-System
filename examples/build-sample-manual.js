// Regenerates examples/netpro-x200-manual.pdf (the fictional manual used by `doc-rag demo` and the tests).
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildSampleManualPdf } from '../src/demo/sample-manual.js';

const out = fileURLToPath(new URL('./netpro-x200-manual.pdf', import.meta.url));
writeFileSync(out, buildSampleManualPdf());
console.log(`wrote ${out}`);
