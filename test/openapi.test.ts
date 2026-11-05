import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { personInputSchema } from '../lib/api-schemas';
import { openApiDocument, renderOpenApiYaml } from '../lib/openapi';

const COMMITTED = join(import.meta.dirname, '..', 'api', 'openapi.yaml');

describe('OpenAPI document', () => {
  it('matches the committed api/openapi.yaml (run `npm run openapi` after changing it)', () => {
    expect(readFileSync(COMMITTED, 'utf8')).toBe(renderOpenApiYaml());
  });

  it('uses the same PersonInput schema as the API Gateway request model', () => {
    const components = openApiDocument().components as { schemas: Record<string, unknown> };
    expect(components.schemas.PersonInput).toBe(personInputSchema);
  });

  it('only uses keywords that OpenAPI 3.0 schemas accept', () => {
    const json = JSON.stringify(personInputSchema);
    expect(json).not.toMatch(/"\$schema"|"schema"|"id"|"\$ref"/);
  });
});
