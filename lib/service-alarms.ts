import { ArnFormat, Duration, Stack } from 'aws-cdk-lib';
import type { RestApi } from 'aws-cdk-lib/aws-apigateway';
import {
  Alarm,
  ComparisonOperator,
  TreatMissingData,
  type IMetric,
} from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import { PolicyStatement, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import type { IFunction } from 'aws-cdk-lib/aws-lambda';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { EmailSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import type { IQueue } from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import type { Stage } from './stage';

export interface ServiceAlarmsProps {
  // Used in alarm and topic names, e.g. `person-service`.
  readonly service: string;
  readonly stage: Stage;
  // Optional address subscribed to the alarm topic (the recipient must confirm by email).
  readonly alarmEmail?: string;
}

// Evaluation window for every alarm: short enough to react, long enough for metric delays.
const PERIOD = Duration.minutes(5);

/**
 * Minimal alerting for one service: an alarm topic, and single-metric alarms with fixed
 * thresholds that notify it on ALARM and OK. Missing data is treated as OK, because Lambda and
 * API Gateway publish no metrics without traffic.
 */
export class ServiceAlarms extends Construct {
  public readonly topic: Topic;
  public readonly alarms: Alarm[] = [];

  private readonly namePrefix: string;
  private readonly action: SnsAction;

  constructor(scope: Construct, id: string, props: ServiceAlarmsProps) {
    super(scope, id);
    this.namePrefix = `${props.service}-${props.stage}`;

    // No personal data goes to this topic (alarm states only), so it isn't encrypted.
    this.topic = new Topic(this, 'Topic', {
      displayName: `${this.namePrefix} alarms`,
      enforceSSL: true,
    });
    /*
     * enforceSSL attaches a topic policy, which replaces the default one that lets AWS services
     * in the account publish. CloudWatch publishes as its service principal (not an IAM role), so
     * allow it explicitly, limited to this account's alarms of this service.
     */
    const stack = Stack.of(this);
    this.topic.addToResourcePolicy(
      new PolicyStatement({
        sid: 'AllowCloudWatchAlarms',
        principals: [new ServicePrincipal('cloudwatch.amazonaws.com')],
        actions: ['sns:Publish'],
        resources: [this.topic.topicArn],
        conditions: {
          StringEquals: { 'aws:SourceAccount': stack.account },
          ArnLike: {
            'aws:SourceArn': stack.formatArn({
              service: 'cloudwatch',
              resource: 'alarm',
              resourceName: `${this.namePrefix}-*`,
              arnFormat: ArnFormat.COLON_RESOURCE_NAME,
            }),
          },
        },
      }),
    );
    if (props.alarmEmail) {
      this.topic.addSubscription(new EmailSubscription(props.alarmEmail));
    }
    this.action = new SnsAction(this.topic);
  }

  // Alarms when any message is waiting in a dead-letter queue: each one needs a look.
  public deadLetterQueueNotEmpty(id: string, queue: IQueue, description: string): Alarm {
    return this.add(`${id}NotEmpty`, {
      metric: queue.metricApproximateNumberOfMessagesVisible({
        period: PERIOD,
        statistic: 'Maximum',
      }),
      threshold: 1,
      description,
    });
  }

  // Alarms when the oldest message has waited longer than `maxAge`: the consumer is stuck.
  public queueBacklogTooOld(id: string, queue: IQueue, maxAge: Duration): Alarm {
    return this.add(`${id}OldestMessage`, {
      metric: queue.metricApproximateAgeOfOldestMessage({ period: PERIOD, statistic: 'Maximum' }),
      threshold: maxAge.toSeconds(),
      description: `Oldest message on ${id} waited more than ${maxAge.toHumanString()}: the consumer may be stuck or failing`,
    });
  }

  // Alarms on any invocation error (crash or timeout); handled errors don't count.
  public lambdaErrors(id: string, fn: IFunction): Alarm {
    return this.add(`${id}Errors`, {
      metric: fn.metricErrors({ period: PERIOD, statistic: 'Sum' }),
      threshold: 1,
      description: `The ${id} Lambda failed (crash or timeout)`,
    });
  }

  // Alarms on any 5XX response, including the 500s the handlers return themselves.
  public apiServerErrors(id: string, api: RestApi): Alarm {
    return this.add(`${id}5xx`, {
      metric: api.metricServerError({ period: PERIOD, statistic: 'Sum' }),
      threshold: 1,
      description: 'The API returned a 5XX response',
    });
  }

  private add(
    id: string,
    props: { metric: IMetric; threshold: number; description: string },
  ): Alarm {
    const alarm = new Alarm(this, id, {
      alarmName: `${this.namePrefix}-${id}`,
      alarmDescription: props.description,
      metric: props.metric,
      threshold: props.threshold,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
    alarm.addAlarmAction(this.action);
    alarm.addOkAction(this.action);
    this.alarms.push(alarm);
    return alarm;
  }
}

// Returns the optional alarm email from CDK context; fails fast on anything that isn't one.
export function parseAlarmEmail(value: unknown): string | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }
  if (typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    return value;
  }
  throw new Error(`Invalid alarmEmail context: ${JSON.stringify(value)}. Pass an email address.`);
}
