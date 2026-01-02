import axios from "axios";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "fs";
import path from "path";

type BlockfrostAmount = {
  unit: string;
  quantity: string;
};

type BlockfrostAddressResponse = {
  address: string;
  amount: BlockfrostAmount[];
};

type AddressRecord = {
  node: number;
  label: "payment" | "funding";
  address: string;
};

const projectRoot = path.resolve(__dirname, "..");
const defaultKeysDir = path.resolve(projectRoot, "../../data/keys");
const keysDir = path.resolve(process.env.KEYS_DIR ?? defaultKeysDir);
const blockfrostApiKey = process.env.BLOCKFROST_API_KEY;

if (!blockfrostApiKey) {
  throw new Error("BLOCKFROST_API_KEY is required");
}

const blockfrostBaseUrl =
  "https://cardano-preprod.blockfrost.io/api/v0/addresses";

const isNumericDirectory = (entryName: string, fullPath: string) =>
  /^\d+$/.test(entryName) && statSync(fullPath).isDirectory();

const readAddress = (filePath: string) => {
  if (!existsSync(filePath)) {
    return null;
  }
  const address = readFileSync(filePath, "utf8").trim();
  return address.length > 0 ? address : null;
};

const discoverAddresses = (): AddressRecord[] => {
  if (!existsSync(keysDir)) {
    throw new Error(`Keys directory not found: ${keysDir}`);
  }

  const entries = readdirSync(keysDir);
  const addresses: AddressRecord[] = [];

  entries.forEach((entry) => {
    const fullPath = path.join(keysDir, entry);
    if (!isNumericDirectory(entry, fullPath)) {
      return;
    }

    const nodeId = Number.parseInt(entry, 10);
    const payment = readAddress(path.join(fullPath, "address.preprod"));
    const funding = readAddress(
      path.join(fullPath, "address-funding.preprod")
    );

    if (payment) {
      addresses.push({ node: nodeId, label: "payment", address: payment });
    }
    if (funding) {
      addresses.push({ node: nodeId, label: "funding", address: funding });
    }
  });

  if (addresses.length === 0) {
    throw new Error(`No addresses found in ${keysDir}`);
  }

  return addresses.sort((a, b) => a.node - b.node);
};

const formatAda = (lovelace: bigint) => {
  const adaWhole = lovelace / 1_000_000n;
  const adaFraction = lovelace % 1_000_000n;
  return `${adaWhole}.${adaFraction.toString().padStart(6, "0")}`;
};

const getLovelaceFromAmount = (amounts: BlockfrostAmount[]) => {
  const lovelaceEntry = amounts.find((entry) => entry.unit === "lovelace");
  return lovelaceEntry ? BigInt(lovelaceEntry.quantity) : 0n;
};

const adaToLovelace = (ada: number) => BigInt(ada) * 1_000_000n;
const minimumAda = adaToLovelace(50);

const fetchBalance = async (
  address: string
): Promise<BlockfrostAddressResponse> => {
  const response = await axios.get<BlockfrostAddressResponse>(
    `${blockfrostBaseUrl}/${address}`,
    {
      headers: {
        project_id: blockfrostApiKey,
      },
    }
  );

  return response.data;
};

const main = async () => {
  console.log(`Reading addresses from ${keysDir}`);
  const addresses = discoverAddresses();
  let hasEmptyOrLowBalance = false;
  let encounteredError = false;

  for (const entry of addresses) {
    try {
      const data = await fetchBalance(entry.address);
      const lovelace = getLovelaceFromAmount(data.amount);
      const ada = formatAda(lovelace);
      console.log(
        `[node ${entry.node} ${entry.label}] ${entry.address} -> ${ada} ADA (${lovelace} lovelace)`
      );
      if (lovelace < minimumAda) {
        hasEmptyOrLowBalance = true;
      }
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        console.log(
          `[node ${entry.node} ${entry.label}] ${entry.address} -> 0.000000 ADA (empty wallet)`
        );
        hasEmptyOrLowBalance = true;
        continue;
      }
      console.error(
        `[node ${entry.node} ${entry.label}] Failed to fetch balance for ${entry.address}:`,
        (error as Error).message ?? error
      );
      encounteredError = true;
    }
  }

  if (hasEmptyOrLowBalance || encounteredError) {
    process.exitCode = 1;
    return;
  }

  process.exitCode = 0;
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
