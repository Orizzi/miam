/**
 * Deno Deploy Worker - WOS Scraper
 * Compatible Deno Deploy free tier (100k req/jour)
 */

const API_BASE = Deno.env.get('API_BASE') || 'https://wosforge.org/WPDS/api';
const BATCH_SIZE = parseInt(Deno.env.get('BATCH_SIZE') || '100');
const WORKER_ID = Deno.env.get('DENO_DEPLOYMENT_ID') || 'deno-local';

interface ScanResult {
  found: boolean;
  player?: any;
  id?: number;
  error?: boolean;
}

async function fetchBatch(): Promise<any> {
  const res = await fetch(`${API_BASE}/get-batch?count=${BATCH_SIZE}`);
  return await res.json();
}

async function scanId(id: number): Promise<ScanResult> {
  try {
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

async function submitResults(found: any[], dead: number[]): Promise<any> {
  try {
    const res = await fetch(`${API_BASE}/bulk-insert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ found, dead }),
    });
    return await res.json();
  } catch (err) {
    console.error(`[${WORKER_ID}] Error submitting:`, err.message);
    return null;
  }
}

async function runWorkerCycle(): Promise<boolean> {
  console.log(`[${WORKER_ID}] Fetching batch...`);

  const batch = await fetchBatch();

  if (!batch.ids || batch.ids.length === 0) {
    if (batch.done) {
      console.log(`[${WORKER_ID}] Scan complete!`);
      return false;
    }
    console.log(`[${WORKER_ID}] No IDs, waiting...`);
    await new Promise(resolve => setTimeout(resolve, 5000));
    return true;
  }

  console.log(`[${WORKER_ID}] Scanning ${batch.ids.length} IDs`);

  const found: any[] = [];
  const dead: number[] = [];
  const errors: number[] = [];

  // Scan en parallèle (10 concurrent)
  const chunks: number[][] = [];
  for (let i = 0; i < batch.ids.length; i += 10) {
    chunks.push(batch.ids.slice(i, i + 10));
  }

  for (const chunk of chunks) {
    const results = await Promise.all(chunk.map(id => scanId(id)));

    for (const result of results) {
      if (result.found && result.player) {
        found.push(result.player);
      } else if (result.error && result.id) {
        errors.push(result.id);
      } else if (result.id) {
        dead.push(result.id);
      }
    }
  }

  console.log(`[${WORKER_ID}] Results: ${found.length} found, ${dead.length} dead, ${errors.length} errors`);

  const submitResult = await submitResults(found, dead);
  if (submitResult) {
    console.log(`[${WORKER_ID}] Submitted:`, submitResult.inserted);
  }

  return true;
}

async function main() {
  console.log(`[${WORKER_ID}] Worker started`);

  while (true) {
    try {
      const shouldContinue = await runWorkerCycle();
      if (!shouldContinue) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (err) {
      console.error(`[${WORKER_ID}] Cycle error:`, err);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }

  console.log(`[${WORKER_ID}] Worker stopped`);
}

// Deno Deploy entry point
if (import.meta.main) {
  main();
}
