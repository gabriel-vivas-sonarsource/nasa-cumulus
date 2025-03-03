'use strict';

const test = require('ava');
const omit = require('lodash/omit');
const sortBy = require('lodash/sortBy');
const request = require('supertest');
const cryptoRandomString = require('crypto-random-string');
const uuidv4 = require('uuid/v4');

const {
  createBucket,
  recursivelyDeleteS3Bucket,
} = require('@cumulus/aws-client/S3');
const { sns, sqs } = require('@cumulus/aws-client/services');
const { randomId, randomString } = require('@cumulus/common/test-utils');
const {
  AsyncOperationPgModel,
  CollectionPgModel,
  destroyLocalTestDb,
  ExecutionPgModel,
  fakeCollectionRecordFactory,
  generateLocalTestDb,
  localStackConnectionEnv,
  translateApiAsyncOperationToPostgresAsyncOperation,
  translateApiExecutionToPostgresExecution,
  translatePostgresExecutionToApiExecution,
  upsertGranuleWithExecutionJoinRecord,
  fakeAsyncOperationRecordFactory,
  fakeExecutionRecordFactory,
  migrationDir,
  GranulePgModel,
  translateApiGranuleToPostgresGranule,
} = require('@cumulus/db');
const indexer = require('@cumulus/es-client/indexer');
const { Search } = require('@cumulus/es-client/search');
const {
  createTestIndex,
  cleanupTestIndex,
} = require('@cumulus/es-client/testUtils');
const { constructCollectionId } = require('@cumulus/message/Collections');
const { AccessToken, AsyncOperation, Collection, Execution, Granule } = require('../../models');
// Dynamo mock data factories
const {
  createFakeJwtAuthToken,
  fakeExecutionFactoryV2,
  setAuthorizedOAuthUsers,
  createExecutionTestRecords,
  cleanupExecutionTestRecords,
  fakeGranuleFactoryV2,
  fakeCollectionFactory,
  fakeAsyncOperationFactory,
} = require('../../lib/testUtils');
const assertions = require('../../lib/assertions');

process.env.AccessTokensTable = randomString();
process.env.CollectionsTable = randomString();
process.env.ExecutionsTable = randomString();
process.env.GranulesTable = randomString();
process.env.stackName = randomString();
process.env.system_bucket = randomString();
process.env.TOKEN_SECRET = randomString();

// import the express app after setting the env variables
const { del } = require('../../endpoints/executions');
const { app } = require('../../app');
const { buildFakeExpressResponse } = require('./utils');

// create all the variables needed across this test
const testDbName = `test_executions_${cryptoRandomString({ length: 10 })}`;
const fakeExecutions = [];
let jwtAuthToken;
let accessTokenModel;
let asyncOperationModel;
let collectionModel;
let executionModel;
let granuleModel;
process.env.AccessTokensTable = randomId('token');
process.env.AsyncOperationsTable = randomId('asyncOperation');
process.env.CollectionsTable = randomId('collection');
process.env.ExecutionsTable = randomId('executions');
process.env.GranulesTable = randomId('granules');
process.env.stackName = randomId('stackname');
process.env.system_bucket = randomId('bucket');
process.env.TOKEN_SECRET = randomId('secret');

test.before(async (t) => {
  process.env = {
    ...process.env,
    ...localStackConnectionEnv,
    PG_DATABASE: testDbName,
    METRICS_ES_HOST: 'fakehost',
    METRICS_ES_USER: randomId('metricsUser'),
    METRICS_ES_PASS: randomId('metricsPass'),
  };

  // create a fake bucket
  await createBucket(process.env.system_bucket);

  // create fake AsyncOperation table
  asyncOperationModel = new AsyncOperation({
    systemBucket: process.env.system_bucket,
    stackName: process.env.stackName,
  });
  await asyncOperationModel.createTable();

  // create fake Granules table
  granuleModel = new Granule();
  await granuleModel.createTable();

  collectionModel = new Collection();
  await collectionModel.createTable();

  // create fake execution table
  executionModel = new Execution();
  await executionModel.createTable();
  t.context.executionModel = executionModel;

  const username = randomString();
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

  t.context.asyncOperationsPgModel = new AsyncOperationPgModel();
  t.context.collectionPgModel = new CollectionPgModel();
  t.context.executionPgModel = new ExecutionPgModel();
  t.context.granulePgModel = new GranulePgModel();

  const { esIndex, esClient } = await createTestIndex();
  t.context.esIndex = esIndex;
  t.context.esClient = esClient;
  t.context.esExecutionsClient = new Search(
    {},
    'execution',
    process.env.ES_INDEX
  );

  // create fake execution records
  const asyncOperationId = uuidv4();
  t.context.asyncOperationId = asyncOperationId;
  await t.context.asyncOperationsPgModel.create(
    t.context.knex,
    {
      id: asyncOperationId,
      description: 'fake async operation',
      status: 'SUCCEEDED',
      operation_type: 'Bulk Granules',
    }
  );
  fakeExecutions.push(
    fakeExecutionFactoryV2({
      status: 'completed',
      asyncOperationId,
      arn: 'arn2',
      type: 'fakeWorkflow',
      parentArn: undefined,
    })
  );
  fakeExecutions.push(
    fakeExecutionFactoryV2({ status: 'failed', type: 'workflow2', parentArn: undefined })
  );
  fakeExecutions.push(
    fakeExecutionFactoryV2({ status: 'running', type: 'fakeWorkflow', parentArn: undefined })
  );

  t.context.fakePGExecutions = await Promise.all(fakeExecutions.map(async (execution) => {
    const omitExecution = omit(execution, ['asyncOperationId', 'parentArn']);
    const executionPgRecord = await translateApiExecutionToPostgresExecution(
      omitExecution,
      t.context.knex
    );
    const [pgExecution] = await t.context.executionPgModel.create(
      t.context.knex,
      executionPgRecord
    );
    const dynamoRecord = await executionModel.create(execution);
    await indexer.indexExecution(esClient, dynamoRecord, process.env.ES_INDEX);
    return pgExecution;
  }));

  // Create AsyncOperation in Dynamo and Postgres
  const testAsyncOperation = fakeAsyncOperationFactory({
    id: uuidv4(),
    output: JSON.stringify({ test: randomId('output') }),
  });
  t.context.testAsyncOperation = await asyncOperationModel.create(
    testAsyncOperation
  );

  const testPgAsyncOperation = translateApiAsyncOperationToPostgresAsyncOperation(
    t.context.testAsyncOperation
  );

  [t.context.asyncOperationCumulusId] = await t.context.asyncOperationsPgModel.create(
    knex,
    testPgAsyncOperation
  );

  // Create collections in Dynamo and Postgres
  // we need this because a granule has a foreign key referring to collections
  const collectionName = 'fakeCollection';
  const collectionVersion = 'v1';

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

  const testPgCollection = fakeCollectionRecordFactory({
    name: collectionName,
    version: collectionVersion,
  });

  const [pgCollection] = await t.context.collectionPgModel.create(
    knex,
    testPgCollection
  );
  t.context.collectionCumulusId = pgCollection.cumulus_id;

  t.context.fakeApiExecutions = await Promise.all(t.context.fakePGExecutions
    .map(async (fakePGExecution) =>
      await translatePostgresExecutionToApiExecution(fakePGExecution, t.context.knex)));
});

test.beforeEach(async (t) => {
  const topicName = cryptoRandomString({ length: 10 });
  const { TopicArn } = await sns().createTopic({ Name: topicName }).promise();
  process.env.execution_sns_topic_arn = TopicArn;
  t.context.TopicArn = TopicArn;

  const QueueName = cryptoRandomString({ length: 10 });
  const { QueueUrl } = await sqs().createQueue({ QueueName }).promise();
  t.context.QueueUrl = QueueUrl;
  const getQueueAttributesResponse = await sqs().getQueueAttributes({
    QueueUrl,
    AttributeNames: ['QueueArn'],
  }).promise();
  const QueueArn = getQueueAttributesResponse.Attributes.QueueArn;

  const { SubscriptionArn } = await sns().subscribe({
    TopicArn,
    Protocol: 'sqs',
    Endpoint: QueueArn,
  }).promise();

  await sns().confirmSubscription({
    TopicArn,
    Token: SubscriptionArn,
  }).promise();

  const {
    esClient,
    esIndex,
    executionPgModel,
    granulePgModel,
    knex,
  } = t.context;
  const granuleId1 = randomId('granuleId1');
  const granuleId2 = randomId('granuleId2');

  // create fake Dynamo granule records
  t.context.fakeGranules = [
    fakeGranuleFactoryV2({ granuleId: granuleId1, status: 'completed', collectionId: t.context.collectionId }),
    fakeGranuleFactoryV2({ granuleId: granuleId2, status: 'failed', collectionId: t.context.collectionId }),
  ];

  // create fake Postgres granule records
  t.context.fakePGGranules = await Promise.all(t.context.fakeGranules.map(async (fakeGranule) => {
    const dynamoRecord = await granuleModel.create(fakeGranule);
    await indexer.indexGranule(esClient, dynamoRecord, esIndex);
    const granulePgRecord = await translateApiGranuleToPostgresGranule(
      dynamoRecord,
      t.context.knex
    );
    return granulePgRecord;
  }));

  await Promise.all(
    t.context.fakePGGranules.map(async (granule) =>
      await granulePgModel.create(knex, granule))
  );

  await upsertGranuleWithExecutionJoinRecord(
    knex, t.context.fakePGGranules[0], await executionPgModel.getRecordCumulusId(knex, {
      workflow_name: 'fakeWorkflow',
      arn: 'arn2',
    })
  );
  await upsertGranuleWithExecutionJoinRecord(
    knex, t.context.fakePGGranules[0], await executionPgModel.getRecordCumulusId(knex, {
      workflow_name: 'workflow2',
    })
  );
  await upsertGranuleWithExecutionJoinRecord(
    knex, t.context.fakePGGranules[1], await executionPgModel.getRecordCumulusId(knex, {
      workflow_name: 'fakeWorkflow',
      status: 'running',
    })
  );
});

test.after.always(async (t) => {
  await accessTokenModel.deleteTable();
  await asyncOperationModel.deleteTable();
  await collectionModel.deleteTable();
  await executionModel.deleteTable();
  await granuleModel.deleteTable();
  await recursivelyDeleteS3Bucket(process.env.system_bucket);
  await destroyLocalTestDb({
    knex: t.context.knex,
    knexAdmin: t.context.knexAdmin,
    testDbName,
  });
  await cleanupTestIndex(t.context);
});

test.serial('CUMULUS-911 GET without pathParameters and without an Authorization header returns an Authorization Missing response', async (t) => {
  const response = await request(app)
    .get('/executions')
    .set('Accept', 'application/json')
    .expect(401);

  assertions.isAuthorizationMissingResponse(t, response);
});

test.serial('CUMULUS-911 GET with pathParameters and without an Authorization header returns an Authorization Missing response', async (t) => {
  const response = await request(app)
    .get('/executions/asdf')
    .set('Accept', 'application/json')
    .expect(401);

  assertions.isAuthorizationMissingResponse(t, response);
});

test.serial('CUMULUS-912 GET without pathParameters and with an unauthorized user returns an unauthorized response', async (t) => {
  const response = await request(app)
    .get('/executions')
    .set('Accept', 'application/json')
    .expect(401);

  assertions.isAuthorizationMissingResponse(t, response);
});

test.serial('CUMULUS-912 GET with pathParameters and with an unauthorized user returns an unauthorized response', async (t) => {
  const response = await request(app)
    .get('/executions/asdf')
    .set('Accept', 'application/json')
    .expect(401);

  assertions.isAuthorizationMissingResponse(t, response);
});

test.serial('GET executions returns list of executions by default', async (t) => {
  const response = await request(app)
    .get('/executions')
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  const { meta, results } = response.body;
  t.is(results.length, 3);
  t.is(meta.stack, process.env.stackName);
  t.is(meta.table, 'execution');
  t.is(meta.count, 3);
  const arns = fakeExecutions.map((i) => i.arn);
  results.forEach((r) => {
    t.true(arns.includes(r.arn));
  });
});

test.serial('executions can be filtered by workflow', async (t) => {
  const response = await request(app)
    .get('/executions')
    .query({ type: 'workflow2' })
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  const { meta, results } = response.body;
  t.is(results.length, 1);
  t.is(meta.stack, process.env.stackName);
  t.is(meta.table, 'execution');
  t.is(meta.count, 1);
  t.is(fakeExecutions[1].arn, results[0].arn);
});

test.serial('GET executions with asyncOperationId filter returns the correct executions', async (t) => {
  const response = await request(app)
    .get(`/executions?asyncOperationId=${t.context.asyncOperationId}`)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  t.is(response.body.meta.count, 1);
  t.is(response.body.results[0].arn, 'arn2');
});

test('GET returns an existing execution', async (t) => {
  const collectionRecord = fakeCollectionRecordFactory();
  const asyncRecord = fakeAsyncOperationRecordFactory();
  const parentExecutionRecord = fakeExecutionRecordFactory();

  const collectionPgModel = new CollectionPgModel();
  const asyncOperationsPgModel = new AsyncOperationPgModel();

  const [pgCollection] = await collectionPgModel.create(
    t.context.knex,
    collectionRecord
  );
  const collectionCumulusId = pgCollection.cumulus_id;

  const [asyncOperationCumulusId] = await asyncOperationsPgModel.create(
    t.context.knex,
    asyncRecord
  );

  const [parentPgExecution] = await t.context.executionPgModel.create(
    t.context.knex,
    parentExecutionRecord
  );
  const parentExecutionCumulusId = parentPgExecution.cumulus_id;

  const executionRecord = await fakeExecutionRecordFactory({
    async_operation_cumulus_id: asyncOperationCumulusId,
    collection_cumulus_id: collectionCumulusId,
    parent_cumulus_id: parentExecutionCumulusId,
  });

  await t.context.executionPgModel.create(
    t.context.knex,
    executionRecord
  );
  t.teardown(async () => {
    await t.context.executionPgModel.delete(t.context.knex, executionRecord);
    await t.context.executionPgModel.delete(t.context.knex, parentExecutionRecord);
    await collectionPgModel.delete(t.context.knex, collectionRecord);
    await asyncOperationsPgModel.delete(t.context.knex, asyncRecord);
  });

  const response = await request(app)
    .get(`/executions/${executionRecord.arn}`)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  const executionResult = response.body;
  const expectedRecord = await translatePostgresExecutionToApiExecution(
    executionRecord,
    t.context.knex
  );

  t.is(executionResult.arn, executionRecord.arn);
  t.is(executionResult.asyncOperationId, asyncRecord.id);
  t.is(executionResult.collectionId, constructCollectionId(
    collectionRecord.name,
    collectionRecord.version
  ));
  t.is(executionResult.parentArn, parentExecutionRecord.arn);
  t.like(executionResult, expectedRecord);
});

test('GET returns an existing execution without any foreign keys', async (t) => {
  const { executionPgModel } = t.context;
  const executionRecord = await fakeExecutionRecordFactory();
  await executionPgModel.create(
    t.context.knex,
    executionRecord
  );
  t.teardown(async () => await executionPgModel.delete(
    t.context.knex,
    { arn: executionRecord.arn }
  ));
  const response = await request(app)
    .get(`/executions/${executionRecord.arn}`)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  const executionResult = response.body;
  const expectedRecord = await translatePostgresExecutionToApiExecution(executionRecord);
  t.deepEqual(executionResult, expectedRecord);
});

test.serial('GET fails if execution is not found', async (t) => {
  const response = await request(app)
    .get('/executions/unknown')
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(404);
  t.is(response.status, 404);
  t.true(response.body.message.includes(`Execution record with identifiers ${JSON.stringify({ arn: 'unknown' })} does not exist`));
});

test.serial('DELETE deletes an execution', async (t) => {
  const { originalDynamoExecution } = await createExecutionTestRecords(
    t.context,
    { parentArn: undefined }
  );
  const { arn } = originalDynamoExecution;

  t.true(
    await t.context.executionModel.exists(
      { arn }
    )
  );
  t.true(
    await t.context.executionPgModel.exists(
      t.context.knex,
      { arn }
    )
  );
  t.true(
    await t.context.esExecutionsClient.exists(
      arn
    )
  );

  const response = await request(app)
    .delete(`/executions/${arn}`)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  const { message } = response.body;

  t.is(message, 'Record deleted');
  t.false(
    await t.context.executionModel.exists(
      { arn }
    )
  );
  const dbRecords = await t.context.executionPgModel
    .search(t.context.knex, { arn });
  t.is(dbRecords.length, 0);
  t.false(
    await t.context.esExecutionsClient.exists(
      arn
    )
  );
});

test.serial('del() does not remove from PostgreSQL/Elasticsearch if removing from Dynamo fails', async (t) => {
  const {
    originalDynamoExecution,
  } = await createExecutionTestRecords(
    t.context,
    { parentArn: undefined }
  );
  const { arn } = originalDynamoExecution;
  t.teardown(async () => await cleanupExecutionTestRecords(t.context, { arn }));

  const fakeExecutionModel = {
    get: () => Promise.resolve(originalDynamoExecution),
    delete: () => {
      throw new Error('something bad');
    },
    create: () => Promise.resolve(true),
  };

  const expressRequest = {
    params: {
      arn,
    },
    testContext: {
      knex: t.context.knex,
      executionModel: fakeExecutionModel,
    },
  };

  const response = buildFakeExpressResponse();

  await t.throwsAsync(
    del(expressRequest, response),
    { message: 'something bad' }
  );

  t.deepEqual(
    await t.context.executionModel.get({
      arn,
    }),
    omit(originalDynamoExecution, 'parentArn')
  );
  t.true(
    await t.context.executionPgModel.exists(t.context.knex, {
      arn,
    })
  );
  t.true(
    await t.context.esExecutionsClient.exists(
      arn
    )
  );
});

test.serial('del() does not remove from Dynamo/Elasticsearch if removing from PostgreSQL fails', async (t) => {
  const {
    originalDynamoExecution,
  } = await createExecutionTestRecords(
    t.context,
    { parentArn: undefined }
  );
  const { arn } = originalDynamoExecution;
  t.teardown(async () => await cleanupExecutionTestRecords(t.context, { arn }));

  const fakeExecutionPgModel = new ExecutionPgModel();
  fakeExecutionPgModel.delete = () => {
    throw new Error('something bad');
  };

  const expressRequest = {
    params: {
      arn,
    },
    testContext: {
      knex: t.context.knex,
      executionPgModel: fakeExecutionPgModel,
    },
  };

  const response = buildFakeExpressResponse();

  await t.throwsAsync(
    del(expressRequest, response),
    { message: 'something bad' }
  );

  t.deepEqual(
    await t.context.executionModel.get({
      arn,
    }),
    omit(originalDynamoExecution, 'parentArn')
  );
  t.true(
    await t.context.executionPgModel.exists(t.context.knex, {
      arn,
    })
  );
  t.true(
    await t.context.esExecutionsClient.exists(
      arn
    )
  );
});

test.serial('del() does not remove from Dynamo/PostgreSQL if removing from Elasticsearch fails', async (t) => {
  const {
    originalDynamoExecution,
  } = await createExecutionTestRecords(
    t.context,
    { parentArn: undefined }
  );
  const { arn } = originalDynamoExecution;
  t.teardown(async () => await cleanupExecutionTestRecords(t.context, { arn }));

  const fakeEsClient = {
    delete: () => {
      throw new Error('something bad');
    },
  };

  const expressRequest = {
    params: {
      arn,
    },
    testContext: {
      knex: t.context.knex,
      esClient: fakeEsClient,
    },
  };

  const response = buildFakeExpressResponse();

  await t.throwsAsync(
    del(expressRequest, response),
    { message: 'something bad' }
  );

  t.deepEqual(
    await t.context.executionModel.get({
      arn,
    }),
    omit(originalDynamoExecution, 'parentArn')
  );
  t.true(
    await t.context.executionPgModel.exists(t.context.knex, {
      arn,
    })
  );
  t.true(
    await t.context.esExecutionsClient.exists(
      arn
    )
  );
});

test.serial('DELETE removes only specified execution from all data stores', async (t) => {
  const { knex, executionPgModel } = t.context;

  const newExecution = fakeExecutionFactoryV2({
    arn: 'arn3',
    status: 'completed',
    name: 'test_execution',
  });

  await executionModel.create(newExecution);
  const executionPgRecord = await translateApiExecutionToPostgresExecution(
    newExecution,
    knex
  );
  await executionPgModel.create(knex, executionPgRecord);

  t.true(await executionModel.exists({ arn: newExecution.arn }));
  t.true(await executionPgModel.exists(knex, { arn: newExecution.arn }));

  await request(app)
    .delete(`/executions/${newExecution.arn}`)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  // Correct Dynamo and PG execution was deleted
  t.false(await executionModel.exists({ arn: newExecution.arn }));

  const dbRecords = await executionPgModel.search(t.context.knex, {
    arn: newExecution.arn,
  });

  t.is(dbRecords.length, 0);

  // Previously created executions still exist
  t.true(await executionModel.exists({ arn: fakeExecutions[0].arn }));
  t.true(await executionModel.exists({ arn: fakeExecutions[1].arn }));

  const originalExecution1 = await executionPgModel.search(t.context.knex, {
    arn: fakeExecutions[0].arn,
  });

  t.is(originalExecution1.length, 1);

  const originalExecution2 = await executionPgModel.search(t.context.knex, {
    arn: fakeExecutions[1].arn,
  });

  t.is(originalExecution2.length, 1);
});

test.serial('DELETE returns a 404 if PostgreSQL and Elasticsearch execution cannot be found', async (t) => {
  const nonExistentExecution = {
    arn: 'arn9',
    status: 'completed',
    name: 'test_execution',
  };

  const response = await request(app)
    .delete(`/executions/${nonExistentExecution.arn}`)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(404);

  t.is(response.body.message, 'No record found');
});

test('DELETE successfully deletes if a PostgreSQL execution exists but not Elasticsearch', async (t) => {
  const { knex, executionPgModel } = t.context;

  const newExecution = fakeExecutionFactoryV2({
    status: 'completed',
    name: 'test_execution',
  });

  const executionPgRecord = await translateApiExecutionToPostgresExecution(
    newExecution,
    knex
  );
  await executionPgModel.create(knex, executionPgRecord);

  t.true(await executionPgModel.exists(knex, { arn: newExecution.arn }));
  t.false(
    await t.context.esExecutionsClient.exists(
      newExecution.arn
    )
  );
  await request(app)
    .delete(`/executions/${newExecution.arn}`)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  const dbRecords = await executionPgModel.search(t.context.knex, {
    arn: newExecution.arn,
  });

  t.is(dbRecords.length, 0);
  t.false(await executionPgModel.exists(knex, { arn: newExecution.arn }));
});

test('DELETE successfully deletes if an Elasticsearch execution exists but not PostgreSQL', async (t) => {
  const { knex, esClient, executionPgModel } = t.context;

  const newExecution = fakeExecutionFactoryV2({
    status: 'completed',
    name: 'test_execution',
  });

  await indexer.indexExecution(esClient, newExecution, process.env.ES_INDEX);

  t.false(await executionPgModel.exists(knex, { arn: newExecution.arn }));
  t.true(
    await t.context.esExecutionsClient.exists(
      newExecution.arn
    )
  );
  await request(app)
    .delete(`/executions/${newExecution.arn}`)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  const dbRecords = await executionPgModel.search(t.context.knex, {
    arn: newExecution.arn,
  });

  t.is(dbRecords.length, 0);
  t.false(
    await t.context.esExecutionsClient.exists(
      newExecution.arn
    )
  );
});

test.serial('POST /executions/search-by-granules returns 1 record by default', async (t) => {
  const { fakeGranules, fakePGExecutions } = t.context;

  const response = await request(app)
    .post('/executions/search-by-granules')
    .send({ granules: [
      { granuleId: fakeGranules[0].granuleId, collectionId: t.context.collectionId },
      { granuleId: fakeGranules[1].granuleId, collectionId: t.context.collectionId },
    ] })
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`);

  t.is(response.body.results.length, 1);

  response.body.results.forEach(async (execution) => t.deepEqual(
    execution,
    await translatePostgresExecutionToApiExecution(fakePGExecutions
      .find((fakePGExecution) => fakePGExecution.arn === execution.arn))
  ));
});

test.serial('POST /executions/search-by-granules supports paging', async (t) => {
  const { fakeGranules, fakeApiExecutions } = t.context;

  const page1 = await request(app)
    .post('/executions/search-by-granules?limit=2&page=1')
    .send({ granules: [
      { granuleId: fakeGranules[0].granuleId, collectionId: t.context.collectionId },
      { granuleId: fakeGranules[1].granuleId, collectionId: t.context.collectionId },
    ] })
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`);

  const page2 = await request(app)
    .post('/executions/search-by-granules?limit=2&page=2')
    .send({ granules: [
      { granuleId: fakeGranules[0].granuleId, collectionId: t.context.collectionId },
      { granuleId: fakeGranules[1].granuleId, collectionId: t.context.collectionId },
    ] })
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`);

  t.is(page1.body.results.length, 2);
  t.is(page2.body.results.length, 1);

  const response = page1.body.results.concat(page2.body.results);

  response.forEach((execution) => t.deepEqual(
    execution,
    fakeApiExecutions.find((fakeAPIExecution) => fakeAPIExecution.arn === execution.arn)
  ));
});

test.serial('POST /executions/search-by-granules supports sorting', async (t) => {
  const { fakeGranules, fakeApiExecutions } = t.context;

  const response = await request(app)
    .post('/executions/search-by-granules?sort_by=arn&order=asc&limit=10')
    .send({ granules: [
      { granuleId: fakeGranules[0].granuleId, collectionId: t.context.collectionId },
      { granuleId: fakeGranules[1].granuleId, collectionId: t.context.collectionId },
    ] })
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`);

  const sortedApiExecutions = sortBy(fakeApiExecutions, ['arn']);

  t.deepEqual(response.body.results, sortedApiExecutions);
});

test.serial('POST /executions/search-by-granules returns correct executions when granules array is passed', async (t) => {
  const { fakeGranules, fakePGExecutions } = t.context;

  const response = await request(app)
    .post('/executions/search-by-granules?limit=10')
    .send({ granules: [
      { granuleId: fakeGranules[0].granuleId, collectionId: t.context.collectionId },
      { granuleId: fakeGranules[1].granuleId, collectionId: t.context.collectionId },
    ] })
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`);

  t.is(response.body.results.length, 3);

  response.body.results.forEach(async (execution) => t.deepEqual(
    execution,
    await translatePostgresExecutionToApiExecution(
      fakePGExecutions.find((fakePGExecution) => fakePGExecution.arn === execution.arn),
      t.context.knex
    )
  ));
});

test.serial('POST /executions/search-by-granules returns correct executions when query is passed', async (t) => {
  const { fakeGranules, fakePGExecutions, esIndex } = t.context;

  const expectedQuery = {
    size: 2,
    query: {
      bool: {
        filter: [
          {
            bool: {
              should: [{ match: { granuleId: fakeGranules[0].granuleId } }],
              minimum_should_match: 1,
            },
          },
          {
            bool: {
              should: [{ match: { collectionId: fakeGranules[0].collectionId } }],
              minimum_should_match: 1,
            },
          },
        ],
      },
    },
  };

  const body = {
    index: esIndex,
    query: expectedQuery,
  };

  const response = await request(app)
    .post('/executions/search-by-granules?limit=10')
    .send(body)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`);

  t.is(response.body.results.length, 2);

  response.body.results.forEach(async (execution) => t.deepEqual(
    execution,
    await translatePostgresExecutionToApiExecution(
      fakePGExecutions.find((fakePGExecution) => fakePGExecution.arn === execution.arn),
      t.context.knex
    )
  ));
});

test.serial('POST /executions/search-by-granules returns 400 when a query is provided with no index', async (t) => {
  const expectedQuery = { query: 'fake-query' };

  const body = {
    query: expectedQuery,
  };

  const response = await request(app)
    .post('/executions/search-by-granules')
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .send(body)
    .expect(400);

  t.regex(response.body.message, /Index is required if query is sent/);
});

test.serial('POST /executions/search-by-granules returns 400 when no granules or query is provided', async (t) => {
  const expectedIndex = 'my-index';

  const body = {
    index: expectedIndex,
  };

  const response = await request(app)
    .post('/executions/search-by-granules')
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .send(body)
    .expect(400, /One of granules or query is required/);

  t.regex(response.body.message, /One of granules or query is required/);
});

test.serial('POST /executions/search-by-granules returns 400 when granules is not an array', async (t) => {
  const expectedIndex = 'my-index';

  const body = {
    index: expectedIndex,
    granules: 'bad-value',
  };

  const response = await request(app)
    .post('/executions/search-by-granules')
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .send(body)
    .expect(400);

  t.regex(response.body.message, /granules should be an array of values/);
});

test.serial('POST /executions/search-by-granules returns 400 when granules is an empty array', async (t) => {
  const expectedIndex = 'my-index';

  const body = {
    index: expectedIndex,
    granules: [],
  };

  const response = await request(app)
    .post('/executions/search-by-granules')
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .send(body)
    .expect(400);

  t.regex(response.body.message, /no values provided for granules/);
});

test.serial('POST /executions/search-by-granules returns 400 when granules do not have collectionId', async (t) => {
  const expectedIndex = 'my-index';
  const granule = { granuleId: randomId('granuleId') };

  const body = {
    index: expectedIndex,
    granules: [granule],
  };

  const response = await request(app)
    .post('/executions/search-by-granules')
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .send(body)
    .expect(400);

  t.regex(response.body.message, new RegExp(`no collectionId provided for ${JSON.stringify(granule)}`));
});

test.serial('POST /executions/search-by-granules returns 400 when granules do not have granuleId', async (t) => {
  const expectedIndex = 'my-index';
  const granule = { collectionId: randomId('granuleId') };

  const body = {
    index: expectedIndex,
    granules: [granule],
  };

  const response = await request(app)
    .post('/executions/search-by-granules')
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .send(body)
    .expect(400);

  t.regex(response.body.message, new RegExp(`no granuleId provided for ${JSON.stringify(granule)}`));
});

test.serial('POST /executions/search-by-granules returns 400 when the Metrics ELK stack is not configured', async (t) => {
  const expectedIndex = 'my-index';
  const expectedQuery = { query: 'fake-query' };

  const body = {
    index: expectedIndex,
    query: expectedQuery,
  };

  const metricsUser = process.env.METRICS_ES_USER;
  delete process.env.METRICS_ES_USER;
  t.teardown(() => {
    process.env.METRICS_ES_USER = metricsUser;
  });

  const response = await request(app)
    .post('/executions/search-by-granules')
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .send(body)
    .expect(400);

  t.regex(response.body.message, /ELK Metrics stack not configured/);
});

test.serial('POST /executions/workflows-by-granules returns correct executions when granules array is passed', async (t) => {
  const { collectionId, fakeGranules, fakePGExecutions } = t.context;

  const response = await request(app)
    .post('/executions/workflows-by-granules')
    .send({ granules: [
      { granuleId: fakeGranules[0].granuleId, collectionId },
      { granuleId: fakeGranules[1].granuleId, collectionId },
    ] })
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`);

  t.is(response.body.length, 1);

  response.body.forEach((workflow) => t.deepEqual(
    workflow,
    fakePGExecutions
      .map((fakePGExecution) => fakePGExecution.workflow_name)
      .find((workflowName) => workflowName === workflow)
  ));
});

test.serial('POST /executions/workflows-by-granules returns executions by descending timestamp when a single granule is passed', async (t) => {
  const {
    knex,
    collectionId,
    executionPgModel,
    fakeGranules,
    fakePGGranules,
  } = t.context;

  const [mostRecentExecution]
    = await executionPgModel.create(knex, fakeExecutionRecordFactory({ workflow_name: 'newWorkflow' }));
  const mostRecentExecutionCumulusId = mostRecentExecution.cumulus_id;

  await upsertGranuleWithExecutionJoinRecord(
    knex, fakePGGranules[0], mostRecentExecutionCumulusId
  );

  const response = await request(app)
    .post('/executions/workflows-by-granules')
    .send({ granules: [
      { granuleId: fakeGranules[0].granuleId, collectionId },
    ] })
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`);

  t.is(response.body.length, 3);
  // newWorkflow should be the first result since it is most recent
  t.is(response.body[0], 'newWorkflow');
});

test.serial('POST /executions/workflows-by-granules returns correct workflows when query is passed', async (t) => {
  const { esIndex, fakeGranules } = t.context;

  const expectedQuery = {
    size: 2,
    query: {
      bool: {
        filter: [
          {
            bool: {
              should: [{ match: { granuleId: fakeGranules[0].granuleId } }],
              minimum_should_match: 1,
            },
          },
          {
            bool: {
              should: [{ match: { collectionId: fakeGranules[0].collectionId } }],
              minimum_should_match: 1,
            },
          },
        ],
      },
    },
  };

  const body = {
    index: esIndex,
    query: expectedQuery,
  };

  const response = await request(app)
    .post('/executions/workflows-by-granules')
    .send(body)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`);

  t.is(response.body.length, 2);

  t.deepEqual(response.body.sort(), ['fakeWorkflow', 'workflow2']);
});

test.serial('POST /executions creates a new execution in DynamoDB/PostgreSQL/Elasticsearch with correct timestamps', async (t) => {
  const newExecution = fakeExecutionFactoryV2();

  await request(app)
    .post('/executions')
    .send(newExecution)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  const fetchedDynamoRecord = await executionModel.get({
    arn: newExecution.arn,
  });

  const fetchedPgRecord = await t.context.executionPgModel.get(
    t.context.knex,
    {
      arn: newExecution.arn,
    }
  );

  const fetchedEsRecord = await t.context.esExecutionsClient.get(newExecution.arn);

  t.true(fetchedDynamoRecord.createdAt > newExecution.createdAt);
  t.true(fetchedDynamoRecord.updatedAt > newExecution.updatedAt);

  t.is(fetchedPgRecord.created_at.getTime(), fetchedDynamoRecord.createdAt);
  t.is(fetchedPgRecord.updated_at.getTime(), fetchedDynamoRecord.updatedAt);
  t.is(fetchedPgRecord.created_at.getTime(), fetchedEsRecord.createdAt);
  t.is(fetchedPgRecord.updated_at.getTime(), fetchedEsRecord.updatedAt);
});

test.serial('POST /executions creates the expected record in DynamoDB/PostgreSQL/Elasticsearch', async (t) => {
  const newExecution = fakeExecutionFactoryV2({
    asyncOperationId: t.context.testAsyncOperation.id,
    collectionId: t.context.collectionId,
    parentArn: t.context.fakeApiExecutions[1].arn,
  });

  const expectedPgRecord = await translateApiExecutionToPostgresExecution(
    newExecution,
    t.context.knex
  );

  await request(app)
    .post('/executions')
    .send(newExecution)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  const fetchedDynamoRecord = await executionModel.get({
    arn: newExecution.arn,
  });

  const fetchedPgRecord = await t.context.executionPgModel.get(
    t.context.knex,
    {
      arn: newExecution.arn,
    }
  );

  const fetchedEsRecord = await t.context.esExecutionsClient.get(newExecution.arn);

  t.is(fetchedPgRecord.arn, fetchedDynamoRecord.arn);
  t.truthy(fetchedPgRecord.cumulus_id);
  t.is(fetchedPgRecord.async_operation_cumulus_id, t.context.asyncOperationCumulusId);
  t.is(fetchedPgRecord.collection_cumulus_id, t.context.collectionCumulusId);
  t.is(fetchedPgRecord.parent_cumulus_id, t.context.fakePGExecutions[1].cumulus_id);

  t.deepEqual(
    fetchedDynamoRecord,
    {
      ...newExecution,
      createdAt: fetchedDynamoRecord.createdAt,
      updatedAt: fetchedDynamoRecord.updatedAt,
    }
  );
  t.deepEqual(
    fetchedEsRecord,
    {
      ...newExecution,
      _id: fetchedEsRecord._id,
      createdAt: fetchedEsRecord.createdAt,
      updatedAt: fetchedEsRecord.updatedAt,
      timestamp: fetchedEsRecord.timestamp,
    }
  );
  t.deepEqual(
    fetchedPgRecord,
    {
      ...expectedPgRecord,
      cumulus_id: fetchedPgRecord.cumulus_id,
      created_at: fetchedPgRecord.created_at,
      updated_at: fetchedPgRecord.updated_at,
    }
  );
});

test.serial('POST /executions throws error when "arn" is not provided', async (t) => {
  const newExecution = fakeExecutionFactoryV2();
  delete newExecution.arn;

  const response = await request(app)
    .post('/executions')
    .send(newExecution)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(400);

  const expectedErrorMessage = 'Field arn is missing';
  t.truthy(response.body.message.match(expectedErrorMessage));
});

test.serial('POST /executions throws error when the provided execution already exists', async (t) => {
  const existingArn = t.context.fakeApiExecutions[1].arn;
  const newExecution = fakeExecutionFactoryV2({
    arn: existingArn,
  });

  const response = await request(app)
    .post('/executions')
    .send(newExecution)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(409);

  const expectedErrorMessage = `A record already exists for ${newExecution.arn}`;
  t.truthy(response.body.message.match(expectedErrorMessage));
});

test.serial('POST /executions with non-existing asyncOperation throws error', async (t) => {
  const newExecution = fakeExecutionFactoryV2({
    asyncOperationId: uuidv4(),
    collectionId: t.context.collectionId,
    parentArn: t.context.fakeApiExecutions[1].arn,
  });

  const response = await request(app)
    .post('/executions')
    .send(newExecution)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(400);

  const expectedErrorMessage = `Record in async_operations .*${newExecution.asyncOperationId}.* does not exist`;
  t.truthy(response.body.message.match(expectedErrorMessage));
});

test.serial('POST /executions with non-existing collectionId throws error', async (t) => {
  const newExecution = fakeExecutionFactoryV2({
    asyncOperationId: t.context.testAsyncOperation.id,
    collectionId: constructCollectionId(randomId('name'), randomId('version')),
    parentArn: t.context.fakeApiExecutions[1].arn,
  });

  const response = await request(app)
    .post('/executions')
    .send(newExecution)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(400);

  const expectedErrorMessage = 'Record in collections with identifiers .* does not exist';
  t.truthy(response.body.message.match(expectedErrorMessage));
});

test.serial('POST /executions with non-existing parentArn still creates a new execution', async (t) => {
  const newExecution = fakeExecutionFactoryV2({
    asyncOperationId: t.context.testAsyncOperation.id,
    collectionId: t.context.collectionId,
    parentArn: randomId('parentArn'),
  });

  await request(app)
    .post('/executions')
    .send(newExecution)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  const fetchedDynamoRecord = await executionModel.get({
    arn: newExecution.arn,
  });

  const fetchedPgRecord = await t.context.executionPgModel.get(
    t.context.knex,
    {
      arn: newExecution.arn,
    }
  );

  t.is(fetchedPgRecord.arn, fetchedDynamoRecord.arn);
  t.falsy(fetchedPgRecord.parent_cumulus_id);
});

test.serial('POST /executions creates an execution that is searchable', async (t) => {
  const newExecution = fakeExecutionFactoryV2();

  await request(app)
    .post('/executions')
    .send(newExecution)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  const response = await request(app)
    .get('/executions')
    .query({ arn: newExecution.arn })
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  const { meta, results } = response.body;
  t.is(results.length, 1);
  t.is(meta.stack, process.env.stackName);
  t.is(meta.table, 'execution');
  t.is(meta.count, 1);
  t.is(results[0].arn, newExecution.arn);
});

test.serial('POST /executions publishes message to SNS topic', async (t) => {
  const {
    executionPgModel,
    knex,
    QueueUrl,
  } = t.context;

  const newExecution = fakeExecutionFactoryV2({
    asyncOperationId: t.context.testAsyncOperation.id,
    collectionId: t.context.collectionId,
    parentArn: t.context.fakeApiExecutions[1].arn,
  });

  await request(app)
    .post('/executions')
    .send(newExecution)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  const { Messages } = await sqs().receiveMessage({ QueueUrl, WaitTimeSeconds: 10 }).promise();

  t.is(Messages.length, 1);

  const snsMessage = JSON.parse(Messages[0].Body);
  const executionRecord = JSON.parse(snsMessage.Message);
  const pgRecord = await executionPgModel.get(knex, { arn: newExecution.arn });
  const translatedExecution = await translatePostgresExecutionToApiExecution(
    pgRecord,
    knex
  );

  t.deepEqual(executionRecord, translatedExecution);
});

test.serial('PUT /executions updates the record as expected in DynamoDB/PostgreSQL/Elasticsearch', async (t) => {
  const execution = fakeExecutionFactoryV2({
    collectionId: t.context.collectionId,
    parentArn: t.context.fakeApiExecutions[1].arn,
    status: 'running',
  });
  delete execution.finalPayload;

  const updatedExecution = fakeExecutionFactoryV2({
    ...omit(execution, ['collectionId']),
    asyncOperationId: t.context.testAsyncOperation.id,
    finalPayload: { outputPayload: randomId('outputPayload') },
    parentArn: t.context.fakeApiExecutions[2].arn,
    status: 'completed',
  });

  await request(app)
    .post('/executions')
    .send(execution)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  const dynamoRecord = await executionModel.get({
    arn: execution.arn,
  });

  const pgRecord = await t.context.executionPgModel.get(
    t.context.knex,
    {
      arn: execution.arn,
    }
  );

  await request(app)
    .put(`/executions/${updatedExecution.arn}`)
    .send(updatedExecution)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  const updatedDynamoRecord = await executionModel.get({
    arn: execution.arn,
  });

  const updatePgRecord = await t.context.executionPgModel.get(
    t.context.knex,
    {
      arn: execution.arn,
    }
  );
  const updatedEsRecord = await t.context.esExecutionsClient.get(execution.arn);
  const expectedApiRecord = {
    ...updatedExecution,
    collectionId: execution.collectionId,
    createdAt: dynamoRecord.createdAt,
    updatedAt: updatedDynamoRecord.updatedAt,
  };

  t.deepEqual(
    updatedDynamoRecord,
    expectedApiRecord
  );
  t.like(
    updatedEsRecord,
    {
      ...expectedApiRecord,
      timestamp: updatedEsRecord.timestamp,
    }
  );

  t.is(updatePgRecord.arn, execution.arn);
  t.is(updatePgRecord.cumulus_id, pgRecord.cumulus_id);

  t.is(updatedDynamoRecord.createdAt, dynamoRecord.createdAt);
  t.true(updatedDynamoRecord.updatedAt > dynamoRecord.createdAt);
  t.is(updatePgRecord.created_at.getTime(), pgRecord.created_at.getTime());
  t.true(updatePgRecord.updated_at.getTime() > pgRecord.updated_at.getTime());

  // collectionId was omitted from body of PUT request, so values are
  // not overridden in the database
  t.is(updatedDynamoRecord.collectionId, execution.collectionId);
  t.is(updatePgRecord.collection_cumulus_id, t.context.collectionCumulusId);
  // updated record has added field
  t.is(updatedDynamoRecord.asyncOperationId, updatedExecution.asyncOperationId);
  t.is(updatePgRecord.async_operation_cumulus_id, t.context.asyncOperationCumulusId);
  // updated record has updated field
  t.is(updatedDynamoRecord.parentArn, updatedExecution.parentArn);
  t.is(updatePgRecord.parent_cumulus_id, t.context.fakePGExecutions[2].cumulus_id);
  t.is(updatedDynamoRecord.status, updatedExecution.status);
  t.is(updatePgRecord.status, updatedExecution.status);
  t.deepEqual(updatedDynamoRecord.finalPayload, updatedExecution.finalPayload);
  t.deepEqual(updatePgRecord.final_payload, updatedExecution.finalPayload);
});

test.serial('PUT /executions throws error for arn mismatch between params and payload', async (t) => {
  const updatedExecution = fakeExecutionFactoryV2();
  const arn = randomId('arn');
  const response = await request(app)
    .put(`/executions/${arn}`)
    .send(updatedExecution)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(400);

  const expectedErrorMessage = `Expected execution arn to be '${arn}`;
  t.truthy(response.body.message.match(expectedErrorMessage));
});

test.serial('PUT /executions throws error when the provided execution does not exist', async (t) => {
  const updatedExecution = fakeExecutionFactoryV2();

  const response = await request(app)
    .put(`/executions/${updatedExecution.arn}`)
    .send(updatedExecution)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(404);

  const expectedErrorMessage = `Execution '${updatedExecution.arn}' not found`;
  t.truthy(response.body.message.match(expectedErrorMessage));
});

test.serial('PUT /executions with non-existing asyncOperation throws error', async (t) => {
  const execution = fakeExecutionFactoryV2();

  const updatedExecution = fakeExecutionFactoryV2({
    ...execution,
    asyncOperationId: uuidv4(),
  });

  await request(app)
    .post('/executions')
    .send(execution)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  const response = await request(app)
    .put(`/executions/${updatedExecution.arn}`)
    .send(updatedExecution)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(400);

  const expectedErrorMessage = `Record in async_operations .*${updatedExecution.asyncOperationId}.* does not exist`;
  t.truthy(response.body.message.match(expectedErrorMessage));
});

test.serial('PUT /executions with non-existing collectionId throws error', async (t) => {
  const execution = fakeExecutionFactoryV2();

  const updatedExecution = fakeExecutionFactoryV2({
    ...execution,
    collectionId: constructCollectionId(randomId('name'), randomId('version')),
  });

  await request(app)
    .post('/executions')
    .send(execution)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  const response = await request(app)
    .put(`/executions/${updatedExecution.arn}`)
    .send(updatedExecution)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(400);

  const expectedErrorMessage = 'Record in collections with identifiers .* does not exist';
  t.truthy(response.body.message.match(expectedErrorMessage));
});

test.serial('PUT /executions with non-existing parentArn still updates the execution', async (t) => {
  const execution = fakeExecutionFactoryV2();
  const updatedExecution = fakeExecutionFactoryV2({
    ...execution,
    parentArn: randomId('parentArn'),
  });

  await request(app)
    .post('/executions')
    .send(execution)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  await request(app)
    .put(`/executions/${updatedExecution.arn}`)
    .send(updatedExecution)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  const fetchedDynamoRecord = await executionModel.get({
    arn: updatedExecution.arn,
  });

  const fetchedPgRecord = await t.context.executionPgModel.get(
    t.context.knex,
    {
      arn: updatedExecution.arn,
    }
  );

  t.is(fetchedPgRecord.arn, fetchedDynamoRecord.arn);
  t.falsy(fetchedPgRecord.parent_cumulus_id);
});

test.serial('PUT /executions publishes message to SNS topic', async (t) => {
  const {
    executionPgModel,
    knex,
    QueueUrl,
  } = t.context;

  const newExecution = fakeExecutionFactoryV2({
    asyncOperationId: t.context.testAsyncOperation.id,
    collectionId: t.context.collectionId,
    parentArn: t.context.fakeApiExecutions[1].arn,
    status: 'completed',
  });

  await request(app)
    .post('/executions')
    .send(newExecution)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  const updatedExecution = {
    ...newExecution,
    status: 'completed',
  };

  await request(app)
    .put(`/executions/${newExecution.arn}`)
    .send(updatedExecution)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  const { Messages } = await sqs().receiveMessage({ QueueUrl, WaitTimeSeconds: 10 }).promise();

  t.is(Messages.length, 1);

  const snsMessage = JSON.parse(Messages[0].Body);
  const executionRecord = JSON.parse(snsMessage.Message);
  const pgRecord = await executionPgModel.get(knex, { arn: newExecution.arn });

  t.is(pgRecord.status, 'completed');
  const translatedExecution = await translatePostgresExecutionToApiExecution(
    pgRecord,
    knex
  );
  t.deepEqual(executionRecord, {
    ...translatedExecution,
    updatedAt: executionRecord.updatedAt,
  });
});
