import { join } from 'node:path';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import {
  AuthorizationType,
  EndpointType,
  LambdaIntegration,
  RestApi,
} from 'aws-cdk-lib/aws-apigateway';
import { Architecture, LoggingFormat, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import type { PersonStorage } from './person-storage';
import type { Stage } from './stage';

const HANDLERS_DIR = join(import.meta.dirname, '..', 'src', 'handlers');

export interface PersonApiProps {
  readonly stage: Stage;
  readonly storage: PersonStorage;
}

/** REST API for the person service. Every method requires IAM (SigV4) auth. */
export class PersonApi extends Construct {
  public readonly api: RestApi;
  public readonly createPersonFunction: NodejsFunction;
  public readonly getPersonFunction: NodejsFunction;

  private readonly isProd: boolean;

  constructor(scope: Construct, id: string, props: PersonApiProps) {
    super(scope, id);
    const { stage, storage } = props;
    this.isProd = stage === 'prod';

    this.createPersonFunction = this.handlerFunction('CreatePerson', 'create-person.ts', {
      PERSONS_TABLE_NAME: storage.persons.tableName,
      PHONE_NUMBERS_TABLE_NAME: storage.phoneNumbers.tableName,
    });
    // A transaction of two Puts only needs PutItem; grantWriteData would also allow Update/Delete.
    storage.persons.grant(this.createPersonFunction, 'dynamodb:PutItem');
    storage.phoneNumbers.grant(this.createPersonFunction, 'dynamodb:PutItem');

    this.getPersonFunction = this.handlerFunction('GetPerson', 'get-person.ts', {
      PERSONS_TABLE_NAME: storage.persons.tableName,
    });
    // A single-item lookup; grantReadData would also allow Query/Scan over every person.
    storage.persons.grant(this.getPersonFunction, 'dynamodb:GetItem');

    this.api = new RestApi(this, 'Api', {
      restApiName: `person-service-${stage}`,
      description: `Person service API (${stage})`,
      endpointTypes: [EndpointType.REGIONAL],
      defaultMethodOptions: { authorizationType: AuthorizationType.IAM },
      deployOptions: {
        stageName: stage,
        throttlingRateLimit: 10,
        throttlingBurstLimit: 20,
      },
    });

    const persons = this.api.root.addResource('person');
    persons.addMethod('POST', new LambdaIntegration(this.createPersonFunction));

    const person = persons.addResource('{id}');
    person.addMethod('GET', new LambdaIntegration(this.getPersonFunction));
  }

  /** A Lambda handler with the service's shared runtime, logging and bundling settings. */
  private handlerFunction(
    name: string,
    entryFile: string,
    environment: Record<string, string>,
  ): NodejsFunction {
    return new NodejsFunction(this, `${name}Function`, {
      entry: join(HANDLERS_DIR, entryFile),
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(10),
      loggingFormat: LoggingFormat.JSON,
      logGroup: new LogGroup(this, `${name}Logs`, {
        retention: RetentionDays.ONE_MONTH,
        removalPolicy: this.isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      }),
      environment: { ...environment, NODE_OPTIONS: '--enable-source-maps' },
      bundling: { minify: true, sourceMap: true },
    });
  }
}
