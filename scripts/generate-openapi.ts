import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderOpenApiYaml } from '../lib/openapi';

// Writes api/openapi.yaml from lib/openapi.ts. Run with `npm run openapi`.
const path = join(import.meta.dirname, '..', 'api', 'openapi.yaml');
writeFileSync(path, renderOpenApiYaml());
console.log(`Wrote ${path}`);
