import { existsSync, readFileSync } from "fs";
import path from "path";
import { HydraInstance, HydraProvider } from "@meshsdk/hydra";
import WebSocket from "ws";
import { BlockfrostProvider, MeshWallet, UTxO } from "@meshsdk/core";

type Participant = {
  id: number;
  label: string;
  fundingAddressFile: string;
  signingKeyFile: string;
  hydraApiUrl: string;
  hydraWsUrl: string;
};

type Config = {
  keysDir: string;
  blockfrostApiKey: string;
  participants: Participant[];
  networkId: 0 | 1;
};

const projectRoot = path.resolve(__dirname, "..");

const ensureFile = (filePath: string, description: string) => {
  if (!existsSync(filePath)) {
    throw new Error(`${description} not found: ${filePath}`);
  }
};

const readTrimmedFile = (filePath: string, description: string) => {
  ensureFile(filePath, description);
  const content = readFileSync(filePath, "utf8").trim();
  if (!content) {
    throw new Error(`${description} is empty: ${filePath}`);
  }
  return content;
};

const readSigningKeyHex = (filePath: string) => {
  const raw = readTrimmedFile(filePath, "signing key");
  try {
    const parsed = JSON.parse(raw);
    const cborHex: unknown = parsed.cborHex;
    if (typeof cborHex !== "string" || !cborHex.length) {
      throw new Error("cborHex missing in signing key file");
    }
    // CLI signing keys are CBOR-encoded; drop the 0x5820 prefix if present.
    const hex = cborHex.startsWith("5820") ? cborHex.slice(4) : cborHex;
    if (hex.length !== 64) {
      throw new Error(
        `signing key must be 64 hex chars, got ${hex.length} (from ${filePath})`
      );
    }
    return hex;
  } catch (error) {
    throw new Error(
      `Failed to parse signing key from ${filePath}: ${String(error)}`
    );
  }
};

const buildConfig = (): Config => {
  const keysDir = path.resolve(
    process.env.KEYS_DIR ?? path.join(projectRoot, "../../data/keys")
  );
  const blockfrostApiKey = process.env.BLOCKFROST_API_KEY;
  if (!blockfrostApiKey) {
    throw new Error("BLOCKFROST_API_KEY is required to query UTxOs");
  }

  const networkIdEnv = process.env.HYDRA_NETWORK_ID ?? "0";
  const networkIdNum = Number.parseInt(networkIdEnv, 10);
  if (networkIdNum !== 0 && networkIdNum !== 1) {
    throw new Error(
      `HYDRA_NETWORK_ID must be 0 (test) or 1 (mainnet), got "${networkIdEnv}"`
    );
  }

  const resolveHydraUrls = (id: number) => {
    const defaultApi =
      id === 1 ? "http://127.0.0.1:4001" : "http://127.0.0.1:4002";
    const api =
      process.env[`HYDRA_NODE_${id}_API`] ??
      (id === 1 ? process.env.HYDRA_NODE_API : undefined) ??
      defaultApi;
    const ws =
      process.env[`HYDRA_NODE_${id}_WS`] ??
      (id === 1 ? process.env.HYDRA_NODE_WS : undefined) ??
      api.replace(/^http/, "ws");
    return { api, ws };
  };

  const node1Urls = resolveHydraUrls(1);
  const node2Urls = resolveHydraUrls(2);

  const participants: Participant[] = [
    {
      id: 1,
      label: "alice",
      fundingAddressFile: path.join(keysDir, "1", "address-funding.preprod"),
      signingKeyFile: path.join(keysDir, "1", "cardano-funding.skey"),
      hydraApiUrl: node1Urls.api,
      hydraWsUrl: node1Urls.ws,
    },
    {
      id: 2,
      label: "bob",
      fundingAddressFile: path.join(keysDir, "2", "address-funding.preprod"),
      signingKeyFile: path.join(keysDir, "2", "cardano-funding.skey"),
      hydraApiUrl: node2Urls.api,
      hydraWsUrl: node2Urls.ws,
    },
  ];

  return {
    keysDir,
    blockfrostApiKey,
    participants,
    networkId: networkIdNum as 0 | 1,
  };
};

const fetchFundingUtxos = async (
  address: string,
  fetcher: BlockfrostProvider
) => {
  const utxos = await fetcher.fetchAddressUTxOs(address);
  if (!utxos.length) {
    throw new Error(`No UTxOs found to commit at ${address}`);
  }
  return utxos;
};

const waitForTxConfirmation = (
  provider: BlockfrostProvider,
  txHash: string,
  timeoutMs = 120_000
) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(new Error(`Timed out waiting for tx ${txHash} confirmation`)),
      timeoutMs
    );
    provider.onTxConfirmed(txHash, () => {
      clearTimeout(timer);
      resolve();
    });
  });

const getLovelaceAmount = (utxo: UTxO): bigint => {
  const lovelace = utxo.output.amount.find((a) => a.unit === "lovelace");
  return lovelace ? BigInt(lovelace.quantity) : 0n;
};

const commitUtxosForParticipant = async (
  participant: Participant,
  hydraInstance: HydraInstance,
  wallet: MeshWallet,
  utxos: UTxO[],
  blockfrost: BlockfrostProvider
) => {
  console.log(`[${participant.label}] Found ${utxos.length} UTxO(s) to commit`);

  const biggestUtxo = utxos.reduce((max, current) => {
    return getLovelaceAmount(current) > getLovelaceAmount(max) ? current : max;
  }, utxos[0]);

  const { txHash, outputIndex } = biggestUtxo.input;
  console.log(
    `[${participant.label}] Building commit for biggest UTxO ${txHash}#${outputIndex}`
  );
  const commitTx = await hydraInstance.commitFunds(txHash, outputIndex);
  console.log(
    `[${participant.label}] Signing commit transaction for ${txHash}#${outputIndex}`
  );
  const signedTx = await wallet.signTx(commitTx, true);
  const submittedHash = await wallet.submitTx(signedTx);
  console.log(
    `[${participant.label}] Submitted commit transaction ${submittedHash}`
  );
  console.log(
    `[${participant.label}] Waiting for commit transaction confirmation...`
  );
  await waitForTxConfirmation(blockfrost, submittedHash);
  console.log(
    `[${participant.label}] Commit transaction ${submittedHash} confirmed`
  );
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function getHydraHeadState(wsUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);

    ws.on("message", (data) => {
      const message = data.toString();
      try {
        const parsed = JSON.parse(message);
        if (typeof parsed.headStatus === "string") {
          ws.close();
          return resolve(parsed.headStatus);
        }
        throw new Error("headStatus missing from Hydra greeting");
      } catch (error) {
        ws.close();
        return reject(
          new Error(
            `Failed to parse headStatus from Hydra greeting: ${String(error)}`
          )
        );
      }
    });

    ws.on("error", (err) => {
      ws.close();
      reject(err);
    });
  });
}

const getHydraHeadStateWithRetry = async (
  wsUrl: string,
  retries = 30,
  delayMs = 2000
): Promise<string> => {
  let attempt = 0;
  // Retry connecting until the Hydra API is ready; avoids ECONNREFUSED on slow starts.
  while (true) {
    try {
      return await getHydraHeadState(wsUrl);
    } catch (error) {
      attempt += 1;
      if (attempt >= retries) {
        throw error;
      }
      console.log(
        `[hydra] Waiting for head websocket at ${wsUrl} (attempt ${attempt}/${retries})...`
      );
      await sleep(delayMs);
    }
  }
};

const main = async () => {
  const config = buildConfig();

  console.log(`Using keys from ${config.keysDir}`);
  console.log(
    `Hydra APIs: ${config.participants
      .map((p) => `${p.label} -> ${p.hydraApiUrl}`)
      .join(", ")}`
  );

  const blockfrost = new BlockfrostProvider(config.blockfrostApiKey);
  const controller = config.participants[0];
  const hydraProvider = new HydraProvider({
    httpUrl: controller.hydraApiUrl,
    wsUrl: controller.hydraWsUrl,
  });

  const initialStatus = await getHydraHeadStateWithRetry(controller.hydraWsUrl);
  console.log(`[hydra] Initial head status: ${initialStatus}`);

  if (initialStatus === "Open") {
    console.log("[hydra] Head already open; nothing to do.");
    return;
  }

  await hydraProvider.connect();

  if (initialStatus === "Idle") {
    console.log("[hydra] Sending Init to open the head");
    await hydraProvider.init();
  } else if (initialStatus === "Initializing") {
    console.log("[hydra] Head already initializing; skipping Init");
  } else {
    throw new Error(
      `[hydra] Head in unexpected status "${initialStatus}", aborting`
    );
  }

  console.log("[hydra] Head is initializing, committing funds...");

  for (const participant of config.participants) {
    const participantHydra = new HydraProvider({
      httpUrl: participant.hydraApiUrl,
      wsUrl: participant.hydraWsUrl,
    });
    const hydraInstance = new HydraInstance({
      provider: participantHydra,
      fetcher: blockfrost,
      submitter: blockfrost,
    });

    const address = readTrimmedFile(
      participant.fundingAddressFile,
      `${participant.label} funding address`
    );
    console.log(
      `[${participant.label}] Querying UTxOs from Blockfrost for ${address}`
    );
    const utxos = await fetchFundingUtxos(address, blockfrost);

    const wallet = new MeshWallet({
      networkId: config.networkId,
      fetcher: blockfrost,
      submitter: blockfrost,
      key: {
        type: "cli",
        // Mesh expects the raw private key hex, so parse it from the CLI .skey file.
        payment: readSigningKeyHex(participant.signingKeyFile),
      },
    });

    await commitUtxosForParticipant(
      participant,
      hydraInstance,
      wallet,
      utxos,
      blockfrost
    );
  }

  console.log("Hydra head is open and funds are committed.");
  process.exit(0);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
