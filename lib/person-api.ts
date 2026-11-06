import {
  AuthorizationType,
  EndpointType,
  JsonSchemaVersion,
  LambdaIntegration,
  Model,
  RequestValidator,
  ResponseType,
  RestApi,
} from 'aws-cdk-lib/aws-apigateway';
import type { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import { personInputSchema } from './api-schemas';
import { handlerFunction } from './handler-function';
import type { PersonStorage } from './person-storage';
import type { Stage } from './stage';

export interface PersonApiProps {
  readonly stage: Stage;
  readonly storage: PersonStorage;
}

/*
 * Stage throttling, also stated in the OpenAPI document. Sized for bursts of 1000 new persons per
 * second; the account-wide API Gateway quota (10,000 rps per region) leaves room for the GETs.
 */
export const API_THROTTLING = { rateLimit: 1000, burstLimit: 2000 } as const;

/*
 * Concurrency set aside for CreatePerson in prod. 1000 creates/s at ~100 ms each needs ~100
 * instances; 500 leaves room for cold starts in a burst. It also caps CreatePerson, so a burst
 * can't starve the other functions. Prod only: reserving needs an account concurrency quota of
 * at least 600 (AWS keeps 100 unreserved), and new accounts start far lower.
 */
export const CREATE_PERSON_RESERVED_CONCURRENCY = 500;

// REST API for the person service. Every method requires IAM (SigV4) auth.
export class PersonApi extends Construct {
  public readonly api: RestApi;
  public readonly createPersonFunction: NodejsFunction;
  public readonly getPersonFunction: NodejsFunction;
  public readonly listPersonsFunction: NodejsFunction;

  constructor(scope: Construct, id: string, props: PersonApiProps) {
    super(scope, id);
    const { stage, storage } = props;
    const isProd = stage === 'prod';

    this.createPersonFunction = handlerFunction(this, 'CreatePerson', {
      stage,
      entryFile: 'create-person.ts',
      // More CPU makes each create faster, so a burst needs fewer concurrent instances.
      memorySize: 1024,
      reservedConcurrentExecutions: isProd ? CREATE_PERSON_RESERVED_CONCURRENCY : undefined,
      environment: {
        PERSONS_TABLE_NAME: storage.persons.tableName,
        PHONE_NUMBERS_TABLE_NAME: storage.phoneNumbers.tableName,
      },
    });
    // A transaction of two Puts only needs PutItem; grantWriteData would also allow Update/Delete.
    storage.persons.grant(this.createPersonFunction, 'dynamodb:PutItem');
    storage.phoneNumbers.grant(this.createPersonFunction, 'dynamodb:PutItem');

    this.getPersonFunction = handlerFunction(this, 'GetPerson', {
      stage,
      entryFile: 'get-person.ts',
      environment: { PERSONS_TABLE_NAME: storage.persons.tableName },
    });
    // A single-item lookup; grantReadData would also allow Query/Scan over every person.
    storage.persons.grant(this.getPersonFunction, 'dynamodb:GetItem');

    this.listPersonsFunction = handlerFunction(this, 'ListPersons', {
      stage,
      entryFile: 'list-persons.ts',
      environment: { PERSONS_TABLE_NAME: storage.persons.tableName },
    });
    // Paginated Scan of persons only; the phone-number table is never listed.
    storage.persons.grant(this.listPersonsFunction, 'dynamodb:Scan');

    this.api = new RestApi(this, 'Api', {
      restApiName: `person-service-${stage}`,
      description: `Person service API (${stage})`,
      endpointTypes: [EndpointType.REGIONAL],
      defaultMethodOptions: { authorizationType: AuthorizationType.IAM },
      deployOptions: {
        stageName: stage,
        throttlingRateLimit: API_THROTTLING.rateLimit,
        throttlingBurstLimit: API_THROTTLING.burstLimit,
      },
    });

    /*
     * API Gateway rejects create-person bodies of the wrong shape before the Lambda runs (no
     * invocation cost). The Lambda still validates everything: it is the source of truth, and a
     * request with another Content-Type skips this model.
     */
    const personInputModel = new Model(this, 'PersonInputModel', {
      restApi: this.api,
      contentType: 'application/json',
      modelName: 'PersonInput',
      schema: { ...personInputSchema, schema: JsonSchemaVersion.DRAFT4 },
    });
    const bodyValidator = new RequestValidator(this, 'BodyValidator', {
      restApi: this.api,
      validateRequestBody: true,
    });
    // Same shape as the Lambda's 400s. messageString is already a quoted JSON string.
    this.api.addGatewayResponse('BadRequestBody', {
      type: ResponseType.BAD_REQUEST_BODY,
      templates: {
        'application/json':
          '{"message":$context.error.messageString,"errors":["$context.error.validationErrorString"]}',
      },
    });

    const persons = this.api.root.addResource('person');
    persons.addMethod('POST', new LambdaIntegration(this.createPersonFunction), {
      requestModels: { 'application/json': personInputModel },
      requestValidator: bodyValidator,
    });
    persons.addMethod('GET', new LambdaIntegration(this.listPersonsFunction));

    const person = persons.addResource('{id}');
    person.addMethod('GET', new LambdaIntegration(this.getPersonFunction));
  }
}
