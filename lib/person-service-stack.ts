import { CfnOutput, Stack, Tags, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { PersonApi } from './person-api';
import { PersonEvents } from './person-events';
import { PersonStorage } from './person-storage';
import { ServiceAlarms } from './service-alarms';
import type { Stage } from './stage';

export interface PersonServiceStackProps extends StackProps {
  readonly stage: Stage;
  // Optional address that receives alarm notifications.
  readonly alarmEmail?: string;
}

export class PersonServiceStack extends Stack {
  public readonly stage: Stage;
  public readonly storage: PersonStorage;
  public readonly api: PersonApi;
  public readonly events: PersonEvents;
  public readonly alarms: ServiceAlarms;

  constructor(scope: Construct, id: string, props: PersonServiceStackProps) {
    const tags = { Service: 'person-service', Stage: props.stage };

    // Stack-level tags (needed because of the explicitStackTags feature flag)...
    super(scope, id, { ...props, tags: { ...props.tags, ...tags } });
    this.stage = props.stage;

    // ...and resource-level tags, so they are visible in the synthesised template.
    for (const [key, value] of Object.entries(tags)) {
      Tags.of(this).add(key, value);
    }

    this.storage = new PersonStorage(this, 'Storage', { stage: props.stage });
    this.api = new PersonApi(this, 'Api', { stage: props.stage, storage: this.storage });
    this.events = new PersonEvents(this, 'Events', {
      stage: props.stage,
      persons: this.storage.persons,
    });

    this.alarms = new ServiceAlarms(this, 'Alarms', {
      service: 'person-service',
      stage: props.stage,
      alarmEmail: props.alarmEmail,
    });
    this.alarms.deadLetterQueueNotEmpty(
      'PipeDeadLetterQueue',
      this.events.deadLetterQueue,
      'A person-created event could not be published: reprocess from the stream within 24h',
    );
    this.alarms.apiServerErrors('Api', this.api.api);
    this.alarms.lambdaErrors('CreatePerson', this.api.createPersonFunction);
    this.alarms.lambdaErrors('GetPerson', this.api.getPersonFunction);
    this.alarms.lambdaErrors('ListPersons', this.api.listPersonsFunction);
    this.alarms.lambdaErrors('EventEnrichment', this.events.enrichmentFunction);

    new CfnOutput(this, 'ApiUrl', { value: this.api.api.url });
    new CfnOutput(this, 'PersonCreatedTopicArn', { value: this.events.topic.topicArn });
  }
}
