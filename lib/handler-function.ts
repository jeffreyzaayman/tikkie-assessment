import { join } from 'node:path';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import { Architecture, LoggingFormat, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import type { Stage } from './stage';

const HANDLERS_DIR = join(import.meta.dirname, '..', 'src', 'handlers');

/*
 * Gives CommonJS dependencies that call require() a working one inside the ESM bundle. The
 * name is unusual so it can't clash with a top-level binding in the bundled code.
 */
const ESM_REQUIRE_SHIM =
  "import { createRequire as __createRequire } from 'node:module'; " +
  'const require = __createRequire(import.meta.url);';

export interface HandlerFunctionProps {
  readonly stage: Stage;
  // File name in src/handlers, e.g. `create-person.ts`.
  readonly entryFile: string;
  readonly environment?: Record<string, string>;
}

/**
 * A Lambda handler with the service's shared runtime, logging and bundling settings.
 * Creates `<name>Function` and its `<name>Logs` log group in `scope`.
 */
export function handlerFunction(
  scope: Construct,
  name: string,
  props: HandlerFunctionProps,
): NodejsFunction {
  const isProd = props.stage === 'prod';
  return new NodejsFunction(scope, `${name}Function`, {
    entry: join(HANDLERS_DIR, props.entryFile),
    runtime: Runtime.NODEJS_24_X,
    architecture: Architecture.ARM_64,
    memorySize: 256,
    timeout: Duration.seconds(10),
    loggingFormat: LoggingFormat.JSON,
    logGroup: new LogGroup(scope, `${name}Logs`, {
      retention: RetentionDays.ONE_MONTH,
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    }),
    environment: { ...props.environment, NODE_OPTIONS: '--enable-source-maps' },
    /*
     * ESM like the source (index.mjs, so Lambda loads it as a module). Prefers dependencies' ESM
     * builds; @aws-sdk/* stays external and comes from the runtime.
     */
    bundling: {
      minify: true,
      sourceMap: true,
      format: OutputFormat.ESM,
      mainFields: ['module', 'main'],
      banner: ESM_REQUIRE_SHIM,
    },
  });
}
