import {
  AuthorizationType,
  EndpointType,
  LambdaIntegration,
  RestApi,
} from 'aws-cdk-lib/aws-apigateway';
import type { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import { handlerFunction } from './handler-function';
import type { PersonStorage } from './person-storage';
import type { Stage } from './stage';

export interface PersonApiProps {
  readonly stage: Stage;
  readonly storage: PersonStorage;
}

// REST API for the person service. Every method requires IAM (SigV4) auth.
export class PersonApi extends Construct {
  public readonly api: RestApi;
  public readonly createPersonFunction: NodejsFunction;
  public readonly getPersonFunction: NodejsFunction;
  public readonly listPersonsFunction: NodejsFunction;

  constructor(scope: Construct, id: string, props: PersonApiProps) {
    super(scope, id);
    const { stage, storage } = props;

    this.createPersonFunction = handlerFunction(this, 'CreatePerson', {
      stage,
      entryFile: 'create-person.ts',
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
        throttlingRateLimit: 10,
        throttlingBurstLimit: 20,
      },
    });

    const persons = this.api.root.addResource('person');
    persons.addMethod('POST', new LambdaIntegration(this.createPersonFunction));
    persons.addMethod('GET', new LambdaIntegration(this.listPersonsFunction));

    const person = persons.addResource('{id}');
    person.addMethod('GET', new LambdaIntegration(this.getPersonFunction));
  }
}
