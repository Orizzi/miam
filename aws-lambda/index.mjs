/**
 * AWS Lambda Worker - WOS Scraper
 * Free tier: 1M requests/mois + 400k GB-s compute
 * Déploiement: Serverless Framework ou AWS SAM
 */

const API_BASE = process.env.API_BASE || 'https://wosforge.org/WPDS/api';
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE) || 100;

export const handler = async (event) => {
  const workerId = event.requestContext?.requestId || 'lambda-local';

  console.log(`[${workerId}] Fetching batch...`);

  try {
    // Fetch batch
    const batchRes = await fetch(`${API_BASE}/get-batch?count=${BATCH_SIZE}`);
    const batch = await batchRes.json();

    if (!batch.ids || batch.ids.length === 0) {
      return {
        statusCode: 200,
        body: JSON.stringify({ message: 'No IDs available', scanned: 0 })
      };
    }

    console.log(`[${workerId}] Scanning ${batch.ids.length} IDs`);

    const found = [];
    const dead = [];

    // Scan via coordination API (utilise proxies/CF du serveur OVH)
    const scanPromises = batch.ids.map(async (id) => {
      try {
        const res = await fetch(`${API_BASE}/scan-id`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id }),
        });

        const data = await res.json();

        if (data.found && data.player) {
          found.push({
            id,
            nickname: data.player.nickname,
            kid: data.player.kid || 0,
            stateLevel: data.player.stateLevel || 0,
          });
        } else {
          dead.push(id);
        }
      } catch (err) {
        console.error(`Error scanning ${id}:`, err.message);
      }
    });

    await Promise.all(scanPromises);

    // Submit results
    await fetch(`${API_BASE}/bulk-insert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ found, dead }),
    });

    console.log(`[${workerId}] Results: ${found.length} found, ${dead.length} dead`);

    return {
      statusCode: 200,
      body: JSON.stringify({
        scanned: batch.ids.length,
        found: found.length,
        dead: dead.length
      })
    };

  } catch (error) {
    console.error('Lambda error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message })
    };
  }
};
