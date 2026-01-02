import { randomBytes } from "crypto";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import path from "path";
import {
  EnterpriseAddress,
  NetworkInfo,
  PrivateKey,
  PublicKey,
  StakeCredential,
} from "@emurgo/cardano-serialization-lib-nodejs";
import { getPublicKey, etc as ed25519Utils } from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";

type KeyPair = {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
};

const projectRoot = path.resolve(__dirname, "..");
const outputDir = path.resolve(process.env.KEYS_DIR ?? path.join(projectRoot, "keys"));
const pairsToCreate = Number.parseInt(process.env.KEY_PAIR_COUNT ?? "2", 10);

const networkId = NetworkInfo.testnet().network_id();

if (!Number.isFinite(pairsToCreate) || pairsToCreate < 1) {
  throw new Error("KEY_PAIR_COUNT must be a positive integer");
}

const ensureDir = (dir: string) => mkdirSync(dir, { recursive: true });

ed25519Utils.sha512Sync = (msg: Uint8Array) => sha512(msg);

const toCborHex = (bytes: Uint8Array) => {
  const lengthHex = bytes.length.toString(16).padStart(2, "0");
  return `58${lengthHex}${Buffer.from(bytes).toString("hex")}`;
};

const writeJson = (filePath: string, content: Record<string, unknown>) => {
  writeFileSync(filePath, `${JSON.stringify(content, null, 4)}\n`, "utf8");
};

const writeText = (filePath: string, content: string) => {
  writeFileSync(filePath, `${content.trim()}\n`, "utf8");
};

const generateHydraKeyPair = async (): Promise<KeyPair> => {
  const privateKey = randomBytes(32);
  const publicKey = getPublicKey(privateKey);
  return { privateKey, publicKey };
};

const generateCardanoKeyPair = () => {
  const signingKey = PrivateKey.generate_ed25519();
  const verificationKey = signingKey.to_public();
  return { signingKey, verificationKey };
};

const buildEnterpriseAddress = (verificationKey: PublicKey) => {
  const paymentCredential = StakeCredential.from_keyhash(
    verificationKey.hash()
  );
  return EnterpriseAddress.new(networkId, paymentCredential)
    .to_address()
    .to_bech32();
};

const generateNodeKeys = async (nodeIndex: number) => {
  const nodeDir = path.join(outputDir, String(nodeIndex));
  ensureDir(nodeDir);

  const hydra = await generateHydraKeyPair();
  writeJson(path.join(nodeDir, "hydra.sk"), {
    type: "HydraSigningKey_ed25519",
    description: "",
    cborHex: toCborHex(hydra.privateKey),
  });
  writeJson(path.join(nodeDir, "hydra.vk"), {
    type: "HydraVerificationKey_ed25519",
    description: "",
    cborHex: toCborHex(hydra.publicKey),
  });

  const payment = generateCardanoKeyPair();
  writeJson(path.join(nodeDir, "cardano.skey"), {
    type: "PaymentSigningKeyShelley_ed25519",
    description: "Payment Signing Key",
    cborHex: toCborHex(payment.signingKey.as_bytes()),
  });
  writeJson(path.join(nodeDir, "cardano.vkey"), {
    type: "PaymentVerificationKeyShelley_ed25519",
    description: "Payment Verification Key",
    cborHex: toCborHex(payment.verificationKey.as_bytes()),
  });

  const funding = generateCardanoKeyPair();
  writeJson(path.join(nodeDir, "cardano-funding.skey"), {
    type: "PaymentSigningKeyShelley_ed25519",
    description: "Payment Signing Key",
    cborHex: toCborHex(funding.signingKey.as_bytes()),
  });
  writeJson(path.join(nodeDir, "cardano-funding.vkey"), {
    type: "PaymentVerificationKeyShelley_ed25519",
    description: "Payment Verification Key",
    cborHex: toCborHex(funding.verificationKey.as_bytes()),
  });

  const paymentAddress = buildEnterpriseAddress(payment.verificationKey);
  const fundingAddress = buildEnterpriseAddress(funding.verificationKey);
  writeText(path.join(nodeDir, "address.preprod"), paymentAddress);
  writeText(path.join(nodeDir, "address-funding.preprod"), fundingAddress);

  return { paymentAddress, fundingAddress, nodeDir };
};

const requiredNodeFiles = [
  "hydra.sk",
  "hydra.vk",
  "cardano.skey",
  "cardano.vkey",
  "cardano-funding.skey",
  "cardano-funding.vkey",
  "address.preprod",
  "address-funding.preprod",
];

const nodeKeysExist = (nodeIndex: number) => {
  const nodeDir = path.join(outputDir, String(nodeIndex));
  return requiredNodeFiles.every((file) => existsSync(path.join(nodeDir, file)));
};

const main = async () => {
  console.log(`Generating keys into ${outputDir}`);
  const allKeysExist = Array.from({ length: pairsToCreate }, (_, idx) =>
    nodeKeysExist(idx + 1)
  ).every(Boolean);

  if (allKeysExist) {
    console.log("Keys already exist; skipping generation.");
    return;
  }

  const results = [];

  for (let i = 1; i <= pairsToCreate; i += 1) {
    const result = await generateNodeKeys(i);
    results.push(result);
  }

  results.forEach((result, idx) => {
    console.log(`\nNode ${idx + 1} keys written to ${result.nodeDir}`);
    console.log(
      `Send at least 50 tADA to node-${idx + 1}: ${result.paymentAddress}`
    );
    console.log(
      `Send at least 50 tADA to funding-${idx + 1}: ${result.fundingAddress}`
    );
  });
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
