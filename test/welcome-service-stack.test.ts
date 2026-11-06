import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { STAGES, type Stage } from '../lib/stage';
import { WelcomeServiceStack } from '../lib/stacks/welcome-service-stack';
import { testApp, withoutAssetHashes } from './support/cdk';

const QUEUE = 'AWS::SQS::Queue';

const templates = new Map<Stage, Template>();

function synth(stage: Stage): Template {
  let template = templates.get(stage);
  if (!template) {
    const stack = new WelcomeServiceStack(testApp(), `WelcomeService-${stage}`, {
      stage,
      env: { region: 'eu-west-1' },
    });
    template = Template.fromStack(stack);
    templates.set(stage, template);
  }
  return template;
}

// The logical ID of the CloudFormation parameter that resolves the topic ARN from SSM.
function topicArnParameter(template: Template): string {
  const [id] = Object.keys(
    template.findParameters('*', { Type: 'AWS::SSM::Parameter::Value<String>' }),
  ).filter((key) => !key.startsWith('BootstrapVersion'));
  if (!id) {
    throw new Error('No SSM topic ARN parameter in the template');
  }
  return id;
}

const getAtt = (logicalIdPrefix: string) => ({
  'Fn::GetAtt': [Match.stringLikeRegexp(`^${logicalIdPrefix}`), 'Arn'],
});

describe('WelcomeServiceStack', () => {
  it('matches the synthesised template snapshot', () => {
    expect(withoutAssetHashes(synth('dev'))).toMatchSnapshot();
  });

  it.each(STAGES)('reads the %s topic ARN from SSM, not a CloudFormation export', (stage) => {
    const template = synth(stage);
    template.hasParameter(topicArnParameter(template), {
      Type: 'AWS::SSM::Parameter::Value<String>',
      Default: `/person-service/${stage}/person-created-topic-arn`,
    });
    expect(JSON.stringify(template.toJSON())).not.toMatch(/Fn::ImportValue|Fn::GetStackOutput/);
  });

  it('subscribes the queue to the topic with raw delivery and a subscription DLQ', () => {
    const template = synth('dev');
    template.resourceCountIs('AWS::SNS::Subscription', 1);
    template.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'sqs',
      TopicArn: { Ref: topicArnParameter(template) },
      Endpoint: getAtt('Queue'),
      RawMessageDelivery: true,
      RedrivePolicy: { deadLetterTargetArn: getAtt('SubscriptionDeadLetterQueue') },
    });
  });

  it('moves messages to the DLQ after 5 failed receives', () => {
    synth('dev').hasResourceProperties(QUEUE, {
      VisibilityTimeout: 60,
      RedrivePolicy: { deadLetterTargetArn: getAtt('DeadLetterQueue'), maxReceiveCount: 5 },
    });
  });

  it('encrypts every queue with SSE-SQS and keeps dead letters for 14 days', () => {
    const template = synth('dev');
    template.resourceCountIs(QUEUE, 3);
    template.allResourcesProperties(QUEUE, { SqsManagedSseEnabled: true });
    template.resourcePropertiesCountIs(QUEUE, { MessageRetentionPeriod: 14 * 24 * 60 * 60 }, 2);
  });

  it('lets only the person-created topic send to the queue and the subscription DLQ', () => {
    const template = synth('dev');
    const allowTopic = Match.objectLike({
      Action: 'sqs:SendMessage',
      Effect: 'Allow',
      Principal: { Service: 'sns.amazonaws.com' },
      Condition: { ArnEquals: { 'aws:SourceArn': { Ref: topicArnParameter(template) } } },
    });
    for (const queue of ['Queue', 'SubscriptionDeadLetterQueue']) {
      template.hasResourceProperties('AWS::SQS::QueuePolicy', {
        Queues: [{ Ref: Match.stringLikeRegexp(`^${queue}[0-9A-F]{8}$`) }],
        PolicyDocument: { Statement: Match.arrayWith([allowTopic]) },
      });
    }
  });

  it('creates the subscription only after the queue policy allows SNS', () => {
    const subscriptions = synth('dev').findResources('AWS::SNS::Subscription');
    const [subscription] = Object.values(subscriptions) as { DependsOn?: string[] }[];
    expect(subscription?.DependsOn).toEqual([expect.stringMatching(/^QueuePolicy/)]);
  });

  it('keeps processed eventIds in an on-demand table that expires them via TTL', () => {
    synth('dev').hasResource('AWS::DynamoDB::GlobalTable', {
      Properties: {
        KeySchema: [{ AttributeName: 'eventId', KeyType: 'HASH' }],
        BillingMode: 'PAY_PER_REQUEST',
        TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
      },
      DeletionPolicy: 'Delete',
    });
  });

  it('runs at most 50 welcome Lambdas from the queue, reporting failed messages individually', () => {
    const template = synth('dev');
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs24.x',
      Timeout: 10,
      Environment: {
        Variables: Match.objectLike({ PROCESSED_EVENTS_TABLE_NAME: { Ref: Match.anyValue() } }),
      },
    });
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      EventSourceArn: getAtt('Queue'),
      BatchSize: 10,
      ScalingConfig: { MaximumConcurrency: 50 },
      FunctionResponseTypes: ['ReportBatchItemFailures'],
    });
  });

  it('keeps the visibility timeout at least 6x the Lambda timeout', () => {
    const template = synth('dev');
    const [fn] = Object.values(template.findResources('AWS::Lambda::Function')) as {
      Properties: { Timeout: number };
    }[];
    const queues = template.findResources(QUEUE, {
      Properties: { RedrivePolicy: Match.anyValue() },
    });
    const [queue] = Object.values(queues) as { Properties: { VisibilityTimeout: number } }[];
    expect(queue?.Properties.VisibilityTimeout).toBeGreaterThanOrEqual(
      6 * (fn?.Properties.Timeout ?? 0),
    );
  });

  it('grants the welcome Lambda only PutItem/DeleteItem on its table and consume on its queue', () => {
    const template = synth('dev');
    template.resourceCountIs('AWS::IAM::Policy', 1);
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: [
          {
            Action: ['dynamodb:DeleteItem', 'dynamodb:PutItem'],
            Effect: 'Allow',
            Resource: getAtt('ProcessedEvents'),
          },
          {
            Action: [
              'sqs:ChangeMessageVisibility',
              'sqs:DeleteMessage',
              'sqs:GetQueueAttributes',
              'sqs:GetQueueUrl',
              'sqs:ReceiveMessage',
            ],
            Effect: 'Allow',
            Resource: getAtt('Queue'),
          },
        ],
      },
    });
  });

  it('alarms on both dead-letter queues, a stuck consumer and throttling', () => {
    const template = synth('dev');
    const alarm = (name: string, metric: string, queue: string, threshold: number) =>
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: `welcome-service-dev-${name}`,
        MetricName: metric,
        Threshold: threshold,
        Dimensions: [
          {
            Name: 'QueueName',
            Value: { 'Fn::GetAtt': [Match.stringLikeRegexp(`^${queue}[0-9A-F]{8}$`), 'QueueName'] },
          },
        ],
        AlarmActions: [{ Ref: Match.stringLikeRegexp('^AlarmsTopic') }],
      });
    template.resourceCountIs('AWS::CloudWatch::Alarm', 5);
    alarm('DeadLetterQueueNotEmpty', 'ApproximateNumberOfMessagesVisible', 'DeadLetterQueue', 1);
    alarm(
      'SubscriptionDeadLetterQueueNotEmpty',
      'ApproximateNumberOfMessagesVisible',
      'SubscriptionDeadLetterQueue',
      1,
    );
    alarm('QueueOldestMessage', 'ApproximateAgeOfOldestMessage', 'Queue', 300);
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'welcome-service-dev-WelcomeThrottles',
      MetricName: 'Throttles',
    });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'welcome-service-dev-ProcessedEventsWriteThrottles',
      MetricName: 'WriteThrottleEvents',
    });
  });

  it('tags resources with the welcome-service name and stage', () => {
    synth('prod').allResourcesProperties(QUEUE, {
      Tags: Match.arrayWith([
        { Key: 'Service', Value: 'welcome-service' },
        { Key: 'Stage', Value: 'prod' },
      ]),
    });
  });
});
