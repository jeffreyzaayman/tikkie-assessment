import { Duration, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import { describe, expect, it } from 'vitest';
import { parseAlarmEmail, ServiceAlarms } from '../lib/service-alarms';
import { testApp } from './support/cdk';

const ALARM = 'AWS::CloudWatch::Alarm';

function alarmsStack(alarmEmail?: string) {
  const stack = new Stack(testApp(), 'Test', { env: { region: 'eu-west-1' } });
  const alarms = new ServiceAlarms(stack, 'Alarms', { service: 'demo', stage: 'dev', alarmEmail });
  return { stack, alarms, queue: new Queue(stack, 'Queue') };
}

describe('ServiceAlarms', () => {
  it('subscribes the alarm email to the topic when given', () => {
    const { stack } = alarmsStack('alerts@example.com');
    Template.fromStack(stack).hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'email',
      Endpoint: 'alerts@example.com',
      TopicArn: { Ref: Match.stringLikeRegexp('^AlarmsTopic') },
    });
  });

  it('creates the topic without subscriptions when no email is given', () => {
    const { stack } = alarmsStack();
    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::SNS::Topic', 1);
    template.resourceCountIs('AWS::SNS::Subscription', 0);
  });

  it("lets CloudWatch publish this service's alarms to the topic, over TLS only", () => {
    const { stack } = alarmsStack();
    Template.fromStack(stack).hasResourceProperties('AWS::SNS::TopicPolicy', {
      PolicyDocument: {
        Statement: [
          Match.objectLike({
            Effect: 'Deny',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
          {
            Sid: 'AllowCloudWatchAlarms',
            Effect: 'Allow',
            Principal: { Service: 'cloudwatch.amazonaws.com' },
            Action: 'sns:Publish',
            Resource: { Ref: Match.stringLikeRegexp('^AlarmsTopic') },
            Condition: {
              StringEquals: { 'aws:SourceAccount': { Ref: 'AWS::AccountId' } },
              ArnLike: {
                'aws:SourceArn': {
                  'Fn::Join': [
                    '',
                    [
                      'arn:aws:cloudwatch:eu-west-1:',
                      { Ref: 'AWS::AccountId' },
                      ':alarm:demo-dev-*',
                    ],
                  ],
                },
              },
            },
          },
        ],
      },
    });
  });

  it('alarms on a non-empty dead-letter queue, notifying the topic on ALARM and OK', () => {
    const { stack, alarms, queue } = alarmsStack();
    alarms.deadLetterQueueNotEmpty('Dlq', queue, 'Something to look at');

    const topic = { Ref: Match.stringLikeRegexp('^AlarmsTopic') };
    Template.fromStack(stack).hasResourceProperties(ALARM, {
      AlarmName: 'demo-dev-DlqNotEmpty',
      AlarmDescription: 'Something to look at',
      Namespace: 'AWS/SQS',
      MetricName: 'ApproximateNumberOfMessagesVisible',
      Statistic: 'Maximum',
      Period: 300,
      Threshold: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      EvaluationPeriods: 1,
      TreatMissingData: 'notBreaching',
      AlarmActions: [topic],
      OKActions: [topic],
    });
  });

  it('alarms when the oldest queued message is older than the given age', () => {
    const { stack, alarms, queue } = alarmsStack();
    alarms.queueBacklogTooOld('Queue', queue, Duration.minutes(5));

    Template.fromStack(stack).hasResourceProperties(ALARM, {
      AlarmName: 'demo-dev-QueueOldestMessage',
      MetricName: 'ApproximateAgeOfOldestMessage',
      Statistic: 'Maximum',
      Threshold: 300,
    });
  });

  it('keeps every alarm in the alarms list', () => {
    const { alarms, queue } = alarmsStack();
    alarms.deadLetterQueueNotEmpty('A', queue, 'a');
    alarms.queueBacklogTooOld('B', queue, Duration.minutes(1));

    expect(alarms.alarms).toHaveLength(2);
  });
});

describe('parseAlarmEmail', () => {
  it.each([undefined, ''])('returns undefined for %j (no email configured)', (value) => {
    expect(parseAlarmEmail(value)).toBeUndefined();
  });

  it('accepts an email address', () => {
    expect(parseAlarmEmail('alerts@example.com')).toBe('alerts@example.com');
  });

  it.each(['not-an-email', 'a@b', 42, 'two words@example.com'])('rejects %j', (value) => {
    expect(() => parseAlarmEmail(value)).toThrow('Invalid alarmEmail context');
  });
});
