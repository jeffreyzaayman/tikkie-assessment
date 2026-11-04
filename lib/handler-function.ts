import { join } from 'node:path';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import { Architecture, LoggingFormat, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import type { Stage } from './stage';

const HANDLERS_DIR = join(import.meta.dirname, '..', 'src', 'handlers');

export interface HandlerFunctionProps {
  readonly stage: Stage;
  /** File name in src/handlers, e.g. `create-person.ts`. */
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
    bundling: { minify: true, sourceMap: true },
  });
}
