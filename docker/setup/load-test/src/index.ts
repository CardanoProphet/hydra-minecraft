/**
 * HydraMC Load Test
 *
 * Runs two parallel submitters (key-1 → hydra-node-1, key-2 → hydra-node-2)
 * against the same Hydra Head. Before the test phases, each submitter's
 * single UTxO is split into UTXO_SPLITS independent UTxOs, allowing that many
 * parallel TX chains per submitter with no UTxO conflicts.
 *
 * Total parallel chains = 2 × UTXO_SPLITS.
 *
 * The entire TX chain for each parallel chain is pre-built locally before any
 * submission begins. Because txHash is computed deterministically from the
 * transaction body, TX[i+1] can spend TX[i]'s output without waiting for TX[i]
 * to be confirmed.
 *
 * Usage:
 *   npm start
 *
 * Environment variables (all optional):
 *   HYDRA_API_URL_1  — Hydra node-1 HTTP URL (default: http://127.0.0.1:4001)
 *   HYDRA_API_URL_2  — Hydra node-2 HTTP URL (default: http://127.0.0.1:4002)
 *   KEYS_DIR         — path to the keys directory (default: ../../data/keys)
 *   WORLD_NAME       — Minecraft world name (default: world)
 *   UTXO_SPLITS      — UTxO chains per submitter (default: 5)
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";
import WebSocket from "ws";
import * as CSL from "@emurgo/cardano-serialization-lib-nodejs";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const HYDRA_API_URL_1 = process.env.HYDRA_API_URL_1 ?? "http://127.0.0.1:4001";
const HYDRA_API_URL_2 = process.env.HYDRA_API_URL_2 ?? "http://127.0.0.1:4002";
const HYDRA_WS_URL = HYDRA_API_URL_1.replace(/^http/, "ws");
const KEYS_DIR =
  process.env.KEYS_DIR ?? path.resolve(__dirname, "../../../data/keys");
const WORLD_NAME = process.env.WORLD_NAME ?? "world";
const UTXO_SPLITS = Math.max(1, parseInt(process.env.UTXO_SPLITS ?? "5", 10));
// Stagger chain starts so they don't all blast simultaneously on the first TX.
const CHAIN_STAGGER_MS = parseInt(process.env.CHAIN_STAGGER_MS ?? "50", 10);

// Block grid: 10-block line at x=-15, y=103, spread along the Z axis.
// A player standing at spawn and facing west sees a horizontal row of blocks
// appear and disappear in front of them.
const BLOCK_COORDS = Array.from({ length: 10 }, (_, i) => ({
  x: -15,
  y: 103,
  z: i - 4, // -4 … 5
}));

const PLACE_BLOCK_ID = "minecraft:stone";
const PLACE_BLOCK_NAME = "STONE";

// Test phases: all TXs in each chain are pre-built and submitted back-to-back.
// Names reflect burst size per chain.
const PHASES: Array<{ name: string; txCount: number }> = [
  { name: "warmup", txCount: 5 },
  { name: "burst_10tx", txCount: 10 },
  { name: "burst_20tx", txCount: 20 },
  { name: "burst_50tx", txCount: 50 },
];

const CONFIRMATION_TIMEOUT_MS = 60_000;
const RESULTS_DIR = path.resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type HydraUtxo = { txHash: string; index: number; lovelace: bigint };
type BlockEvent = {
  type: "block_place" | "block_break";
  x: number;
  y: number;
  z: number;
  timestampMs: number;
};
type TxResult = {
  submitter: string;
  txId: string;
  submittedAt: number;
  confirmedAt: number;
  latencyMs: number;
};
type PhaseResult = {
  name: string;
  txCountPerLoop: number;
  totalLoops: number;
  successCount: number;
  actualTps: number;
  avgLatencyMs: number;
  minLatencyMs: number;
  maxLatencyMs: number;
  results: TxResult[];
};
type Submitter = {
  label: string;
  apiUrl: string;
  address: string;
  privateKey: CSL.PrivateKey;
};

// ---------------------------------------------------------------------------
// Key loading
// ---------------------------------------------------------------------------

const readSkeyBytes = (filePath: string): Uint8Array => {
  const raw = readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw) as { cborHex?: string };
  const cborHex = parsed.cborHex;
  if (!cborHex) throw new Error(`cborHex missing in ${filePath}`);
  // CLI skeys have a 5820 CBOR prefix (byte-string of 32 bytes); strip it.
  const hex = cborHex.startsWith("5820") ? cborHex.slice(4) : cborHex;
  return Buffer.from(hex, "hex");
};

const loadSubmitter = (index: number, apiUrl: string): Submitter => {
  const skeyFile = path.join(KEYS_DIR, String(index), "cardano-funding.skey");
  const addrFile = path.join(
    KEYS_DIR,
    String(index),
    "address-funding.preprod",
  );
  return {
    label: `key-${index}`,
    apiUrl,
    address: readFileSync(addrFile, "utf8").trim(),
    privateKey: CSL.PrivateKey.from_normal_bytes(readSkeyBytes(skeyFile)),
  };
};

// ---------------------------------------------------------------------------
// UTxO fetching (used only once per submitter at startup)
// ---------------------------------------------------------------------------

const fetchLargestUtxo = async (
  apiUrl: string,
  address: string,
): Promise<HydraUtxo> => {
  const url = `${apiUrl}/snapshot/utxo?address=${encodeURIComponent(address)}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok)
    throw new Error(`UTxO fetch failed: ${res.status} ${await res.text()}`);

  const data = (await res.json()) as Record<string, unknown>;
  let best: HydraUtxo | null = null;

  for (const [key, val] of Object.entries(data)) {
    const v = val as {
      address?: string;
      value?: { lovelace?: number | string };
    };
    if (v.address !== address) continue;
    const lovelace = BigInt(v.value?.lovelace ?? 0);
    if (lovelace <= 0n) continue;
    const parts = key.split("#");
    if (parts.length !== 2) continue;
    const index = parseInt(parts[1], 10);
    if (!best || lovelace > best.lovelace) {
      best = { txHash: parts[0], index, lovelace };
    }
  }

  if (!best) throw new Error(`No UTxO found for ${address}`);
  return best;
};

// ---------------------------------------------------------------------------
// Transaction building
// ---------------------------------------------------------------------------

/** Split TX: 1 input → `count` equal outputs, no block-event metadata. */
const buildSplitTx = (
  utxo: HydraUtxo,
  address: string,
  privateKey: CSL.PrivateKey,
  count: number,
): { cborHex: string; txId: string } => {
  const inputs = CSL.TransactionInputs.new();
  inputs.add(
    CSL.TransactionInput.new(
      CSL.TransactionHash.from_hex(utxo.txHash),
      utxo.index,
    ),
  );

  const outputs = CSL.TransactionOutputs.new();
  const splitLovelace = utxo.lovelace / BigInt(count);
  const remainder = utxo.lovelace % BigInt(count);
  for (let i = 0; i < count; i++) {
    // Give the remainder to the first output so total lovelace is preserved.
    const amount = i === 0 ? splitLovelace + remainder : splitLovelace;
    outputs.add(
      CSL.TransactionOutput.new(
        CSL.Address.from_bech32(address),
        CSL.Value.new(CSL.BigNum.from_str(amount.toString())),
      ),
    );
  }

  const body = CSL.TransactionBody.new(
    inputs,
    outputs,
    CSL.BigNum.from_str("0"),
  );

  const txHash = CSL.hash_transaction(body);
  const witness = CSL.make_vkey_witness(txHash, privateKey);
  const vkeys = CSL.Vkeywitnesses.new();
  vkeys.add(witness);
  const witnessSet = CSL.TransactionWitnessSet.new();
  witnessSet.set_vkeys(vkeys);

  // No auxiliary data — this TX carries no block event.
  const tx = CSL.Transaction.new(body, witnessSet);
  return { cborHex: tx.to_hex(), txId: txHash.to_hex() };
};

/** Block-event TX: 1 input → 1 output, with label-674 metadata. */
const buildEventTx = (
  event: BlockEvent,
  utxo: HydraUtxo,
  address: string,
  privateKey: CSL.PrivateKey,
): { cborHex: string; txId: string } => {
  const inputs = CSL.TransactionInputs.new();
  inputs.add(
    CSL.TransactionInput.new(
      CSL.TransactionHash.from_hex(utxo.txHash),
      utxo.index,
    ),
  );

  const outputs = CSL.TransactionOutputs.new();
  outputs.add(
    CSL.TransactionOutput.new(
      CSL.Address.from_bech32(address),
      CSL.Value.new(CSL.BigNum.from_str(utxo.lovelace.toString())),
    ),
  );

  const body = CSL.TransactionBody.new(
    inputs,
    outputs,
    CSL.BigNum.from_str("0"),
  );

  // Metadata — label 674, same field names as HydraTxService.java
  const metaMap = CSL.MetadataMap.new();
  const ins = (k: string, v: string) =>
    metaMap.insert(
      CSL.TransactionMetadatum.new_text(k),
      CSL.TransactionMetadatum.new_text(v),
    );
  ins("type", event.type);
  ins("player", "load-test");
  ins("blockName", event.type === "block_place" ? PLACE_BLOCK_NAME : "AIR");
  ins(
    "blockId",
    event.type === "block_place" ? PLACE_BLOCK_ID : "minecraft:air",
  );
  ins("world", WORLD_NAME);
  ins("x", String(event.x));
  ins("y", String(event.y));
  ins("z", String(event.z));
  ins("timestampMs", String(event.timestampMs));

  const generalMeta = CSL.GeneralTransactionMetadata.new();
  generalMeta.insert(
    CSL.BigNum.from_str("674"),
    CSL.TransactionMetadatum.new_map(metaMap),
  );

  const auxData = CSL.AuxiliaryData.new();
  auxData.set_metadata(generalMeta);
  body.set_auxiliary_data_hash(CSL.hash_auxiliary_data(auxData));

  const txHash = CSL.hash_transaction(body);
  const witness = CSL.make_vkey_witness(txHash, privateKey);
  const vkeys = CSL.Vkeywitnesses.new();
  vkeys.add(witness);
  const witnessSet = CSL.TransactionWitnessSet.new();
  witnessSet.set_vkeys(vkeys);

  const tx = CSL.Transaction.new(body, witnessSet, auxData);
  return { cborHex: tx.to_hex(), txId: txHash.to_hex() };
};

// ---------------------------------------------------------------------------
// TX submission
// ---------------------------------------------------------------------------

const submitTx = async (apiUrl: string, cborHex: string): Promise<void> => {
  const res = await fetch(`${apiUrl}/transaction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "Tx ConwayEra",
      description: "HydraMC Load Test",
      cborHex,
    }),
  });
  if (res.status >= 300) {
    throw new Error(`TX submit failed: ${res.status} ${await res.text()}`);
  }
};

// ---------------------------------------------------------------------------
// WebSocket confirmation tracking
// ---------------------------------------------------------------------------

const createConfirmationTracker = (ws: WebSocket) => {
  const pending = new Map<string, (confirmedAt: number) => void>();

  ws.on("message", (data) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.tag !== "SnapshotConfirmed") return;

    const snapshot = msg.snapshot as { confirmed?: Array<{ txId?: string }> };
    const now = Date.now();
    for (const tx of snapshot.confirmed ?? []) {
      if (!tx.txId) continue;
      const resolve = pending.get(tx.txId);
      if (resolve) {
        resolve(now);
        pending.delete(tx.txId);
      }
    }
  });

  const waitForConfirmation = (txId: string): Promise<number> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(txId);
        reject(new Error(`Confirmation timeout for tx ${txId}`));
      }, CONFIRMATION_TIMEOUT_MS);
      pending.set(txId, (at) => {
        clearTimeout(timer);
        resolve(at);
      });
    });

  return { waitForConfirmation };
};

// ---------------------------------------------------------------------------
// UTxO splitting
// ---------------------------------------------------------------------------

const MIN_UTXO_LOVELACE = 1_000_000n;

const splitUtxo = async (
  submitter: Submitter,
  utxo: HydraUtxo,
  count: number,
  waitForConfirmation: (txId: string) => Promise<number>,
): Promise<HydraUtxo[]> => {
  // Clamp count to what the UTxO can fund (each output needs ≥ MIN_UTXO_LOVELACE).
  const maxSplits = Number(utxo.lovelace / MIN_UTXO_LOVELACE);
  const actualCount = Math.max(1, Math.min(count, maxSplits));
  if (actualCount < count) {
    console.warn(
      `  [${submitter.label}] UTxO too small to split into ${count} (${utxo.lovelace} lovelace). Clamping to ${actualCount}.`,
    );
  }
  if (actualCount === 1) return [utxo];

  console.log(
    `  [${submitter.label}] Splitting UTxO ${utxo.txHash}#${utxo.index} (${utxo.lovelace} lovelace) into ${actualCount} chains...`,
  );
  count = actualCount;

  const { cborHex, txId } = buildSplitTx(
    utxo,
    submitter.address,
    submitter.privateKey,
    count,
  );
  await submitTx(submitter.apiUrl, cborHex);
  await waitForConfirmation(txId);

  const splitLovelace = utxo.lovelace / BigInt(count);
  const remainder = utxo.lovelace % BigInt(count);

  const utxos: HydraUtxo[] = Array.from({ length: count }, (_, i) => ({
    txHash: txId,
    index: i,
    lovelace: i === 0 ? splitLovelace + remainder : splitLovelace,
  }));

  console.log(
    `  [${submitter.label}] Split confirmed → ${count} UTxOs of ~${splitLovelace} lovelace each`,
  );
  return utxos;
};

// ---------------------------------------------------------------------------
// Single-chain loop — pre-built chain, no wait between submits
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Pre-builds all `txCount` TXs for this chain before submitting any of them.
 * Because txHash is computed locally and is deterministic, TX[i+1] can safely
 * spend TX[i]'s output without waiting for TX[i] to be confirmed first.
 *
 * Submission order is preserved (sequential HTTP POSTs, no inter-TX await),
 * so Hydra sees the chain in dependency order and can validate each TX against
 * its in-flight ledger state. Confirmations are collected concurrently after
 * all submissions are done.
 *
 * Latency per TX is measured from the moment that TX was submitted to when its
 * SnapshotConfirmed event arrives. Later TXs in the chain naturally show higher
 * latency because multiple snapshots are needed to confirm the whole chain.
 */
const runLoop = async (
  submitter: Submitter,
  loopId: number,
  coordIndex: number,
  initialUtxo: HydraUtxo,
  txCount: number,
  waitForConfirmation: (txId: string) => Promise<number>,
): Promise<{ results: TxResult[]; finalUtxo: HydraUtxo }> => {
  const tag = `${submitter.label}[${loopId}]`;
  const coord = BLOCK_COORDS[coordIndex % BLOCK_COORDS.length];

  // Stagger chain startup so chains don't all blast simultaneously.
  if (CHAIN_STAGGER_MS > 0) await sleep(loopId * CHAIN_STAGGER_MS);

  // --- Step 1: pre-build the entire TX chain ---
  type BuiltTx = {
    cborHex: string;
    txId: string;
    eventType: "block_place" | "block_break";
  };
  const built: BuiltTx[] = [];
  let utxo = initialUtxo;

  for (let i = 0; i < txCount; i++) {
    const eventType: "block_place" | "block_break" =
      i % 2 === 0 ? "block_place" : "block_break";
    const event: BlockEvent = {
      type: eventType,
      x: coord.x,
      y: coord.y,
      z: coord.z,
      timestampMs: Date.now(),
    };
    const { cborHex, txId } = buildEventTx(
      event,
      utxo,
      submitter.address,
      submitter.privateKey,
    );
    built.push({ cborHex, txId, eventType });
    // The next TX in the chain spends this TX's sole output.
    utxo = { txHash: txId, index: 0, lovelace: utxo.lovelace };
  }

  // --- Step 2: submit all TXs back-to-back, collecting confirmation promises ---
  type Pending = {
    txId: string;
    submittedAt: number;
    confirmPromise: Promise<number>;
    eventType: string;
  };
  const pending: Pending[] = [];

  for (const { cborHex, txId, eventType } of built) {
    // Register the waiter before submitting so the handler is ready if
    // a SnapshotConfirmed arrives before we loop again.
    const confirmPromise = waitForConfirmation(txId);
    const submittedAt = Date.now();
    await submitTx(submitter.apiUrl, cborHex);
    pending.push({ txId, submittedAt, confirmPromise, eventType });
  }

  // --- Step 3: await all confirmations ---
  const results: TxResult[] = [];
  for (const { txId, submittedAt, confirmPromise, eventType } of pending) {
    let confirmedAt: number;
    try {
      confirmedAt = await confirmPromise;
    } catch (err) {
      console.warn(`  [${tag}] ${err}`);
      break;
    }
    const latencyMs = confirmedAt - submittedAt;
    results.push({
      submitter: submitter.label,
      txId,
      submittedAt,
      confirmedAt,
      latencyMs,
    });
    process.stdout.write(
      `  [${tag}] ${eventType.padEnd(11)} (-15, 103, ${String(coord.z).padStart(3)})  latency: ${latencyMs}ms\n`,
    );
  }

  return { results, finalUtxo: utxo };
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const main = async () => {
  const s1 = loadSubmitter(1, HYDRA_API_URL_1);
  const s2 = loadSubmitter(2, HYDRA_API_URL_2);
  const totalChains = 2 * UTXO_SPLITS;

  console.log(`HydraMC Load Test`);
  console.log(`  Submitter 1   : ${s1.label}  →  ${s1.apiUrl}`);
  console.log(`  Submitter 2   : ${s2.label}  →  ${s2.apiUrl}`);
  console.log(
    `  UTxO splits   : ${UTXO_SPLITS} per submitter  (${totalChains} parallel chains total)`,
  );
  console.log(
    `  Grid          : x=-15, y=103, z=${BLOCK_COORDS[0].z}..${BLOCK_COORDS[BLOCK_COORDS.length - 1].z}`,
  );
  console.log(`  World         : ${WORLD_NAME}`);
  console.log();

  // Single WebSocket on node-1 — all SnapshotConfirmed events are shared
  // across the head, so TXs submitted to node-2 appear here too.
  const ws = new WebSocket(HYDRA_WS_URL);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  console.log(`WebSocket connected to ${HYDRA_WS_URL}\n`);

  const { waitForConfirmation } = createConfirmationTracker(ws);

  // ---------------------------------------------------------------------------
  // Setup: fetch initial UTxOs and split them
  // ---------------------------------------------------------------------------
  console.log("=== Setup: splitting UTxOs ===");
  const [utxo1, utxo2] = await Promise.all([
    fetchLargestUtxo(s1.apiUrl, s1.address),
    fetchLargestUtxo(s2.apiUrl, s2.address),
  ]);

  let utxos1 = await splitUtxo(s1, utxo1, UTXO_SPLITS, waitForConfirmation);
  let utxos2 = await splitUtxo(s2, utxo2, UTXO_SPLITS, waitForConfirmation);
  console.log();

  // ---------------------------------------------------------------------------
  // Test phases
  // ---------------------------------------------------------------------------
  const allPhaseResults: PhaseResult[] = [];

  for (const phase of PHASES) {
    console.log(
      `\n--- Phase: ${phase.name}` +
        `  (${phase.txCount} TXs × ${totalChains} chains = ${phase.txCount * totalChains} total) ---`,
    );

    const phaseStart = Date.now();

    // Launch all chains for both submitters simultaneously.
    // Each loop gets a fixed coord: s1 loops take the first UTXO_SPLITS coords,
    // s2 loops take the next UTXO_SPLITS coords, cycling through BLOCK_COORDS.
    const loopArgs = (
      submitter: Submitter,
      utxos: HydraUtxo[],
      coordOffset: number,
    ) =>
      utxos.map((utxo, i) =>
        runLoop(
          submitter,
          i,
          coordOffset + i,
          utxo,
          phase.txCount,
          waitForConfirmation,
        ),
      );

    const [loops1, loops2] = await Promise.all([
      Promise.all(loopArgs(s1, utxos1, 0)),
      Promise.all(loopArgs(s2, utxos2, UTXO_SPLITS)),
    ]);

    // Persist final UTxOs for the next phase — each loop's chain continues.
    utxos1 = loops1.map((l) => l.finalUtxo);
    utxos2 = loops2.map((l) => l.finalUtxo);

    const combined = [...loops1, ...loops2]
      .flatMap((l) => l.results)
      .sort((a, b) => a.confirmedAt - b.confirmedAt);

    const latencies = combined.map((r) => r.latencyMs);
    const avg = latencies.length
      ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
      : 0;
    const min = latencies.length ? Math.min(...latencies) : 0;
    const max = latencies.length ? Math.max(...latencies) : 0;
    const elapsed =
      combined.length > 1
        ? (combined[combined.length - 1].confirmedAt - phaseStart) / 1000
        : 1;
    const actualTps = parseFloat((combined.length / elapsed).toFixed(2));

    allPhaseResults.push({
      name: phase.name,
      txCountPerLoop: phase.txCount,
      totalLoops: totalChains,
      successCount: combined.length,
      actualTps,
      avgLatencyMs: avg,
      minLatencyMs: min,
      maxLatencyMs: max,
      results: combined,
    });

    console.log(
      `  ✓ ${combined.length}/${phase.txCount * totalChains} TXs confirmed` +
        `  actual TPS: ${actualTps}` +
        `  latency avg/min/max: ${avg}ms / ${min}ms / ${max}ms`,
    );

    if (phase !== PHASES[PHASES.length - 1]) await sleep(2_000);
  }

  // ---------------------------------------------------------------------------
  // Cleanup: break all blocks so the grid is left empty
  // ---------------------------------------------------------------------------
  console.log("\n=== Cleanup: removing test blocks ===");

  const cleanupChain = async (
    submitter: Submitter,
    utxo: HydraUtxo,
  ): Promise<void> => {
    let current = utxo;
    for (const coord of BLOCK_COORDS) {
      const event: BlockEvent = {
        type: "block_break",
        x: coord.x,
        y: coord.y,
        z: coord.z,
        timestampMs: Date.now(),
      };
      try {
        const { cborHex, txId } = buildEventTx(
          event,
          current,
          submitter.address,
          submitter.privateKey,
        );
        await submitTx(submitter.apiUrl, cborHex);
        await waitForConfirmation(txId);
        current = { txHash: txId, index: 0, lovelace: current.lovelace };
        process.stdout.write(
          `  [${submitter.label}] block_break (-15, 103, ${String(coord.z).padStart(3)})  ✓\n`,
        );
      } catch (err) {
        console.warn(
          `  [${submitter.label}] Cleanup failed at z=${coord.z}: ${err}`,
        );
        break;
      }
    }
  };

  // Use the first surviving UTxO from each submitter for cleanup.
  await Promise.all([cleanupChain(s1, utxos1[0]), cleanupChain(s2, utxos2[0])]);

  ws.close();

  // ---------------------------------------------------------------------------
  // Write results
  // ---------------------------------------------------------------------------
  mkdirSync(RESULTS_DIR, { recursive: true });

  const reportPath = path.join(RESULTS_DIR, "load-test-report.json");
  writeFileSync(
    reportPath,
    JSON.stringify(
      { utxoSplits: UTXO_SPLITS, phases: allPhaseResults },
      null,
      2,
    ),
  );

  const csvPath = path.join(RESULTS_DIR, "load-test-results.csv");
  const csvLines = [
    "phase,submitter,tx_index,latency_ms,submitted_at_ms,confirmed_at_ms",
  ];
  for (const phase of allPhaseResults) {
    const idxBySubmitter: Record<string, number> = {};
    phase.results.forEach((r) => {
      idxBySubmitter[r.submitter] = (idxBySubmitter[r.submitter] ?? 0) + 1;
      csvLines.push(
        [
          phase.name,
          r.submitter,
          idxBySubmitter[r.submitter],
          r.latencyMs,
          r.submittedAt,
          r.confirmedAt,
        ].join(","),
      );
    });
  }
  writeFileSync(csvPath, csvLines.join("\n") + "\n");

  // ---------------------------------------------------------------------------
  // Final summary table
  // ---------------------------------------------------------------------------
  console.log(
    "\n╔════════════════════════════════════════════════════════════════════╗",
  );
  console.log(
    "║                       LOAD TEST SUMMARY                           ║",
  );
  console.log(
    "╠══════════════════╦═══════════╦════════╦══════════════════════════╣",
  );
  console.log(
    "║ Phase            ║ Actual TPS║ TXs    ║ Avg/Min/Max latency      ║",
  );
  console.log(
    "╠══════════════════╬═══════════╬════════╬══════════════════════════╣",
  );
  for (const p of allPhaseResults) {
    const latStr =
      p.successCount > 0
        ? `${p.avgLatencyMs}/${p.minLatencyMs}/${p.maxLatencyMs}ms`
        : "—";
    console.log(
      `║ ${p.name.padEnd(16)} ║ ${String(p.actualTps).padEnd(9)} ║ ${String(p.successCount).padEnd(6)} ║ ${latStr.padEnd(24)} ║`,
    );
  }
  console.log(
    "╚══════════════════╩═══════════╩════════╩══════════════════════════╝",
  );
  console.log(`\nDetailed report : ${reportPath}`);
  console.log(`CSV results     : ${csvPath}`);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
