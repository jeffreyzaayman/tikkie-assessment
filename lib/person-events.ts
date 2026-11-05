import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import type { TableV2 } from 'aws-cdk-lib/aws-dynamodb';
import { Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import type { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { CfnPipe } from 'aws-cdk-lib/aws-pipes';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { Queue, QueueEncryption } from 'aws-cdk-lib/aws-sqs';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { personCreatedTopicArnParameterName } from './contracts';
import { handlerFunction } from './handler-function';
import type { Stage } from './stage';

export interface PersonEventsProps {
  readonly stage: Stage;
  // The persons table; its stream (NEW_IMAGE) is the event source.
  readonly persons: TableV2;
}

/**
 * Publishes a person-created event for every new person:
 * persons stream → EventBridge Pipe (INSERT filter + enrichment Lambda) → SNS topic.
 *
 * Stream-based (outbox pattern): an event exists only if the DynamoDB write committed.
 * Consumers find the topic through an SSM parameter, not a CloudFormation export.
 */
export class PersonEvents extends Construct {
  public readonly topic: Topic;
  public readonly deadLetterQueue: Queue;
  public readonly enrichmentFunction: NodejsFunction;
  public readonly pipe: CfnPipe;
  public readonly topicArnParameter: StringParameter;

  constructor(scope: Construct, id: string, props: PersonEventsProps) {
    super(scope, id);
    const { stage, persons } = props;
    const isProd = stage === 'prod';
    const removalPolicy = isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;
    const name = `person-service-${stage}-person-created`;

    if (!persons.tableStreamArn) {
      throw new Error('The persons table needs a stream for person-created events');
    }

    /*
     * Fixed name, so the ARN (and the consumers' subscriptions) survive a stack update; a change
     * that would replace the topic fails instead. Retained in prod like the tables.
     * Unencrypted for now: see the encryption TODO in docs/PLAN.md.
     */
    this.topic = new Topic(this, 'Topic', { topicName: name, enforceSSL: true });
    this.topic.applyRemovalPolicy(removalPolicy);

    /*
     * Records the Pipe can't deliver after its retries. For stream sources the message holds the
     * shard and sequence numbers, not the record: reprocess within the stream's 24h retention.
     */
    this.deadLetterQueue = new Queue(this, 'DeadLetterQueue', {
      encryption: QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
    });

    this.enrichmentFunction = handlerFunction(this, 'Enrichment', {
      stage,
      entryFile: 'enrich-person-created.ts',
    });

    // Errors only, and no execution data: the records contain personal data.
    const logGroup = new LogGroup(this, 'PipeLogs', {
      retention: RetentionDays.ONE_MONTH,
      removalPolicy,
    });

    const role = new Role(this, 'PipeRole', {
      assumedBy: new ServicePrincipal('pipes.amazonaws.com', {
        conditions: { StringEquals: { 'aws:SourceAccount': Stack.of(this).account } },
      }),
      description: `Role for the ${name} pipe`,
    });
    persons.grantStreamRead(role);
    this.enrichmentFunction.grantInvoke(role);
    this.topic.grantPublish(role);
    this.deadLetterQueue.grantSendMessages(role);
    logGroup.grantWrite(role);

    this.pipe = new CfnPipe(this, 'Pipe', {
      name,
      description: 'Publishes person-created events from the persons table stream',
      roleArn: role.roleArn,
      source: persons.tableStreamArn,
      sourceParameters: {
        filterCriteria: { filters: [{ pattern: JSON.stringify({ eventName: ['INSERT'] }) }] },
        dynamoDbStreamParameters: {
          startingPosition: 'LATEST',
          batchSize: 10,
          maximumRetryAttempts: 10,
          onPartialBatchItemFailure: 'AUTOMATIC_BISECT',
          deadLetterConfig: { arn: this.deadLetterQueue.queueArn },
        },
      },
      enrichment: this.enrichmentFunction.functionArn,
      target: this.topic.topicArn,
      logConfiguration: {
        level: 'ERROR',
        cloudwatchLogsLogDestination: { logGroupArn: logGroup.logGroupArn },
      },
    });
    // The Pipe validates its permissions on creation, so create the role's policy first.
    this.pipe.node.addDependency(role);

    this.topicArnParameter = new StringParameter(this, 'TopicArnParameter', {
      parameterName: personCreatedTopicArnParameterName(stage),
      stringValue: this.topic.topicArn,
      description: 'ARN of the person-created SNS topic, for consumers to subscribe to',
    });
  }
}
