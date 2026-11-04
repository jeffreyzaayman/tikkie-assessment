import { App } from 'aws-cdk-lib';
import { PersonServiceStack } from '../lib/person-service-stack';
import { parseStage } from '../lib/stage';

const REGION = 'eu-west-1';

const app = new App();
const stage = parseStage(app.node.tryGetContext('stage'));

new PersonServiceStack(app, `PersonService-${stage}`, {
  stackName: `PersonService-${stage}`,
  stage,
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: REGION },
  description: `Person service (${stage})`,
});
