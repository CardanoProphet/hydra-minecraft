# Hydra Minecraft

This repository has two main parts:
- `hydramc`: a Paper (Minecraft) plugin that broadcasts block break/place events.
- `docker`: a Docker Compose stack that brings up Cardano + Hydra nodes and Paper servers.


## HydraMC plugin

- Runtime: Paper API `1.21.11` (Java 21).
- Entry point: `org.hydramc.hydramc.Hydramc`.

Build the plugin:
```bash
mvn -f hydramc/pom.xml clean package
```

The jar is created in `hydramc/target/`. To use it in the Docker stack,
copy the jar to `docker/plugins/` (the Compose stack mounts this directory into
both Paper servers).

## Docker stack

`docker/docker-compose.yml` orchestrates:
- `hydra-keys`: generates Hydra/Cardano key pairs.
- `check-balance`: verifies funding addresses have at least 50 tADA.
- `mithril-bootstrap`: bootstraps the Cardano ledger.
- `cardano-node`: Cardano node (preprod).
- `hydra-node-1` + `hydra-node-2`: Hydra nodes with APIs exposed.
- `open-hydra-head`: opens the Hydra head and commits funds.
- `paper-server-1` + `paper-server-2`: Paper servers with the plugin mounted.

Key ports:
- Cardano node: `3001`
- Hydra APIs: `4001`, `4002`
- Hydra peers: `5001`, `5002`
- Minecraft servers: `25565`, `25566`

## Environment configuration

Create a `.env` file in `docker/` with at least:
```
CARDANO_IMAGE=ghcr.io/intersectmbo/cardano-node:10.5.3
DATA_DIR=./data

MITHRIL_CLIENT_IMAGE=ghcr.io/input-output-hk/mithril-client:latest
HYDRA_NODE_IMAGE=ghcr.io/cardano-scaling/hydra-node:latest

CARDANO_NETWORK=preprod
HYDRA_NETWORK_MAGIC=1
HYDRA_SCRIPTS_TX_ID=hydra_scripts_tx_id
AGGREGATOR_ENDPOINT=https://aggregator.release-preprod.api.mithril.network/aggregator
GENESIS_VERIFICATION_KEY=mithril_genesis_verification_key
ANCILLARY_VERIFICATION_KEY=mithril_ancillary_verification_key
SNAPSHOT_DIGEST=latest
BLOCKFROST_API_KEY=your_blockfrost_api_key
```

Optional (for permissions on created files):
```
HOST_UID=1000
HOST_GID=1000
DATA_UID=1000
DATA_GID=1000
```

## Running the stack

From `docker/`:
```bash
docker compose up --build
```

The flow is:
1. Generate keys under `${DATA_DIR}/keys`.
2. Check Blockfrost balances for funding addresses (needs ≥ 50 tADA).
3. Bootstrap the Cardano DB (Mithril).
4. Start the Cardano node and Hydra nodes.
5. Open the Hydra head and commit the largest UTxOs.
6. Start both Paper servers with the `hydramc` plugin.
