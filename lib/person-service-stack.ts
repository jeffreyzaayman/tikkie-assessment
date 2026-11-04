import { CfnOutput, Stack, Tags, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { PersonApi } from './person-api';
import { PersonEvents } from './person-events';
import { PersonStorage } from './person-storage';
import type { Stage } from './stage';

export interface PersonServiceStackProps extends StackProps {
  readonly stage: Stage;
}

export class PersonServiceStack extends Stack {
  public readonly stage: Stage;
  public readonly storage: PersonStorage;
  public readonly api: PersonApi;
  public readonly events: PersonEvents;

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

    new CfnOutput(this, 'ApiUrl', { value: this.api.api.url });
    new CfnOutput(this, 'PersonCreatedTopicArn', { value: this.events.topic.topicArn });
  }
}
