/**
 * rate-test.mjs — Mesure le rate limit réel de l'API CenturyGame
 * Lance des appels en rafale avec différents délais pour trouver le seuil optimal.
 */

import { fetchPlayer } from "./api.mjs";

const TEST_ID = 70621376; // ID connu actif

async function testRate(delayMs, count = 10) {
  let success = 0;
  let rateLimited = 0;
  let errors = 0;
  const times = [];

  console.log(`\n--- Test: ${count} appels avec ${delayMs}ms de délai ---`);

  for (let i = 0; i < count; i++) {
    const start = Date.now();
    const result = await fetchPlayer(TEST_ID + i);
    const elapsed = Date.now() - start;
    times.push(elapsed);

    if (result.found) {
      success++;
      process.stdout.write("✓");
    } else if (result.error === "rate_limited") {
      rateLimited++;
      process.stdout.write("R");
    } else if (result.error === "network_error" || result.error === "timeout") {
      errors++;
      process.stdout.write("E");
    } else {
      success++; // player_not_found = valid response
      process.stdout.write("·");
    }

    if (delayMs > 0) await sleep(delayMs);
  }

  const avgMs = times.reduce((a, b) => a + b, 0) / times.length;
  console.log(`\n  → Succès: ${success} | Rate-limited: ${rateLimited} | Erreurs: ${errors}`);
  console.log(`  → Avg latence: ${avgMs.toFixed(0)}ms | Débit effectif: ${(1000 / (avgMs + delayMs)).toFixed(2)} req/s`);
  return { delayMs, success, rateLimited, errors, avgMs };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log("=== WOS API Rate Limit Test ===");
  console.log("API: https://wos-giftcode-api.centurygame.com/api/player");
  console.log("Légende: ✓=trouvé  ·=ID inexistant  R=rate-limited  E=erreur réseau\n");

  const results = [];

  // Rafale sans délai
  results.push(await testRate(0, 10));
  await sleep(3000);

  // 100ms
  results.push(await testRate(100, 15));
  await sleep(3000);

  // 200ms
  results.push(await testRate(200, 15));
  await sleep(3000);

  // 500ms
  results.push(await testRate(500, 10));
  await sleep(3000);

  // 1000ms
  results.push(await testRate(1000, 10));

  console.log("\n=== Résumé ===");
  console.log("Délai(ms) | Succès/10 | Limités | Débit(req/s)");
  for (const r of results) {
    const throughput = (1000 / (r.avgMs + r.delayMs)).toFixed(2);
    console.log(`${String(r.delayMs).padStart(9)} | ${String(r.success).padStart(9)} | ${String(r.rateLimited).padStart(7)} | ${throughput}`);
  }

  // Recommandation
  const best = results.filter((r) => r.rateLimited === 0).sort((a, b) => a.delayMs - b.delayMs)[0];
  if (best) {
    console.log(`\n✅ Délai recommandé: ${best.delayMs}ms (${(1000 / (best.avgMs + best.delayMs)).toFixed(2)} req/s)`);
  } else {
    console.log("\n⚠️  Tous les tests ont eu des rate limits — essayer avec > 1000ms");
  }
}

main().catch(console.error);
