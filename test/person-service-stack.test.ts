import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { PersonServiceStack } from '../lib/person-service-stack';
import { STAGES, type Stage } from '../lib/stage';

const GLOBAL_TABLE = 'AWS::DynamoDB::GlobalTable';

// Use the same feature flags as the CDK CLI, so tests see the template that gets deployed.
const cdkJson = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'cdk.json'), 'utf8')) as {
  context: Record<string, unknown>;
};

// Synthesise (and bundle the Lambdas) once per stage, shared by all tests.
const templates = new Map<Stage, Template>();

function synth(stage: Stage): Template {
  let template = templates.get(stage);
  if (!template) {
    const app = new App({ context: cdkJson.context });
    const stack = new PersonServiceStack(app, `PersonService-${stage}`, {
      stage,
      env: { region: 'eu-west-1' },
    });
    template = Template.fromStack(stack);
    templates.set(stage, template);
  }
  return template;
}

/** Replaces Lambda asset hashes so handler code changes don't churn the snapshot. */
function withoutAssetHashes(template: Template): unknown {
  return JSON.parse(
    JSON.stringify(template.toJSON()).replace(/[0-9a-f]{64}(\.zip)?/g, '[ASSET_HASH]$1'),
  );
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
    template.resourceCountIs('AWS::ApiGateway::Method', 2);
    template.hasResourceProperties('AWS::ApiGateway::Method', { HttpMethod: 'POST' });
    template.hasResourceProperties('AWS::ApiGateway::Method', { HttpMethod: 'GET' });
    template.allResourcesProperties('AWS::ApiGateway::Method', { AuthorizationType: 'AWS_IAM' });
  });

  describe('least-privilege table access', () => {
    const tableArn = (logicalIdPrefix: string) => ({
      'Fn::GetAtt': [Match.stringLikeRegexp(`^Storage${logicalIdPrefix}`), 'Arn'],
    });
    const roleOf = (functionPrefix: string) => [
      { Ref: Match.stringLikeRegexp(`^Api${functionPrefix}FunctionServiceRole`) },
    ];

    it('has one policy per function and nothing else', () => {
      synth('dev').resourceCountIs('AWS::IAM::Policy', 2);
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
