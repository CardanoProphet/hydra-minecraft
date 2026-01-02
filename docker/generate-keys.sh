#!/bin/bash

source .env

USER_ID=${HOST_UID:-$(id -u)}
GROUP_ID=${HOST_GID:-$(id -g)}

mkdir -p "${DATA_DIR}/keys/1" "${DATA_DIR}/keys/2"

# Hydra keys
docker run --rm -u ${USER_ID}:${GROUP_ID} -v "${DATA_DIR}/keys/1:/out" ${HYDRA_NODE_IMAGE} gen-hydra-key --output-file /out/hydra
docker run --rm -u ${USER_ID}:${GROUP_ID} -v "${DATA_DIR}/keys/2:/out" ${HYDRA_NODE_IMAGE} gen-hydra-key --output-file /out/hydra

# Cardano NODE payment keys
docker run --rm -u ${USER_ID}:${GROUP_ID} -v "${DATA_DIR}/keys/1:/out" ${CARDANO_IMAGE} \
  cli address key-gen --verification-key-file /out/cardano.vkey --signing-key-file /out/cardano.skey
docker run --rm -u ${USER_ID}:${GROUP_ID} -v "${DATA_DIR}/keys/2:/out" ${CARDANO_IMAGE} \
  cli address key-gen --verification-key-file /out/cardano.vkey --signing-key-file /out/cardano.skey

# Cardano FUNDING payment keys
docker run --rm -u ${USER_ID}:${GROUP_ID} -v "${DATA_DIR}/keys/1:/out" ${CARDANO_IMAGE} \
  cli address key-gen --verification-key-file /out/cardano-funding.vkey --signing-key-file /out/cardano-funding.skey
docker run --rm -u ${USER_ID}:${GROUP_ID} -v "${DATA_DIR}/keys/2:/out" ${CARDANO_IMAGE} \
  cli address key-gen --verification-key-file /out/cardano-funding.vkey --signing-key-file /out/cardano-funding.skey

# Preprod NODE addresses (so you can fund via faucet)
docker run --rm -u ${USER_ID}:${GROUP_ID} -v "${DATA_DIR}/keys/1:/out" ${CARDANO_IMAGE} \
  cli address build --testnet-magic 1 --payment-verification-key-file /out/cardano.vkey --out-file /out/address.preprod
docker run --rm -u ${USER_ID}:${GROUP_ID} -v "${DATA_DIR}/keys/2:/out" ${CARDANO_IMAGE} \
  cli address build --testnet-magic 1 --payment-verification-key-file /out/cardano.vkey --out-file /out/address.preprod

# Preprod FUNDING addresses (so you can fund via faucet)
docker run --rm -u ${USER_ID}:${GROUP_ID} -v "${DATA_DIR}/keys/1:/out" ${CARDANO_IMAGE} \
  cli address build --testnet-magic 1 --payment-verification-key-file /out/cardano-funding.vkey --out-file /out/address-funding.preprod
docker run --rm -u ${USER_ID}:${GROUP_ID} -v "${DATA_DIR}/keys/2:/out" ${CARDANO_IMAGE} \
  cli address build --testnet-magic 1 --payment-verification-key-file /out/cardano-funding.vkey --out-file /out/address-funding.preprod


echo "Send at least 30 tADA to node-1:"
echo $(cat "${DATA_DIR}/keys/1/address.preprod")
echo ""

echo "Send any amount of tADA or assets to funding-1:"
echo $(cat "${DATA_DIR}/keys/1/address-funding.preprod")
echo ""

echo "Send at least 30 tADA to node-2:"
echo $(cat "${DATA_DIR}/keys/2/address.preprod")
echo ""

echo "Send any amount of tADA or assets to funding-2:"
echo $(cat "${DATA_DIR}/keys/2/address-funding.preprod")
echo ""
