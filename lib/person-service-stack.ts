import { Stack, Tags, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { Stage } from './stage';

export interface PersonServiceStackProps extends StackProps {
  readonly stage: Stage;
}

export class PersonServiceStack extends Stack {
  public readonly stage: Stage;

  constructor(scope: Construct, id: string, props: PersonServiceStackProps) {
    const tags = { Service: 'person-service', Stage: props.stage };

    // Stack-level tags (needed because of the explicitStackTags feature flag)...
    super(scope, id, { ...props, tags: { ...props.tags, ...tags } });
    this.stage = props.stage;

    // ...and resource-level tags, so they are visible in the synthesised template.
    for (const [key, value] of Object.entries(tags)) {
      Tags.of(this).add(key, value);
    }
  }
}
