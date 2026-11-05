import { CfnOutput, Duration, RemovalPolicy, Stack, Tags, type StackProps } from 'aws-cdk-lib';
import { AttributeType, Billing, TableV2 } from 'aws-cdk-lib/aws-dynamodb';
import type { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { SqsSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import { Queue, QueueEncryption } from 'aws-cdk-lib/aws-sqs';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { personCreatedTopicArnParameterName } from './contracts';
import { handlerFunction } from './handler-function';
import { ServiceAlarms } from './service-alarms';
import type { Stage } from './stage';

export interface WelcomeServiceStackProps extends StackProps {
  readonly stage: Stage;
  // Optional address that receives alarm notifications.
  readonly alarmEmail?: string;
}

// Retries before a message moves to the dead-letter queue.
const MAX_RECEIVE_COUNT = 5;

/**
 * Demo consumer in the microservice landscape: a Welcome Service that reacts to new persons.
 *
 * It owns its queue and subscription; the Person Service doesn't know it exists. The topic is
 * found through the Person Service's SSM parameter (resolved at deploy time), not a
 * CloudFormation export, so either stack can be deployed without the other's template.
 */
export class WelcomeServiceStack extends Stack {
  public readonly stage: Stage;
  public readonly queue: Queue;
  public readonly deadLetterQueue: Queue;
  public readonly subscriptionDeadLetterQueue: Queue;
  public readonly processedEvents: TableV2;
  public readonly welcomeFunction: NodejsFunction;
  public readonly alarms: ServiceAlarms;

  constructor(scope: Construct, id: string, props: WelcomeServiceStackProps) {
    const tags = { Service: 'welcome-service', Stage: props.stage };

    // Stack-level tags (needed because of the explicitStackTags feature flag)...
    super(scope, id, { ...props, tags: { ...props.tags, ...tags } });
    this.stage = props.stage;

    // ...and resource-level tags, so they are visible in the synthesised template.
    for (const [key, value] of Object.entries(tags)) {
      Tags.of(this).add(key, value);
    }

    const topicArn = StringParameter.valueForStringParameter(
      this,
      personCreatedTopicArnParameterName(props.stage),
    );
    const topic = Topic.fromTopicArn(this, 'PersonCreatedTopic', topicArn);

    /*
     * SSE-SQS, not the AWS-managed aws/sqs KMS key: SNS can't use that key, and deliveries
     * would fail silently.
     */
    const queueDefaults = {
      encryption: QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
    };

    // Messages the consumer failed to process MAX_RECEIVE_COUNT times.
    this.deadLetterQueue = new Queue(this, 'DeadLetterQueue', {
      ...queueDefaults,
      retentionPeriod: Duration.days(14),
    });

    this.queue = new Queue(this, 'Queue', {
      ...queueDefaults,
      // At least 6x the consumer Lambda's timeout (10s), as AWS recommends for SQS event sources.
      visibilityTimeout: Duration.seconds(60),
      retentionPeriod: Duration.days(4),
      deadLetterQueue: { queue: this.deadLetterQueue, maxReceiveCount: MAX_RECEIVE_COUNT },
    });

    /*
     * Messages SNS couldn't deliver to the queue at all (e.g. a broken queue policy). SNS doesn't
     * retry those, so without this queue they would be lost.
     */
    this.subscriptionDeadLetterQueue = new Queue(this, 'SubscriptionDeadLetterQueue', {
      ...queueDefaults,
      retentionPeriod: Duration.days(14),
    });

    /*
     * Raw delivery: the queue receives the PersonCreated event itself, not an SNS envelope
     * around it. Also adds the queue policies that let only this topic send to the queues.
     */
    topic.addSubscription(
      new SqsSubscription(this.queue, {
        rawMessageDelivery: true,
        deadLetterQueue: this.subscriptionDeadLetterQueue,
      }),
    );

    /*
     * eventIds already handled, for deduplicating at-least-once deliveries. Entries expire via
     * TTL; losing them only risks a duplicate welcome, so the table isn't retained or backed up.
     */
    this.processedEvents = new TableV2(this, 'ProcessedEvents', {
      partitionKey: { name: 'eventId', type: AttributeType.STRING },
      billing: Billing.onDemand(),
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.welcomeFunction = handlerFunction(this, 'Welcome', {
      stage: props.stage,
      entryFile: 'welcome-person.ts',
      environment: { PROCESSED_EVENTS_TABLE_NAME: this.processedEvents.tableName },
    });
    // Claim an eventId (conditional put) and release it if the welcome fails; nothing else.
    this.processedEvents.grant(this.welcomeFunction, 'dynamodb:PutItem', 'dynamodb:DeleteItem');

    // Report failed messages individually, so one bad message doesn't retry the whole batch.
    this.welcomeFunction.addEventSource(
      new SqsEventSource(this.queue, { batchSize: 10, reportBatchItemFailures: true }),
    );

    this.alarms = new ServiceAlarms(this, 'Alarms', {
      service: 'welcome-service',
      stage: props.stage,
      alarmEmail: props.alarmEmail,
    });
    this.alarms.deadLetterQueueNotEmpty(
      'DeadLetterQueue',
      this.deadLetterQueue,
      'A person-created message failed processing 5 times: inspect it, fix, then redrive',
    );
    this.alarms.deadLetterQueueNotEmpty(
      'SubscriptionDeadLetterQueue',
      this.subscriptionDeadLetterQueue,
      'SNS could not deliver a person-created event to the queue: check the queue policy',
    );
    this.alarms.queueBacklogTooOld('Queue', this.queue, Duration.minutes(5));

    new CfnOutput(this, 'QueueUrl', { value: this.queue.queueUrl });
  }
}
