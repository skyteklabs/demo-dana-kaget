import { parentPort, workerData } from 'node:worker_threads';
import { createClaimStore } from '../lib/claims.mjs';

const store = await createClaimStore(workerData.directory);
parentPort.once('message', () => {
  try {
    const result = store.claim(workerData.requestId, workerData.verificationCode, workerData.session);
    parentPort.postMessage({ success: true, reward: result.reward.value });
  } catch (error) { parentPort.postMessage({ success: false, error: error.code }); }
  finally { store.close(); parentPort.close(); }
});
parentPort.postMessage({ ready: true });
