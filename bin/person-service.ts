import { App } from 'aws-cdk-lib';
import { PersonServiceStack } from '../lib/person-service-stack';
import { parseStage } from '../lib/stage';
import { WelcomeServiceStack } from '../lib/welcome-service-stack';

const REGION = 'eu-west-1';

const app = new App();
const stage = parseStage(app.node.tryGetContext('stage'));
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: REGION };

const personService = new PersonServiceStack(app, `PersonService-${stage}`, {
  stackName: `PersonService-${stage}`,
  stage,
  env,
  description: `Person service (${stage})`,
});

// A separate service in the same account (in a real landscape: its own repo and account).
const welcomeService = new WelcomeServiceStack(app, `WelcomeService-${stage}`, {
  stackName: `WelcomeService-${stage}`,
  stage,
  env,
  description: `Welcome service: person-created consumer (${stage})`,
});
// Deploy order only: the SSM parameter must exist first. No CloudFormation export is created.
welcomeService.addStackDependency(personService, 'Reads the person-created topic ARN from SSM');
