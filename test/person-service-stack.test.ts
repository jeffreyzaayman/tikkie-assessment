import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { API_THROTTLING, CREATE_PERSON_RESERVED_CONCURRENCY } from '../lib/person-api';
import { PersonServiceStack } from '../lib/stacks/person-service-stack';
import { STAGES, type Stage } from '../lib/stage';
import { testApp, withoutAssetHashes } from './support/cdk';

const GLOBAL_TABLE = 'AWS::DynamoDB::GlobalTable';

// Synthesise (and bundle the Lambdas) once per stage, shared by all tests.
const templates = new Map<Stage, Template>();

function synth(stage: Stage): Template {
  let template = templates.get(stage);
  if (!template) {
    const app = testApp();
    const stack = new PersonServiceStack(app, `PersonService-${stage}`, {
      stage,
      env: { region: 'eu-west-1' },
    });
    template = Template.fromStack(stack);
    templates.set(stage, template);
  }
  return template;
}

function replicaWith(props: Record<string, unknown>) {
  return { Replicas: Match.arrayWith([Match.objectLike(props)]) };
}

describe('PersonServiceStack', () => {
  it('matches the synthesised template snapshot', () => {
    expect(withoutAssetHashes(synth('dev'))).toMatchSnapshot();
  });

  it('requires IAM auth on every API method', () => {
    const template = synth('dev');
    template.resourceCountIs('AWS::ApiGateway::Method', 3);
    template.hasResourceProperties('AWS::ApiGateway::Method', { HttpMethod: 'POST' });
    template.resourcePropertiesCountIs('AWS::ApiGateway::Method', { HttpMethod: 'GET' }, 2);
    template.allResourcesProperties('AWS::ApiGateway::Method', { AuthorizationType: 'AWS_IAM' });
  });

  describe('create-person request validation', () => {
    it('has a PersonInput model built from the shared schema', () => {
      synth('dev').hasResourceProperties('AWS::ApiGateway::Model', {
        Name: 'PersonInput',
        ContentType: 'application/json',
        Schema: {
          $schema: 'http://json-schema.org/draft-04/schema#',
          type: 'object',
          required: ['firstName', 'lastName', 'phoneNumber', 'address'],
          additionalProperties: false,
          properties: {
            phoneNumber: Match.objectLike({ type: 'string', maxLength: 200, pattern: '\\S' }),
          },
        },
      });
    });

    it('validates the POST body against the model, and only the body', () => {
      const template = synth('dev');
      template.hasResourceProperties('AWS::ApiGateway::RequestValidator', {
        ValidateRequestBody: true,
        // Absent means false: query and path parameters stay with the Lambdas.
        ValidateRequestParameters: Match.absent(),
      });
      template.hasResourceProperties('AWS::ApiGateway::Method', {
        HttpMethod: 'POST',
        RequestModels: {
          'application/json': { Ref: Match.stringLikeRegexp('^ApiPersonInputModel') },
        },
        RequestValidatorId: { Ref: Match.stringLikeRegexp('^ApiBodyValidator') },
      });
      template.resourcePropertiesCountIs(
        'AWS::ApiGateway::Method',
        { RequestValidatorId: Match.anyValue() },
        1,
      );
    });

    it('returns rejected bodies in the same shape as the Lambda', () => {
      synth('dev').hasResourceProperties('AWS::ApiGateway::GatewayResponse', {
        ResponseType: 'BAD_REQUEST_BODY',
        ResponseTemplates: {
          'application/json': Match.stringLikeRegexp('"message":.*"errors":\\['),
        },
      });
    });
  });

  describe('burst capacity', () => {
    const createPerson = {
      Environment: { Variables: Match.objectLike({ PHONE_NUMBERS_TABLE_NAME: Match.anyValue() }) },
    };

    it('throttles the API stage at 1000 rps with bursts of 2000', () => {
      synth('dev').hasResourceProperties('AWS::ApiGateway::Stage', {
        MethodSettings: [
          Match.objectLike({
            HttpMethod: '*',
            ResourcePath: '/*',
            ThrottlingRateLimit: 1000,
            ThrottlingBurstLimit: 2000,
          }),
        ],
      });
    });

    it('gives the create-person function 1024 MB', () => {
      synth('dev').hasResourceProperties('AWS::Lambda::Function', {
        ...createPerson,
        MemorySize: 1024,
      });
    });

    it.each([
      ['prod', CREATE_PERSON_RESERVED_CONCURRENCY],
      ['dev', Match.absent()],
    ] as const)('in %s reserves %j concurrency for create-person only', (stage, reserved) => {
      const template = synth(stage);
      template.hasResourceProperties('AWS::Lambda::Function', {
        ...createPerson,
        ReservedConcurrentExecutions: reserved,
      });
      template.resourcePropertiesCountIs(
        'AWS::Lambda::Function',
        { ReservedConcurrentExecutions: Match.anyValue() },
        stage === 'prod' ? 1 : 0,
      );
    });
  });

  describe('least-privilege table access', () => {
    const tableArn = (logicalIdPrefix: string) => ({
      'Fn::GetAtt': [Match.stringLikeRegexp(`^Storage${logicalIdPrefix}`), 'Arn'],
    });
    const roleOf = (functionPrefix: string) => [
      { Ref: Match.stringLikeRegexp(`^Api${functionPrefix}FunctionServiceRole`) },
    ];

    it('has one policy per API function plus the pipe role, and nothing else', () => {
      synth('dev').resourceCountIs('AWS::IAM::Policy', 4);
    });

    it('grants the create-person function only PutItem on the two tables', () => {
      synth('dev').hasResourceProperties('AWS::IAM::Policy', {
        Roles: roleOf('CreatePerson'),
        PolicyDocument: {
          Statement: [
            {
              Action: 'dynamodb:PutItem',
              Effect: 'Allow',
              Resource: [tableArn('Persons'), tableArn('PhoneNumbers')],
            },
          ],
        },
      });
    });

    it('grants the get-person function only GetItem on the persons table', () => {
      synth('dev').hasResourceProperties('AWS::IAM::Policy', {
        Roles: roleOf('GetPerson'),
        PolicyDocument: {
          Statement: [
            {
              Action: 'dynamodb:GetItem',
              Effect: 'Allow',
              Resource: tableArn('Persons'),
            },
          ],
        },
      });
    });

    it('grants the list-persons function only Scan on the persons table', () => {
      synth('dev').hasResourceProperties('AWS::IAM::Policy', {
        Roles: roleOf('ListPersons'),
        PolicyDocument: {
          Statement: [
            {
              Action: 'dynamodb:Scan',
              Effect: 'Allow',
              Resource: tableArn('Persons'),
            },
          ],
        },
      });
    });
  });

  describe('person-created events', () => {
    const PIPE = 'AWS::Pipes::Pipe';
    const ref = (logicalIdPrefix: string) => ({
      Ref: Match.stringLikeRegexp(`^${logicalIdPrefix}`),
    });
    const getAtt = (logicalIdPrefix: string, attribute: string) => ({
      'Fn::GetAtt': [Match.stringLikeRegexp(`^${logicalIdPrefix}`), attribute],
    });

    it('pipes INSERTs from the persons stream through the enrichment Lambda to the topic', () => {
      synth('dev').hasResourceProperties(PIPE, {
        Name: 'person-service-dev-person-created',
        Source: getAtt('StoragePersons', 'StreamArn'),
        Enrichment: getAtt('EventsEnrichmentFunction', 'Arn'),
        Target: ref('EventsTopic'),
        SourceParameters: {
          FilterCriteria: { Filters: [{ Pattern: '{"eventName":["INSERT"]}' }] },
          DynamoDBStreamParameters: {
            StartingPosition: 'LATEST',
            BatchSize: 100,
            MaximumBatchingWindowInSeconds: 1,
            ParallelizationFactor: 10,
            MaximumRetryAttempts: 10,
            OnPartialBatchItemFailure: 'AUTOMATIC_BISECT',
            DeadLetterConfig: { Arn: getAtt('EventsDeadLetterQueue', 'Arn') },
          },
        },
        LogConfiguration: { Level: 'ERROR', IncludeExecutionData: Match.absent() },
      });
    });

    it('creates the pipe only after its role policy', () => {
      const pipes = synth('dev').findResources(PIPE);
      const [pipe] = Object.values(pipes) as { DependsOn?: string[] }[];
      expect(pipe?.DependsOn).toEqual(
        expect.arrayContaining([expect.stringMatching(/^EventsPipeRoleDefaultPolicy/)]),
      );
    });

    it('lets only the pipes service in this account assume the pipe role', () => {
      synth('dev').hasResourceProperties('AWS::IAM::Role', {
        AssumeRolePolicyDocument: {
          Statement: [
            {
              Action: 'sts:AssumeRole',
              Effect: 'Allow',
              Principal: { Service: 'pipes.amazonaws.com' },
              Condition: { StringEquals: { 'aws:SourceAccount': Match.anyValue() } },
            },
          ],
        },
      });
    });

    it('grants the pipe role only what the pipe uses', () => {
      synth('dev').hasResourceProperties('AWS::IAM::Policy', {
        Roles: [ref('EventsPipeRole')],
        PolicyDocument: {
          Statement: [
            {
              Action: [
                'dynamodb:DescribeStream',
                'dynamodb:GetRecords',
                'dynamodb:GetShardIterator',
                'dynamodb:ListStreams',
              ],
              Effect: 'Allow',
              Resource: getAtt('StoragePersons', 'StreamArn'),
            },
            Match.objectLike({ Action: 'lambda:InvokeFunction' }),
            { Action: 'sns:Publish', Effect: 'Allow', Resource: ref('EventsTopic') },
            Match.objectLike({ Action: Match.arrayWith(['sqs:SendMessage']) }),
            Match.objectLike({ Action: ['logs:CreateLogStream', 'logs:PutLogEvents'] }),
          ],
        },
      });
    });

    it('encrypts the dead-letter queue and keeps messages for 14 days', () => {
      synth('dev').hasResourceProperties('AWS::SQS::Queue', {
        SqsManagedSseEnabled: true,
        MessageRetentionPeriod: 14 * 24 * 60 * 60,
      });
    });

    it('publishes the topic ARN in SSM for consumers', () => {
      synth('dev').hasResourceProperties('AWS::SSM::Parameter', {
        Name: '/person-service/dev/person-created-topic-arn',
        Value: ref('EventsTopic'),
      });
    });

    it('only accepts publishes over TLS', () => {
      synth('dev').hasResourceProperties('AWS::SNS::TopicPolicy', {
        PolicyDocument: {
          Statement: [
            Match.objectLike({
              Effect: 'Deny',
              Action: 'sns:Publish',
              Condition: { Bool: { 'aws:SecureTransport': 'false' } },
            }),
          ],
        },
      });
    });

    it.each([
      ['prod', 'Retain'],
      ['dev', 'Delete'],
    ] as const)('names the topic per stage and sets %s removal to %s', (stage, policy) => {
      synth(stage).hasResource('AWS::SNS::Topic', {
        Properties: { TopicName: `person-service-${stage}-person-created` },
        DeletionPolicy: policy,
        UpdateReplacePolicy: policy,
      });
    });
  });

  describe('alarms', () => {
    const ALARM = 'AWS::CloudWatch::Alarm';

    it('has one alarm per failure mode, all notifying the alarm topic', () => {
      const template = synth('dev');
      const names = Object.values(template.findResources(ALARM)).map(
        (alarm) => (alarm as { Properties: { AlarmName: string } }).Properties.AlarmName,
      );
      expect(names.sort()).toEqual(
        [
          'person-service-dev-Api5xx',
          'person-service-dev-ApiNearThrottleLimit',
          'person-service-dev-CreatePersonErrors',
          'person-service-dev-CreatePersonThrottles',
          'person-service-dev-EventEnrichmentErrors',
          'person-service-dev-EventEnrichmentThrottles',
          'person-service-dev-GetPersonErrors',
          'person-service-dev-GetPersonThrottles',
          'person-service-dev-ListPersonsErrors',
          'person-service-dev-ListPersonsThrottles',
          'person-service-dev-PersonCreatedThrottled',
          'person-service-dev-PersonsWriteThrottles',
          'person-service-dev-PhoneNumbersWriteThrottles',
          'person-service-dev-PipeDeadLetterQueueNotEmpty',
        ].sort(),
      );
      template.allResourcesProperties(ALARM, {
        AlarmActions: [{ Ref: Match.stringLikeRegexp('^AlarmsTopic') }],
        TreatMissingData: 'notBreaching',
      });
    });

    it('watches the pipe dead-letter queue', () => {
      synth('dev').hasResourceProperties(ALARM, {
        AlarmName: 'person-service-dev-PipeDeadLetterQueueNotEmpty',
        MetricName: 'ApproximateNumberOfMessagesVisible',
        Dimensions: [
          {
            Name: 'QueueName',
            Value: {
              'Fn::GetAtt': [Match.stringLikeRegexp('^EventsDeadLetterQueue'), 'QueueName'],
            },
          },
        ],
      });
    });

    it('counts every 5XX the API returns', () => {
      synth('dev').hasResourceProperties(ALARM, {
        AlarmName: 'person-service-dev-Api5xx',
        Namespace: 'AWS/ApiGateway',
        MetricName: '5XXError',
        Statistic: 'Sum',
        Threshold: 1,
      });
    });

    it('watches throttling of the tables and the pipe', () => {
      const template = synth('dev');
      for (const table of ['Persons', 'PhoneNumbers']) {
        template.hasResourceProperties(ALARM, {
          AlarmName: `person-service-dev-${table}WriteThrottles`,
          MetricName: 'WriteThrottleEvents',
          Dimensions: [
            { Name: 'TableName', Value: { Ref: Match.stringLikeRegexp(`^Storage${table}`) } },
          ],
        });
      }
      template.hasResourceProperties(ALARM, {
        AlarmName: 'person-service-dev-PersonCreatedThrottled',
        Namespace: 'AWS/EventBridge/Pipes',
        Dimensions: [{ Name: 'PipeName', Value: { Ref: Match.stringLikeRegexp('^EventsPipe') } }],
      });
    });

    it('warns at 80% of the API rate limit over a minute', () => {
      synth('dev').hasResourceProperties(ALARM, {
        AlarmName: 'person-service-dev-ApiNearThrottleLimit',
        MetricName: 'Count',
        Period: 60,
        Threshold: 0.8 * API_THROTTLING.rateLimit * 60,
      });
    });

    it('subscribes no email unless one is configured', () => {
      synth('dev').resourcePropertiesCountIs('AWS::SNS::Subscription', { Protocol: 'email' }, 0);
    });
  });

  describe.each(STAGES)('%s stage', (stage) => {
    const template = synth(stage);

    it('creates the persons and phone-number tables with point-in-time recovery', () => {
      template.resourceCountIs(GLOBAL_TABLE, 2);
      template.allResourcesProperties(
        GLOBAL_TABLE,
        replicaWith({ PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true } }),
      );
    });

    it('streams new images from the persons table only', () => {
      template.hasResourceProperties(GLOBAL_TABLE, {
        KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
        StreamSpecification: { StreamViewType: 'NEW_IMAGE' },
      });
      template.hasResourceProperties(GLOBAL_TABLE, {
        KeySchema: [{ AttributeName: 'phoneNumber', KeyType: 'HASH' }],
        StreamSpecification: Match.absent(),
      });
    });
  });

  it('retains and deletion-protects tables in prod', () => {
    const template = synth('prod');
    template.allResources(GLOBAL_TABLE, {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    });
    template.allResourcesProperties(GLOBAL_TABLE, replicaWith({ DeletionProtectionEnabled: true }));
  });

  it('allows tables to be destroyed in dev', () => {
    const template = synth('dev');
    template.allResources(GLOBAL_TABLE, {
      DeletionPolicy: 'Delete',
      UpdateReplacePolicy: 'Delete',
    });
    template.allResourcesProperties(
      GLOBAL_TABLE,
      replicaWith({ DeletionProtectionEnabled: false }),
    );
  });
});
