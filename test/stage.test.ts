import { App } from 'aws-cdk-lib';
import { describe, expect, it } from 'vitest';
import { PersonServiceStack } from '../lib/person-service-stack';
import { accountForStage, parseStage } from '../lib/stage';
import { WelcomeServiceStack } from '../lib/welcome-service-stack';
import { testApp } from './support/cdk';

function nodeWith(stageAccounts: unknown) {
  return new App({ context: { stageAccounts } }).node;
}

describe('parseStage', () => {
  it.each(['dev', 'prod'])('accepts %s', (stage) => {
    expect(parseStage(stage)).toBe(stage);
  });

  it.each([undefined, '', 'test', 1])('rejects %j', (value) => {
    expect(() => parseStage(value)).toThrow(/Invalid or missing stage context/);
  });
});

describe('accountForStage', () => {
  it.each([
    ['dev', '128955060979'],
    ['prod', '577995596848'],
  ] as const)('resolves %s to %s from cdk.json', (stage, account) => {
    expect(accountForStage(testApp().node, stage)).toBe(account);
  });

  it('throws when the stageAccounts map is missing', () => {
    expect(() => accountForStage(new App().node, 'dev')).toThrow(/Missing "stageAccounts" context/);
  });

  it('throws when the stage has no entry', () => {
    expect(() => accountForStage(nodeWith({ dev: '128955060979' }), 'prod')).toThrow(
      /Invalid or missing account for stage "prod"/,
    );
  });

  it.each(['12345', '1289550609790', '12895506097a', 128955060979])(
    'throws when the account is %j',
    (account) => {
      expect(() => accountForStage(nodeWith({ dev: account }), 'dev')).toThrow(
        /Invalid or missing account for stage "dev"/,
      );
    },
  );
});

describe('stack accounts', () => {
  it.each([
    ['dev', '128955060979'],
    ['prod', '577995596848'],
  ] as const)('binds the %s stacks to account %s', (stage, account) => {
    // Skip Lambda bundling: only the stack environment is under test.
    const app = testApp({ 'aws:cdk:bundling-stacks': [] });
    const env = { account: accountForStage(app.node, stage), region: 'eu-west-1' };
    const person = new PersonServiceStack(app, `PersonService-${stage}`, { stage, env });
    const welcome = new WelcomeServiceStack(app, `WelcomeService-${stage}`, { stage, env });

    expect(person.account).toBe(account);
    expect(welcome.account).toBe(account);
  });
});
