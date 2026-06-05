#!/usr/bin/env node

/**
 * Fly.io Distributed Worker - Phase 2
 * Worker léger qui pull des IDs depuis le serveur OVH et POST les résultats
 */

const API_BASE = process.env.API_BASE || 'https://wosforge.org/WPDS/api';
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE) || 100;
const WORKER_ID = process.env.FLY_REGION || 'local';

async function fetchBatch() {
  const res = await fetch(`${API_BASE}/get-batch?count=${BATCH_SIZE}`);
  return res.json();
}

async function scanId(id) {
  try {
    // Utilise l'API du serveur OVH qui gère CF workers + proxies
    const res = await fetch(`${API_BASE}/scan-id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
      signal: AbortSignal.timeout(10000),
    });

    const data = await res.json();

    if (data.found && data.player) {
      return {
        found: true,
        player: {
          id,
          nickname: data.player.nickname,
          kid: data.player.kid || 0,
          stateLevel: data.player.stateLevel || 0,
          avatarFrame: data.player.avatarFrame || 0,
          allianceTag: data.player.allianceTag || '',
        }
      };
    }

    return { found: false, id };
  } catch (err) {
    console.error(`[${WORKER_ID}] Error scanning ${id}:`, err.message);
    return { error: true, id };
  }
}

async function submitResults(found, dead) {
  try {
    const res = await fetch(`${API_BASE}/bulk-insert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ found, dead }),
    });
    return res.json();
  } catch (err) {
    console.error(`[${WORKER_ID}] Error submitting results:`, err.message);
    return null;
  }
}

async function runWorkerCycle() {
  console.log(`[${WORKER_ID}] Fetching batch...`);

  const batch = await fetchBatch();

  if (!batch.ids || batch.ids.length === 0) {
    if (batch.done) {
      console.log(`[${WORKER_ID}] Scan complete!`);
      return false; // Stop
    }
    console.log(`[${WORKER_ID}] No IDs available, waiting...`);
    await new Promise(resolve => setTimeout(resolve, 5000));
    return true; // Continue
  }

  console.log(`[${WORKER_ID}] Scanning ${batch.ids.length} IDs (${batch.start} → ${batch.end})`);

  const found = [];
  const dead = [];
  const errors = [];

  // Parallelize scanning (10 concurrent)
  const chunks = [];
  for (let i = 0; i < batch.ids.length; i += 10) {
    chunks.push(batch.ids.slice(i, i + 10));
  }

  for (const chunk of chunks) {
    const results = await Promise.all(chunk.map(id => scanId(id)));

    for (const result of results) {
      if (result.found) {
        found.push(result.player);
      } else if (result.error) {
        errors.push(result.id);
      } else {
        dead.push(result.id);
      }
    }
  }

  console.log(`[${WORKER_ID}] Results: ${found.length} found, ${dead.length} dead, ${errors.length} errors`);

  // Submit results
  const submitResult = await submitResults(found, dead);
  if (submitResult) {
    console.log(`[${WORKER_ID}] Submitted successfully:`, submitResult.inserted);
  }

  return true; // Continue
}

async function main() {
  console.log(`[${WORKER_ID}] Worker started`);

  while (true) {
    try {
      const shouldContinue = await runWorkerCycle();
      if (!shouldContinue) break;

      // Small delay between batches
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (err) {
      console.error(`[${WORKER_ID}] Cycle error:`, err);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }

  console.log(`[${WORKER_ID}] Worker stopped`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
