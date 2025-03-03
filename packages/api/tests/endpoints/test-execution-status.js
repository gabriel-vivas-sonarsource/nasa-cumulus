'use strict';

const request = require('supertest');
const test = require('ava');
const sinon = require('sinon');
const awsServices = require('@cumulus/aws-client/services');
const {
  putJsonS3Object,
  recursivelyDeleteS3Bucket,
} = require('@cumulus/aws-client/S3');
const StepFunctions = require('@cumulus/aws-client/StepFunctions');
const cryptoRandomString = require('crypto-random-string');

const { randomId, randomString } = require('@cumulus/common/test-utils');
const {
  localStackConnectionEnv,
  destroyLocalTestDb,
  generateLocalTestDb,
  migrationDir,
  CollectionPgModel,
  GranulePgModel,
  ExecutionPgModel,
  upsertGranuleWithExecutionJoinRecord,
  fakeCollectionRecordFactory,
  fakeGranuleRecordFactory,
  fakeExecutionRecordFactory,
  translateApiExecutionToPostgresExecution,
} = require('@cumulus/db');
const { constructCollectionId } = require('@cumulus/message/Collections');
const { AccessToken, Collection, Execution, Granule } = require('../../models');
const assertions = require('../../lib/assertions');
const {
  createFakeJwtAuthToken,
  fakeCollectionFactory,
  setAuthorizedOAuthUsers,
  fakeGranuleFactoryV2,
  fakeExecutionFactoryV2,
} = require('../../lib/testUtils');

process.env.AccessTokensTable = randomString();
process.env.ExecutionsTable = randomString();
process.env.CollectionsTable = randomString();
process.env.GranulesTable = randomString();
process.env.TOKEN_SECRET = randomString();

// import the express app after setting the env variables
const { app } = require('../../app');

const executionArn = 'arn:aws:states:us-east-1:xxx:execution:discoverGranulesStateMachine:3ea094d8';

const executionStatusCommon = {
  executionArn,
  stateMachineArn: 'arn:aws:states:us-east-1:xxx:stateMachine:discoverGranulesStateMachine:3ea094d8',
  name: '3ea094d8',
  status: 'SUCCEEDED',
  startDate: 'date',
  stopDate: 'date',
};

const fakeExecution = fakeExecutionFactoryV2({
  arn: executionArn,
  parentArn: undefined,
});

const cumulusMetaOutput = () => ({
  cumulus_meta: {
    state_machine: 'arn:aws:states:us-east-1:xxx:stateMachine:discoverGranulesStateMachine',
    message_source: 'sfn',
    workflow_start_time: 1536279498569,
    execution_name: '3ea094d8',
    system_bucket: process.env.system_bucket,
  },
});

const expiredExecutionArn = 'fakeExpiredExecutionArn';
const expiredMissingExecutionArn = 'fakeMissingExpiredExecutionArn';

const testDbName = randomId('execution-status_test');
const replaceObject = (lambdaEvent = true) => ({
  replace: {
    Bucket: process.env.system_bucket,
    Key: lambdaEvent ? 'events/lambdaEventUUID' : 'events/executionEventUUID',
  },
});

const remoteExecutionOutput = () => ({
  ...cumulusMetaOutput(),
  ...replaceObject(false),
});

const fullMessageOutput = () => ({
  ...cumulusMetaOutput(),
  meta: {},
  payload: {},
  exception: 'None',
  workflow_config: {},
});

const lambdaCommonOutput = () => ({
  cumulus_meta: {
    message_source: 'sfn',
    process: 'modis',
    execution_name: 'bae909c1',
    state_machine: 'arn:aws:states:us-east-1:xxx:stateMachine:testIngestGranuleStateMachine-222',
    workflow_start_time: 111,
    system_bucket: process.env.system_bucket,
  },
  meta: {
    sync_granule_duration: 2872,
  },
});

const lambdaRemoteOutput = () => ({
  ...replaceObject(),
  ...lambdaCommonOutput(),
});

const lambdaCompleteOutput = () => ({
  ...lambdaCommonOutput(),
  payload: {
    message: 'Big message',
  },
  exception: 'None',
});

const lambdaEventOutput = () => ({
  type: 'TaskStateExited',
  id: 13,
  previousEventId: 12,
  name: 'SyncGranule',
  output: JSON.stringify(lambdaCompleteOutput()),
});

const lambdaFunctionEvent = () => ({
  type: 'TaskStateExited',
  id: 13,
  previousEventId: 12,
  stateExitedEventDetails: {
    name: 'SyncGranule',
    output: JSON.stringify(lambdaRemoteOutput()),
  },
});

const stepFunctionMock = {
  getExecutionStatus: (arn) =>
    new Promise((resolve) => {
      let executionStatus;
      if (arn === 'stillRunning') {
        executionStatus = { ...executionStatusCommon };
      } else {
        executionStatus = {
          ...executionStatusCommon,
          output: arn === 'hasFullMessage' ? JSON.stringify(fullMessageOutput()) : JSON.stringify(remoteExecutionOutput()),
        };
      }
      resolve({
        execution: executionStatus,
        executionHistory: {
          events: [
            lambdaFunctionEvent(),
          ],
        },
        stateMachine: {},
      });
    }),
};

const executionExistsMock = (arn) => {
  if ((arn.executionArn === expiredExecutionArn)
      || (arn.executionArn === expiredMissingExecutionArn)) {
    return {
      promise: () => {
        const error = new Error();
        error.code = 'ExecutionDoesNotExist';
        return Promise.reject(error);
      },
    };
  }
  return {
    promise: () => Promise.resolve(true),
  };
};

let jwtAuthToken;
let accessTokenModel;
let collectionModel;
let granuleModel;
let executionModel;
let mockedSF;
let mockedSFExecution;
let collectionPgModel;
let granulePgModel;
let fakeExecutionStatusGranules;

test.before(async (t) => {
  process.env.system_bucket = cryptoRandomString({ length: 10 });
  await awsServices.s3().createBucket({ Bucket: process.env.system_bucket });

  await putJsonS3Object(
    process.env.system_bucket,
    'events/lambdaEventUUID',
    lambdaCompleteOutput()
  );

  await putJsonS3Object(
    process.env.system_bucket,
    'events/executionEventUUID',
    fullMessageOutput()
  );

  mockedSF = sinon.stub(StepFunctions, 'getExecutionStatus').callsFake(stepFunctionMock.getExecutionStatus);
  mockedSFExecution = sinon
    .stub(awsServices.sfn(), 'describeExecution')
    .callsFake(executionExistsMock);

  const username = cryptoRandomString({ length: 10 });
  await setAuthorizedOAuthUsers([username]);

  accessTokenModel = new AccessToken();
  await accessTokenModel.createTable();

  jwtAuthToken = await createFakeJwtAuthToken({ accessTokenModel, username });
  const { knex, knexAdmin } = await generateLocalTestDb(testDbName, migrationDir);
  t.context.knex = knex;
  t.context.knexAdmin = knexAdmin;
  process.env = {
    ...process.env,
    ...localStackConnectionEnv,
    PG_DATABASE: testDbName,
  };

  const originalPayload = {
    original: 'payload',
  };
  const finalPayload = {
    final: 'payload',
  };
  t.context.fakeExecutionRecord = fakeExecutionRecordFactory({
    arn: expiredExecutionArn,
    original_payload: originalPayload,
    final_payload: finalPayload,
    duration: Math.floor(Math.random() * 100),
  });
  const executionPgModel = new ExecutionPgModel();
  const [createdExpiredExecutionRecord] = await executionPgModel.create(
    t.context.knex,
    t.context.fakeExecutionRecord
  );
  const expiredExecutionPgRecordId = createdExpiredExecutionRecord.cumulus_id;

  // create fake Collections table
  collectionModel = new Collection();
  await collectionModel.createTable();

  // create fake Granules table
  granuleModel = new Granule();
  await granuleModel.createTable();

  // create fake Executions table
  executionModel = new Execution();
  await executionModel.createTable();
  await executionModel.create(fakeExecution);

  process.env = {
    ...process.env,
    ...localStackConnectionEnv,
    PG_DATABASE: testDbName,
  };

  // Create collections in Dynamo and Postgres
  // we need this because a granule has a foreign key referring to collections
  const collectionName = 'fakeCollection';
  const collectionVersion = 'v1';

  collectionPgModel = new CollectionPgModel();
  granulePgModel = new GranulePgModel();

  t.context.testCollection = fakeCollectionFactory({
    name: collectionName,
    version: collectionVersion,
    duplicateHandling: 'error',
  });
  const dynamoCollection = await collectionModel.create(
    t.context.testCollection
  );
  t.context.collectionId = constructCollectionId(
    dynamoCollection.name,
    dynamoCollection.version
  );

  const fakePgCollection = fakeCollectionRecordFactory({
    name: collectionName,
    version: collectionVersion,
  });

  const [pgCollection] = await collectionPgModel.create(
    knex,
    fakePgCollection
  );
  t.context.collectionCumulusId = pgCollection.cumulus_id;

  const executionPgRecord = await translateApiExecutionToPostgresExecution(
    fakeExecution,
    knex
  );
  const [pgExecution] = await executionPgModel.create(knex, executionPgRecord);
  const executionPgRecordId = pgExecution.cumulus_id;

  const granuleId1 = randomId('granuleId1');
  const granuleId2 = randomId('granuleId2');

  // create fake Dynamo granule records
  t.context.fakeGranules = [
    fakeGranuleFactoryV2({ granuleId: granuleId1, status: 'completed', collectionId: t.context.collectionId }),
    fakeGranuleFactoryV2({ granuleId: granuleId2, status: 'failed', collectionId: t.context.collectionId }),
  ];

  await granuleModel.create(t.context.fakeGranules[0]);
  await granuleModel.create(t.context.fakeGranules[1]);

  // create fake Postgres granule records
  t.context.fakePGGranules = [
    fakeGranuleRecordFactory({
      granule_id: granuleId1,
      status: 'completed',
      collection_cumulus_id: t.context.collectionCumulusId,
    }),
    fakeGranuleRecordFactory({
      granule_id: granuleId2,
      status: 'failed',
      collection_cumulus_id: t.context.collectionCumulusId,
    }),
  ];

  fakeExecutionStatusGranules = [];
  fakeExecutionStatusGranules.push({
    granuleId: granuleId1,
    collectionId: t.context.collectionId,
  });

  [t.context.granuleCumulusId] = await Promise.all(
    t.context.fakePGGranules.map(async (granule) =>
      await granulePgModel.create(knex, granule))
  );

  await upsertGranuleWithExecutionJoinRecord(
    knex, t.context.fakePGGranules[0], executionPgRecordId
  );
  await upsertGranuleWithExecutionJoinRecord(
    knex, t.context.fakePGGranules[0], expiredExecutionPgRecordId
  );
});

test.after.always(async (t) => {
  await recursivelyDeleteS3Bucket(process.env.system_bucket);
  await accessTokenModel.deleteTable();
  mockedSF.restore();
  mockedSFExecution.restore();
  await executionModel.deleteTable();
  await collectionModel.deleteTable();
  await granuleModel.deleteTable();

  await destroyLocalTestDb({
    knex: t.context.knex,
    knexAdmin: t.context.knexAdmin,
    testDbName,
  });
});

test('CUMULUS-911 GET without an Authorization header returns an Authorization Missing response', async (t) => {
  const response = await request(app)
    .get('/executions/status/asdf')
    .set('Accept', 'application/json')
    .expect(401);

  assertions.isAuthorizationMissingResponse(t, response);
});

test('CUMULUS-912 GET with an invalid access token returns an unauthorized response', async (t) => {
  const response = await request(app)
    .get('/executions/status/asdf')
    .set('Accept', 'application/json')
    .set('Authorization', 'Bearer ThisIsAnInvalidAuthorizationToken')
    .expect(401);

  assertions.isInvalidAccessTokenResponse(t, response);
});

test.todo('CUMULUS-912 GET with an unauthorized user returns an unauthorized response');

test('returns ARNs for execution and state machine', async (t) => {
  const response = await request(app)
    .get('/executions/status/hasFullMessage')
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  const executionStatus = response.body;
  t.is(executionStatusCommon.stateMachineArn, executionStatus.execution.stateMachineArn);
  t.is(executionStatusCommon.executionArn, executionStatus.execution.executionArn);
});

test('returns granules for execution in Step Function API', async (t) => {
  const response = await request(app)
    .get(`/executions/status/${executionArn}`)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  const executionStatus = response.body;
  t.deepEqual(executionStatus.execution.granules, fakeExecutionStatusGranules);
});

test('returns full message when it is already included in the output', async (t) => {
  const response = await request(app)
    .get('/executions/status/hasFullMessage')
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  const executionStatus = response.body;
  t.deepEqual(fullMessageOutput(), JSON.parse(executionStatus.execution.output));
});

test('fetches messages from S3 when remote message (for both SF execution history and executions)', async (t) => {
  const response = await request(app)
    .get('/executions/status/hasRemoteMessage')
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  const executionStatus = response.body;
  const expectedResponse = {
    execution: {
      ...executionStatusCommon,
      output: JSON.stringify(fullMessageOutput()),
    },
    executionHistory: {
      events: [
        lambdaEventOutput(),
      ],
    },
    stateMachine: {},
  };
  t.deepEqual(expectedResponse, executionStatus);
});

test('when execution is still running, still returns status and fetches SF execution history events from S3', async (t) => {
  const response = await request(app)
    .get('/executions/status/stillRunning')
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  const executionStatus = response.body;
  const expectedResponse = {
    execution: executionStatusCommon,
    executionHistory: {
      events: [
        lambdaEventOutput(),
      ],
    },
    stateMachine: {},
  };
  t.deepEqual(expectedResponse, executionStatus);
});

test('when execution is no longer in step function API, returns status from database', async (t) => {
  const response = await request(app)
    .get(`/executions/status/${expiredExecutionArn}`)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  const executionStatus = response.body;
  t.falsy(executionStatus.executionHistory);
  t.falsy(executionStatus.stateMachine);
  t.is(executionStatus.execution.executionArn, t.context.fakeExecutionRecord.arn);
  t.is(executionStatus.execution.name, t.context.fakeExecutionRecord.name);
  t.is(
    executionStatus.execution.input,
    JSON.stringify(t.context.fakeExecutionRecord.original_payload)
  );
  t.is(
    executionStatus.execution.output,
    JSON.stringify(t.context.fakeExecutionRecord.final_payload)
  );
  t.is(
    executionStatus.execution.startDate,
    t.context.fakeExecutionRecord.created_at.toISOString()
  );
  t.is(
    executionStatus.execution.stopDate,
    new Date(t.context.fakeExecutionRecord.created_at.getTime()
      + t.context.fakeExecutionRecord.duration * 1000).toISOString()
  );
  t.deepEqual(executionStatus.execution.granules, fakeExecutionStatusGranules);
});

test('when execution not found in step function API nor database, returns not found', async (t) => {
  const response = await request(app)
    .get(`/executions/status/${expiredMissingExecutionArn}`)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(404);

  const executionStatus = response.body;
  t.is(executionStatus.error, 'Not Found');
  t.is(executionStatus.message, `Execution record with identifiers ${JSON.stringify({ arn: expiredMissingExecutionArn })} does not exist.`);
});
