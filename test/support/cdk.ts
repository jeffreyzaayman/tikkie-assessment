import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { App } from 'aws-cdk-lib';
import type { Template } from 'aws-cdk-lib/assertions';

const cdkJson = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', 'cdk.json'), 'utf8'),
) as { context: Record<string, unknown> };

/*
 * An App with the same cdk.json context as the CDK CLI (feature flags, stageAccounts), so tests
 * see the template that deploys. Extra context is merged on top.
 */
export function testApp(extraContext: Record<string, unknown> = {}): App {
  return new App({ context: { ...cdkJson.context, ...extraContext } });
}

// Replaces Lambda asset hashes so handler code changes don't churn the snapshot.
export function withoutAssetHashes(template: Template): unknown {
  return JSON.parse(
    JSON.stringify(template.toJSON()).replace(/[0-9a-f]{64}(\.zip)?/g, '[ASSET_HASH]$1'),
  );
}
