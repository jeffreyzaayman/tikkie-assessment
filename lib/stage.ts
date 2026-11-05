import type { Node } from 'constructs';

export const STAGES = ['dev', 'prod'] as const;

export type Stage = (typeof STAGES)[number];

export function parseStage(value: unknown): Stage {
  if (typeof value === 'string' && (STAGES as readonly string[]).includes(value)) {
    return value as Stage;
  }
  throw new Error(
    `Invalid or missing stage context: ${JSON.stringify(value)}. ` +
      `Pass one of ${STAGES.join(', ')}, e.g. "cdk synth -c stage=dev".`,
  );
}

/**
 * Returns the AWS account id a stage must deploy to, from the `stageAccounts` context in cdk.json.
 * Throws if the map is missing or the stage's entry isn't a 12-digit account id.
 */
export function accountForStage(node: Node, stage: Stage): string {
  const accounts: unknown = node.tryGetContext('stageAccounts');
  if (typeof accounts !== 'object' || accounts === null || Array.isArray(accounts)) {
    throw new Error(
      'Missing "stageAccounts" context. Add it to cdk.json, e.g. ' +
        '"stageAccounts": { "dev": "111111111111", "prod": "222222222222" }.',
    );
  }
  const account: unknown = (accounts as Record<string, unknown>)[stage];
  if (typeof account !== 'string' || !/^\d{12}$/.test(account)) {
    throw new Error(
      `Invalid or missing account for stage "${stage}" in "stageAccounts" context: ` +
        `${JSON.stringify(account)}. Expected a 12-digit string, e.g. "111111111111".`,
    );
  }
  return account;
}
