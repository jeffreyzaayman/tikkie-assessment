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
