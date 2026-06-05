/**
 * Phase 0 : Binary Search Discovery
 * Trouve les plages actives (1M par 1M) au lieu de scanner séquentiellement
 * Gain estimé : ×10-50 (teste 50M au lieu de 500M)
 */

import { fetchPlayer } from "./api.mjs";
import { savePlayer, markDead, db } from "./db.mjs";

const BLOCK_SIZE = 1_000_000;  // Tester par blocs de 1M
const MAX_ID = 500_000_000;
const SAMPLE_SIZE = 100;        // Tester 100 IDs par bloc pour détecter activité

/**
 * Phase 0 : Découverte des plages actives
 * Teste 1 sample par million (1M, 2M, 3M... 500M)
 * Marque les blocs où des players existent
 */
async function discoverActiveRanges() {
  console.log("🔍 Phase 0 : Binary Search Discovery");
  console.log(`   Scanning ${MAX_ID / BLOCK_SIZE} blocks of ${BLOCK_SIZE} IDs`);

  const activeRanges = [];
  const testedBlocks = [];

  for (let blockStart = 1; blockStart <= MAX_ID; blockStart += BLOCK_SIZE) {
    const blockEnd = Math.min(blockStart + BLOCK_SIZE - 1, MAX_ID);

    // Tester un échantillon d'IDs dans ce bloc
    const samples = [];
    const sampleInterval = Math.floor(BLOCK_SIZE / SAMPLE_SIZE);

    for (let i = 0; i < SAMPLE_SIZE; i++) {
      const sampleId = blockStart + (i * sampleInterval);
      if (sampleId <= blockEnd) {
        samples.push(sampleId);
      }
    }

    console.log(`   Testing block ${blockStart / BLOCK_SIZE}: ${blockStart}-${blockEnd} (${samples.length} samples)`);

    let foundCount = 0;
    let deadCount = 0;

    // Tester les samples en parallèle (10 concurrent)
    for (let i = 0; i < samples.length; i += 10) {
      const batch = samples.slice(i, i + 10);
      const results = await Promise.all(batch.map(id => fetchPlayer(id)));

      for (let j = 0; j < results.length; j++) {
        const result = results[j];
        const id = batch[j];

        if (!result.error && result.nickname) {
          foundCount++;
          try {
            savePlayer({
              id,
              nickname: result.nickname,
              kid: result.kid || 0,
              stateLevel: result.stateLevel || 0,
              avatarFrame: result.avatarFrame || 0,
              allianceTag: result.allianceTag || '',
            });
          } catch (err) {
            // Ignore duplicates
          }
        } else {
          deadCount++;
          try {
            markDead(id);
          } catch (err) {
            // Ignore duplicates
          }
        }
      }
    }

    const activityRate = foundCount / samples.length;

    testedBlocks.push({
      start: blockStart,
      end: blockEnd,
      found: foundCount,
      dead: deadCount,
      activityRate: activityRate,
    });

    // Si activité > 1%, considérer la plage active
    if (activityRate > 0.01) {
      activeRanges.push({ start: blockStart, end: blockEnd, activityRate });
      console.log(`   ✅ ACTIVE: ${blockStart}-${blockEnd} (${(activityRate * 100).toFixed(2)}% activity)`);
    } else {
      console.log(`   ⏭️  SKIP: ${blockStart}-${blockEnd} (${(activityRate * 100).toFixed(2)}% activity)`);
    }

    // Sauvegarder progression
    db.prepare(`
      INSERT OR REPLACE INTO scan_state (key, value)
      VALUES ('discovery_cursor', ?)
    `).run(blockEnd);
  }

  // Sauvegarder les plages actives
  console.log(`\n📊 Discovery Results:`);
  console.log(`   Total blocks: ${testedBlocks.length}`);
  console.log(`   Active blocks: ${activeRanges.length} (${((activeRanges.length / testedBlocks.length) * 100).toFixed(1)}%)`);
  console.log(`   IDs to scan: ${activeRanges.length * BLOCK_SIZE / 1_000_000}M (${((activeRanges.length / testedBlocks.length) * 100).toFixed(1)}% of total)`);

  // Sauvegarder en DB
  for (const range of activeRanges) {
    db.prepare(`
      INSERT OR REPLACE INTO active_ranges (start_id, end_id, activity_rate, discovered_at)
      VALUES (?, ?, ?, ?)
    `).run(range.start, range.end, range.activityRate, Date.now());
  }

  return activeRanges;
}

/**
 * Créer la table active_ranges si elle n'existe pas
 */
function initDiscoveryTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS active_ranges (
      start_id INTEGER PRIMARY KEY,
      end_id INTEGER NOT NULL,
      activity_rate REAL NOT NULL,
      discovered_at INTEGER NOT NULL,
      scanned INTEGER DEFAULT 0
    )
  `);
}

/**
 * Récupérer les plages actives non encore scannées
 */
export function getActiveRangesToScan() {
  return db.prepare(`
    SELECT start_id, end_id, activity_rate
    FROM active_ranges
    WHERE scanned = 0
    ORDER BY activity_rate DESC
  `).all();
}

/**
 * Marquer une plage comme scannée
 */
export function markRangeScanned(startId) {
  db.prepare(`
    UPDATE active_ranges
    SET scanned = 1
    WHERE start_id = ?
  `).run(startId);
}

// Main
if (import.meta.url === `file://${process.argv[1]}`) {
  initDiscoveryTable();

  const cursor = db.prepare(`SELECT value FROM scan_state WHERE key = 'discovery_cursor'`).pluck().get();

  if (cursor && parseInt(cursor) >= MAX_ID) {
    console.log("✅ Discovery already complete");
    const ranges = getActiveRangesToScan();
    console.log(`📋 ${ranges.length} active ranges ready to scan`);
    process.exit(0);
  }

  await discoverActiveRanges();
  console.log("\n✅ Discovery complete! Active ranges saved to DB.");
  console.log("   Run the main scraper to scan active ranges only.");
}
