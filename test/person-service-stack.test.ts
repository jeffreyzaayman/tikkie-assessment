import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { PersonServiceStack } from '../lib/person-service-stack';

describe('PersonServiceStack', () => {
  it('matches the synthesised template snapshot', () => {
    const app = new App();
    const stack = new PersonServiceStack(app, 'PersonService-dev', {
      stage: 'dev',
      env: { region: 'eu-west-1' },
    });

    expect(Template.fromStack(stack).toJSON()).toMatchSnapshot();
  });
});
