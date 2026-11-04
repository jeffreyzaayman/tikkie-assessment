import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { PersonServiceStack } from '../lib/person-service-stack';
import { STAGES, type Stage } from '../lib/stage';

const GLOBAL_TABLE = 'AWS::DynamoDB::GlobalTable';

function synth(stage: Stage): Template {
  const app = new App();
  const stack = new PersonServiceStack(app, `PersonService-${stage}`, {
    stage,
    env: { region: 'eu-west-1' },
  });
  return Template.fromStack(stack);
}

function replicaWith(props: Record<string, unknown>) {
  return { Replicas: Match.arrayWith([Match.objectLike(props)]) };
}

describe('PersonServiceStack', () => {
  it('matches the synthesised template snapshot', () => {
    expect(synth('dev').toJSON()).toMatchSnapshot();
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
