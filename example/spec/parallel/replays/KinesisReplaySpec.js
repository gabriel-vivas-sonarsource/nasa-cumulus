'use strict';

const delay = require('delay');
const replace = require('lodash/replace');
const get = require('lodash/get');

const { randomString } = require('@cumulus/common/test-utils');
const { Rule } = require('@cumulus/api/models');

const { postKinesisReplays } = require('@cumulus/api-client/replays');
const { deleteExecution } = require('@cumulus/api-client/executions');

const {
  addCollections,
  addProviders,
  addRulesWithPostfix,
  cleanupCollections,
  cleanupProviders,
  deleteRules,
  readJsonFilesFromDir,
  setProcessEnvironment,
} = require('@cumulus/integration-tests');
const { findExecutionArn } = require('@cumulus/integration-tests/Executions');

const {
  createOrUseTestStream,
  deleteTestStream,
  getStreamStatus,
  putRecordOnStream,
  tryCatchExit,
  waitForActiveStream,
} = require('../../helpers/kinesisHelpers');

const {
  loadConfig,
  deleteFolder,
  createTimestampedTestId,
  createTestDataPath,
  createTestSuffix,
} = require('../../helpers/testUtils');

// When kinesis-type rules exist, the Cumulus lambda messageConsumer is
// configured to trigger workflows when new records arrive on a Kinesis
// stream. When records arrive on the stream during an outage, the replays
// endpoint can be used to create an AsyncOperation which processes the
// records from a specified time period and triggers workflows associated
// with the kinesis-type rules.
describe('The Kinesis Replay API', () => {
  const maxWaitForSFExistSecs = 60 * 3;

  const ruleDir = './spec/parallel/kinesisTests/data/kinesisReplayRules';
  const providersDir = './data/providers/PODAAC_SWOT/';
  const collectionsDir = './data/collections/s3_MOD09GQ_006/';

  let testConfig;
  let testDataFolder;
  let testSuffix;
  let ruleSuffix;
  let rules;

  let streamName;

  let tooOldToFetchRecords;
  let targetedRecords;
  let newRecordsToSkip;

  async function cleanUp() {
    setProcessEnvironment(testConfig.stackName, testConfig.bucket);
    // delete rules
    const rulesToDelete = await readJsonFilesFromDir(ruleDir);
    // clean up stack state added by test
    console.log(`\nCleaning up stack & deleting test stream '${streamName}'`);
    try {
      await deleteRules(testConfig.stackName, testConfig.bucket, rulesToDelete, ruleSuffix);
      await Promise.all([
        deleteFolder(testConfig.bucket, testDataFolder),
        cleanupCollections(testConfig.stackName, testConfig.bucket, collectionsDir, testSuffix),
        cleanupProviders(testConfig.stackName, testConfig.bucket, providersDir, testSuffix),
        deleteTestStream(streamName),
      ]);
    } catch (error) {
      console.log(`Cleanup failed, ${error}.   Stack may need to be manually cleaned up.`);
    }
  }

  beforeAll(async () => {
    testConfig = await loadConfig();
    const testId = createTimestampedTestId(testConfig.stackName, 'KinesisReplayTest');
    testSuffix = createTestSuffix(testId);
    testDataFolder = createTestDataPath(testId);
    ruleSuffix = replace(testSuffix, /-/g, '_');

    streamName = `${testId}-ReplayTestStream`;
    testConfig.streamName = streamName;

    const createRecord = (identifier) => ({
      provider: `PODAAC_SWOT${testSuffix}`,
      collection: `MOD09GQ${testSuffix}`,
      bucket: 'random-bucket',
      identifier: identifier || randomString(),
    });

    tooOldToFetchRecords = [createRecord(`too-old-${testId}`)];
    targetedRecords = [createRecord(), createRecord()];
    newRecordsToSkip = [createRecord(`too-new-${testId}`)];

    await Promise.all([
      addCollections(testConfig.stackName, testConfig.bucket, collectionsDir, testSuffix),
      addProviders(testConfig.stackName, testConfig.bucket, providersDir, testConfig.bucket, testSuffix),
    ]);

    await tryCatchExit(cleanUp, async () => {
      await createOrUseTestStream(streamName);
      console.log(`\nWaiting for active stream: '${streamName}'.`);
      await waitForActiveStream(streamName);
      rules = await addRulesWithPostfix(testConfig, ruleDir, {}, testSuffix);
    });
  });

  afterAll(async () => {
    await cleanUp();
  });

  it('Prepares a kinesis stream for integration tests.', async () => {
    expect(await getStreamStatus(streamName)).toBe('ACTIVE');
  });

  describe('when a valid kinesis replay request is made', () => {
    let startTimestamp;
    let endTimestamp;
    let asyncOperationId;

    beforeAll(async () => {
      // delete EventSourceMapping so that our rule, though enabled, does not trigger duplicate executions
      const rule = new Rule();
      await rule.deleteKinesisEventSources(rules[0]);

      await Promise.all(tooOldToFetchRecords.map((r) => putRecordOnStream(streamName, r)));
      await delay(10 * 1000);
      startTimestamp = Date.now();
      await delay(5 * 1000);
      await Promise.all(targetedRecords.map((r) => putRecordOnStream(streamName, r)));
      await delay(5 * 1000);
      endTimestamp = Date.now();
      await delay(10 * 1000);
      await Promise.all(newRecordsToSkip.map((r) => putRecordOnStream(streamName, r)));

      const apiRequestBody = {
        type: 'kinesis',
        kinesisStream: streamName,
        endTimestamp,
        startTimestamp,
      };
      const response = await postKinesisReplays({
        prefix: testConfig.stackName,
        payload: apiRequestBody,
      });
      console.log(`received response ${JSON.stringify(response)}`);
      asyncOperationId = JSON.parse(response.body).asyncOperationId;
    });

    it('starts an AsyncOperation and returns the AsyncOperationId', () => {
      console.log('asyncOperationId', asyncOperationId);
      expect(asyncOperationId).toBeDefined();
    });

    describe('processes messages within the specified time slice', () => {
      let workflowExecutionArns;

      it('to start the expected workflows', async () => {
        console.log('Waiting for step functions to start...');

        const expectedWorkflows = targetedRecords.map(
          (record) => {
            console.log('originalPayload.identifier', record.identifier);
            return findExecutionArn(
              testConfig.stackName,
              (execution) =>
                get(execution, 'originalPayload.identifier') === record.identifier,
              {
                timestamp__from: startTimestamp,
                'originalPayload.identifier': record.identifier,
              },
              { timeout: maxWaitForSFExistSecs }
            )
              .catch((error) => fail(error.message));
          }
        );

        workflowExecutionArns = await Promise.all(expectedWorkflows);
        // if intermittent failures occur here, consider increasing maxWaitForSFExistSecs
        expect(workflowExecutionArns.length).toEqual(2);
        workflowExecutionArns.forEach((exec) => expect(exec).toBeDefined());
      });

      it('to not start workflows for records that are too old or too new', async () => {
        console.log('Waiting to ensure workflows expected not to start do not start...');
        const notExpectedWorkflows = [...tooOldToFetchRecords, ...newRecordsToSkip]
          .map((record) => {
            console.log('originalPayload.identifier', record.identifier);
            return findExecutionArn(
              testConfig.stackName,
              (execution) =>
                get(execution, 'originalPayload.identifier') === record.identifier,
              {
                timestamp__from: startTimestamp,
                'originalPayload.identifier': record.identifier,
              },
              { timeout: maxWaitForSFExistSecs }
            )
              .then((execution) => fail(`should not find executions but found ${JSON.stringify(execution)}`))
              .catch((error) => expect(error.message).toBe('Execution never found in API'));
          });
        await Promise.all(notExpectedWorkflows);
      });

      afterAll(async () => {
        console.log('Cleaning up executions...');
        await Promise.all([
          deleteExecution({ prefix: testConfig.stackName, executionArn: workflowExecutionArns[0] }),
          deleteExecution({ prefix: testConfig.stackName, executionArn: workflowExecutionArns[1] }),
        ]);
      });
    });
  });
});
