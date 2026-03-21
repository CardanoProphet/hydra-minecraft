package org.hydramc.hydramc;

import com.bloxbean.cardano.client.common.cbor.CborSerializationUtil;
import com.bloxbean.cardano.client.crypto.Blake2bUtil;
import com.bloxbean.cardano.client.crypto.KeyGenUtil;
import com.bloxbean.cardano.client.crypto.SecretKey;
import com.bloxbean.cardano.client.crypto.VerificationKey;
import com.bloxbean.cardano.client.crypto.api.impl.EdDSASigningProvider;
import com.bloxbean.cardano.client.metadata.Metadata;
import com.bloxbean.cardano.client.metadata.MetadataBuilder;
import com.bloxbean.cardano.client.metadata.MetadataMap;
import com.bloxbean.cardano.client.transaction.spec.AuxiliaryData;
import com.bloxbean.cardano.client.transaction.spec.Transaction;
import com.bloxbean.cardano.client.transaction.spec.TransactionBody;
import com.bloxbean.cardano.client.transaction.spec.TransactionInput;
import com.bloxbean.cardano.client.transaction.spec.TransactionOutput;
import com.bloxbean.cardano.client.transaction.spec.TransactionWitnessSet;
import com.bloxbean.cardano.client.transaction.spec.Value;
import com.bloxbean.cardano.client.transaction.spec.VkeyWitness;
import com.bloxbean.cardano.client.util.HexUtil;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.bukkit.Bukkit;
import org.bukkit.Material;
import org.bukkit.World;
import org.bukkit.block.Block;
import org.bukkit.plugin.java.JavaPlugin;

import java.io.IOException;
import java.math.BigInteger;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.WebSocket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.time.Duration;
import java.util.ArrayDeque;
import java.util.Comparator;
import java.util.Deque;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

public final class HydraTxService {
    // https://github.com/cardano-foundation/CIPs/blob/master/CIP-0010/registry.json#L30-L33
    private static final BigInteger METADATA_LABEL = BigInteger.valueOf(674);
    private static final String METADATA_LABEL_TX_TYPE = "type";
    private static final String METADATA_LABEL_PLAYER = "player";
    private static final String METADATA_LABEL_BLOCK_NAME = "blockName";
    private static final String METADATA_LABEL_BLOCK_ID = "blockId";
    private static final String METADATA_LABEL_WORLD = "world";
    private static final String METADATA_LABEL_X = "x";
    private static final String METADATA_LABEL_Y = "y";
    private static final String METADATA_LABEL_Z = "z";
    private static final String METADATA_LABEL_TIMESTAMP = "timestampMs";
    private static final String HYDRA_TAG_SNAPSHOT_CONFIRMED = "SnapshotConfirmed";
    private static final long WS_RECONNECT_DELAY_MS = 2_000;
    private static final int MAX_SEEN_TX_IDS = 2_048;

    private final JavaPlugin plugin;
    private final HydraConfig config;
    private final HttpClient httpClient;
    private final ObjectMapper objectMapper;
    private final ExecutorService submitExecutor;
    private final ScheduledExecutorService listenerExecutor;
    private final Set<String> seenTxIds;
    private final Deque<String> seenTxOrder;
    private final byte[] signingKeyBytes;
    private final byte[] verificationKeyBytes;
    private final String address;

    private volatile boolean listening;
    private volatile WebSocket webSocket;
    private boolean reconnectScheduled;
    private boolean connectInProgress;

    public HydraTxService(JavaPlugin plugin, HydraConfig config) {
        this.plugin = plugin;
        this.config = config;
        this.httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5))
            .build();
        this.objectMapper = new ObjectMapper();
        this.submitExecutor = Executors.newSingleThreadExecutor(r -> {
            Thread thread = new Thread(r, "hydramc-hydra-submit");
            thread.setDaemon(true);
            return thread;
        });
        this.listenerExecutor = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread thread = new Thread(r, "hydramc-hydra-listener");
            thread.setDaemon(true);
            return thread;
        });
        this.seenTxIds = new HashSet<>();
        this.seenTxOrder = new ArrayDeque<>();

        try {
            this.signingKeyBytes = loadSigningKey(config.getSigningKeyPath().toString());
            VerificationKey vkey = KeyGenUtil.getPublicKeyFromPrivateKey(
                new SecretKey(readCborHex(config.getSigningKeyPath().toString()))
            );
            this.verificationKeyBytes = vkey.getBytes();
            this.address = Files.readString(config.getAddressPath(), StandardCharsets.UTF_8).trim();
        } catch (Exception ex) {
            throw new IllegalStateException("Failed to initialize Hydra keys", ex);
        }
    }

    public void startListening() {
        listening = true;
        listenerExecutor.execute(this::connectWebSocket);
    }

    public void submitBlockEvent(HydraEvent event) {
        submitExecutor.submit(() -> {
            try {
                Optional<HydraUtxo> utxo = fetchUtxoForAddress(address);
                if (utxo.isEmpty()) {
                    broadcast("[hydra] No UTxO available in head for " + address);
                    return;
                }

                SignedTx signedTx = buildSignedTransaction(event, utxo.get());
                String response = submitTransaction(signedTx);
                broadcast(String.format(
                    "[hydra] %s tx submitted: %s (utxo %s#%d)",
                    event.getType().name().toLowerCase(Locale.ROOT),
                    signedTx.txId(),
                    utxo.get().txHash(),
                    utxo.get().index()
                ));
                if (response != null && !response.isBlank()) {
                    plugin.getLogger().info("[hydra] Response: " + response);
                }
            } catch (Exception ex) {
                plugin.getLogger().warning("[hydra] Failed to submit tx: " + ex.getMessage());
                broadcast("[hydra] Tx submit failed: " + ex.getMessage());
            }
        });
    }

    public void shutdown() {
        listening = false;
        WebSocket socket = webSocket;
        webSocket = null;
        if (socket != null) {
            socket.abort();
        }
        submitExecutor.shutdownNow();
        listenerExecutor.shutdownNow();
    }

    private void connectWebSocket() {
        if (!listening || connectInProgress || webSocket != null) {
            return;
        }
        connectInProgress = true;
        reconnectScheduled = false;

        httpClient.newWebSocketBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .buildAsync(URI.create(config.getWsUrl()), new HydraWebSocketListener())
            .whenComplete((socket, error) -> listenerExecutor.execute(() -> {
                connectInProgress = false;
                if (!listening) {
                    if (socket != null) {
                        socket.abort();
                    }
                    return;
                }
                if (error != null) {
                    plugin.getLogger().warning("[hydra] WebSocket connect failed: " + error.getMessage());
                    scheduleReconnect();
                    return;
                }
                webSocket = socket;
                plugin.getLogger().info("[hydra] Listening for remote events on " + config.getWsUrl());
            }));
    }

    private void scheduleReconnect() {
        if (!listening || connectInProgress || reconnectScheduled || webSocket != null) {
            return;
        }
        reconnectScheduled = true;
        listenerExecutor.schedule(() -> {
            reconnectScheduled = false;
            connectWebSocket();
        }, WS_RECONNECT_DELAY_MS, TimeUnit.MILLISECONDS);
    }

    private void onWebSocketInterrupted(WebSocket socket, String reason) {
        if (webSocket == socket) {
            webSocket = null;
        }
        if (listening) {
            plugin.getLogger().warning("[hydra] WebSocket interrupted: " + reason);
        }
        scheduleReconnect();
    }

    private void handleWebSocketMessage(String rawMessage) {
        JsonNode root;
        try {
            root = objectMapper.readTree(rawMessage);
        } catch (IOException ex) {
            plugin.getLogger().warning("[hydra] Invalid websocket message: " + ex.getMessage());
            return;
        }

        if (!HYDRA_TAG_SNAPSHOT_CONFIRMED.equals(root.path("tag").asText())) {
            return;
        }

        JsonNode confirmed = root.path("snapshot").path("confirmed");
        if (!confirmed.isArray()) {
            return;
        }

        for (JsonNode txNode : confirmed) {
            processConfirmedTransaction(txNode);
        }
    }

    private void processConfirmedTransaction(JsonNode txNode) {
        String txId = txNode.path("txId").asText("");
        String cborHex = txNode.path("cborHex").asText("");
        if (cborHex.isBlank()) {
            return;
        }

        try {
            Transaction transaction = Transaction.deserialize(HexUtil.decodeHexString(cborHex));
            if (isOwnTransaction(transaction)) {
                return;
            }

            HydraEvent event = decodeEvent(transaction);
            if (event == null) {
                return;
            }

            String dedupeId = txId.isBlank() ? cborHex : txId;
            if (!markSeenTx(dedupeId)) {
                return;
            }

            applyRemoteEvent(event, txId);
        } catch (Exception ex) {
            plugin.getLogger().warning("[hydra] Failed to process confirmed tx: " + ex.getMessage());
        }
    }

    private boolean isOwnTransaction(Transaction tx) {
        TransactionBody body = tx.getBody();
        if (body == null || body.getOutputs() == null || body.getOutputs().isEmpty()) {
            return false;
        }

        String outputAddress = body.getOutputs().get(0).getAddress();
        return address.equals(outputAddress);
    }

    private boolean markSeenTx(String txId) {
        synchronized (seenTxIds) {
            if (seenTxIds.contains(txId)) {
                return false;
            }
            seenTxIds.add(txId);
            seenTxOrder.addLast(txId);
            while (seenTxOrder.size() > MAX_SEEN_TX_IDS) {
                String oldest = seenTxOrder.removeFirst();
                seenTxIds.remove(oldest);
            }
            return true;
        }
    }

    private HydraEvent decodeEvent(Transaction transaction) {
        AuxiliaryData auxiliaryData = transaction.getAuxiliaryData();
        if (auxiliaryData == null || auxiliaryData.getMetadata() == null) {
            return null;
        }

        Object eventData = auxiliaryData.getMetadata().get(METADATA_LABEL);
        if (!(eventData instanceof MetadataMap metadataMap)) {
            return null;
        }

        HydraEvent.Type type = parseEventType(metadataValue(metadataMap, METADATA_LABEL_TX_TYPE));
        if (type == null) {
            return null;
        }

        Integer x = parseInt(metadataValue(metadataMap, METADATA_LABEL_X));
        Integer y = parseInt(metadataValue(metadataMap, METADATA_LABEL_Y));
        Integer z = parseInt(metadataValue(metadataMap, METADATA_LABEL_Z));
        if (x == null || y == null || z == null) {
            return null;
        }

        Long timestamp = parseLong(metadataValue(metadataMap, METADATA_LABEL_TIMESTAMP));
        return HydraEvent.fromMetadata(
            type,
            metadataValueOrDefault(metadataMap, METADATA_LABEL_PLAYER, "unknown"),
            metadataValueOrDefault(metadataMap, METADATA_LABEL_BLOCK_NAME, "AIR"),
            metadataValueOrDefault(metadataMap, METADATA_LABEL_BLOCK_ID, "minecraft:air"),
            metadataValueOrDefault(metadataMap, METADATA_LABEL_WORLD, "world"),
            x,
            y,
            z,
            timestamp == null ? System.currentTimeMillis() : timestamp
        );
    }

    private HydraEvent.Type parseEventType(String type) {
        if (type == null) {
            return null;
        }
        return switch (type.toLowerCase(Locale.ROOT)) {
            case "block_break" -> HydraEvent.Type.BLOCK_BREAK;
            case "block_place" -> HydraEvent.Type.BLOCK_PLACE;
            default -> null;
        };
    }

    private String metadataValue(MetadataMap map, String key) {
        Object value = map.get(key);
        if (value == null) {
            return null;
        }
        if (value instanceof byte[] bytes) {
            return new String(bytes, StandardCharsets.UTF_8);
        }
        return value.toString();
    }

    private String metadataValueOrDefault(MetadataMap map, String key, String defaultValue) {
        String value = metadataValue(map, key);
        return value == null || value.isBlank() ? defaultValue : value;
    }

    private Integer parseInt(String value) {
        if (value == null || value.isBlank()) {
            return null;
        }
        try {
            return Integer.parseInt(value);
        } catch (NumberFormatException ex) {
            return null;
        }
    }

    private Long parseLong(String value) {
        if (value == null || value.isBlank()) {
            return null;
        }
        try {
            return Long.parseLong(value);
        } catch (NumberFormatException ex) {
            return null;
        }
    }

    private void applyRemoteEvent(HydraEvent event, String txId) {
        Bukkit.getScheduler().runTask(plugin, () -> {
            World world = Bukkit.getWorld(event.getWorldName());
            if (world == null) {
                plugin.getLogger().warning("[hydra] World not found for remote event: " + event.getWorldName());
                return;
            }

            Block block = world.getBlockAt(event.getX(), event.getY(), event.getZ());
            if (event.getType() == HydraEvent.Type.BLOCK_BREAK) {
                if (block.getType() != Material.AIR) {
                    block.setType(Material.AIR, false);
                }
            } else {
                Material material = resolveMaterial(event.getBlockId(), event.getBlockName());
                if (material == null || !material.isBlock()) {
                    plugin.getLogger().warning("[hydra] Unknown block type in remote event: " + event.getBlockId());
                    return;
                }
                if (block.getType() != material) {
                    block.setType(material, false);
                }
            }

            plugin.getLogger().info(String.format(
                "[hydra] Applied remote %s at (%d, %d, %d) in %s from tx %s",
                event.getType().name().toLowerCase(Locale.ROOT),
                event.getX(),
                event.getY(),
                event.getZ(),
                event.getWorldName(),
                txId == null || txId.isBlank() ? "unknown" : txId
            ));
        });
    }

    private Material resolveMaterial(String blockId, String blockName) {
        Material material = null;
        if (blockId != null && !blockId.isBlank()) {
            material = Material.matchMaterial(blockId);
            if (material == null && blockId.contains(":")) {
                String trimmed = blockId.substring(blockId.indexOf(':') + 1).toUpperCase(Locale.ROOT);
                material = Material.matchMaterial(trimmed);
                if (material == null) {
                    material = Material.getMaterial(trimmed);
                }
            }
        }
        if (material == null && blockName != null && !blockName.isBlank()) {
            material = Material.matchMaterial(blockName);
            if (material == null) {
                material = Material.getMaterial(blockName.toUpperCase(Locale.ROOT));
            }
        }
        return material;
    }

    private void broadcast(String message) {
        if (!config.isLoggingEnabled()) {
            return;
        }
        Bukkit.getScheduler().runTask(plugin, () -> Bukkit.getServer().broadcastMessage(message));
    }

    private Optional<HydraUtxo> fetchUtxoForAddress(String address) throws IOException, InterruptedException {
        String addressParamUrl = config.getApiUrl() + "/snapshot/utxo?address="
            + URLEncoder.encode(address, StandardCharsets.UTF_8);
        HttpResponse<String> response = sendUtxoRequest(addressParamUrl);
        // Success code is not always 200, there was also 202.
        if (response.statusCode() >= 300) {
            String fallbackUrl = config.getApiUrl() + "/snapshot/utxo";
            response = sendUtxoRequest(fallbackUrl);
            // Success code is not always 200, there was also 202.
            if (response.statusCode() >= 300) {
                throw new IOException("UTxO query failed: " + response.statusCode() + " " + response.body());
            }
        }

        JsonNode root = objectMapper.readTree(response.body());
        if (!root.isObject()) {
            throw new IOException("Unexpected UTxO response: " + response.body());
        }

        Iterator<Map.Entry<String, JsonNode>> fields = root.fields();
        return extractUtxos(fields, address).stream()
            .max(Comparator.comparingLong(HydraUtxo::lovelace));
    }

    private HttpResponse<String> sendUtxoRequest(String url) throws IOException, InterruptedException {
        HttpRequest request = HttpRequest.newBuilder(URI.create(url))
            .GET()
            .header("Accept", "application/json")
            .timeout(Duration.ofSeconds(10))
            .build();

        return httpClient.send(request, HttpResponse.BodyHandlers.ofString());
    }

    private List<HydraUtxo> extractUtxos(Iterator<Map.Entry<String, JsonNode>> fields, String address) {
        List<HydraUtxo> utxos = new java.util.ArrayList<>();
        while (fields.hasNext()) {
            Map.Entry<String, JsonNode> entry = fields.next();
            String key = entry.getKey();
            JsonNode value = entry.getValue();
            if (!value.isObject()) {
                continue;
            }
            String utxoAddress = value.path("address").asText("");
            if (!address.equals(utxoAddress)) {
                continue;
            }

            long lovelace = extractLovelace(value.path("value"));
            if (lovelace <= 0) {
                continue;
            }

            String[] parts = key.split("#");
            if (parts.length != 2) {
                continue;
            }
            String txHash = parts[0];
            int index;
            try {
                index = Integer.parseInt(parts[1]);
            } catch (NumberFormatException ex) {
                continue;
            }

            utxos.add(new HydraUtxo(txHash, index, lovelace));
        }
        return utxos;
    }

    private long extractLovelace(JsonNode valueNode) {
        if (valueNode.isObject()) {
            JsonNode lovelaceNode = valueNode.get("lovelace");
            if (lovelaceNode != null) {
                if (lovelaceNode.isNumber()) {
                    return lovelaceNode.longValue();
                }
                if (lovelaceNode.isTextual()) {
                    try {
                        return Long.parseLong(lovelaceNode.asText());
                    } catch (NumberFormatException ignored) {
                        return 0;
                    }
                }
            }
        } else if (valueNode.isArray()) {
            for (JsonNode amountNode : valueNode) {
                String unit = amountNode.path("unit").asText("");
                if (!"lovelace".equals(unit)) {
                    continue;
                }
                JsonNode qtyNode = amountNode.get("quantity");
                if (qtyNode == null) {
                    continue;
                }
                if (qtyNode.isNumber()) {
                    return qtyNode.longValue();
                }
                if (qtyNode.isTextual()) {
                    try {
                        return Long.parseLong(qtyNode.asText());
                    } catch (NumberFormatException ignored) {
                        return 0;
                    }
                }
            }
        }
        return 0;
    }

    private SignedTx buildSignedTransaction(HydraEvent event, HydraUtxo utxo) throws Exception {
        TransactionInput input = TransactionInput.builder()
            .transactionId(utxo.txHash())
            .index(utxo.index())
            .build();
        TransactionOutput output = new TransactionOutput(address, Value.builder()
            .coin(BigInteger.valueOf(utxo.lovelace()))
            .build());

        TransactionBody body = TransactionBody.builder()
            .inputs(List.of(input))
            .outputs(List.of(output))
            .fee(BigInteger.ZERO)
            .build();

        AuxiliaryData aux = buildMetadata(event);
        if (aux != null) {
            body.setAuxiliaryDataHash(aux.getAuxiliaryDataHash());
        }

        byte[] bodyBytes = CborSerializationUtil.serialize(body.serialize());
        byte[] txHashBytes = Blake2bUtil.blake2bHash256(bodyBytes);

        EdDSASigningProvider signer = new EdDSASigningProvider();
        byte[] signature = signer.sign(txHashBytes, signingKeyBytes);
        VkeyWitness witness = VkeyWitness.builder()
            .vkey(verificationKeyBytes)
            .signature(signature)
            .build();
        TransactionWitnessSet witnessSet = TransactionWitnessSet.builder()
            .vkeyWitnesses(List.of(witness))
            .build();

        Transaction tx = Transaction.builder()
            .body(body)
            .witnessSet(witnessSet)
            .auxiliaryData(aux)
            .build();

        String cborHex = tx.serializeToHex();
        String txId = HexUtil.encodeHexString(txHashBytes);
        return new SignedTx(cborHex, txId);
    }

    private AuxiliaryData buildMetadata(HydraEvent event) {
        Metadata metadata = MetadataBuilder.createMetadata();
        MetadataMap map = MetadataBuilder.createMap()
            .put(METADATA_LABEL_TX_TYPE, event.getType().name().toLowerCase(Locale.ROOT))
            .put(METADATA_LABEL_PLAYER, event.getPlayerName())
            .put(METADATA_LABEL_BLOCK_NAME, event.getBlockName())
            .put(METADATA_LABEL_BLOCK_ID, event.getBlockId())
            .put(METADATA_LABEL_WORLD, event.getWorldName())
            .put(METADATA_LABEL_X, Integer.toString(event.getX()))
            .put(METADATA_LABEL_Y, Integer.toString(event.getY()))
            .put(METADATA_LABEL_Z, Integer.toString(event.getZ()))
            .put(METADATA_LABEL_TIMESTAMP, Long.toString(event.getTimestampMs()));

        metadata.put(METADATA_LABEL, map);

        AuxiliaryData aux = new AuxiliaryData();
        aux.setMetadata(metadata);
        return aux;
    }

    private String submitTransaction(SignedTx signedTx) throws IOException, InterruptedException {
        String payload = objectMapper.writeValueAsString(Map.of(
            "type", "Tx ConwayEra",
            "description", "HydraMC Tx",
            "cborHex", signedTx.cborHex()
        ));

        HttpRequest request = HttpRequest.newBuilder(URI.create(config.getApiUrl() + "/transaction"))
            .header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(payload))
            .timeout(Duration.ofSeconds(10))
            .build();

        HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
        // Success code is not always 200, there was also 202.
        if (response.statusCode() >= 300) {
            throw new IOException("Hydra submit failed: " + response.statusCode() + " " + response.body());
        }
        return response.body();
    }

    private String readCborHex(String signingKeyPath) throws IOException {
        JsonNode node = objectMapper.readTree(
            Files.readString(java.nio.file.Path.of(signingKeyPath), StandardCharsets.UTF_8)
        );
        JsonNode cborHexNode = node.get("cborHex");
        if (cborHexNode == null || !cborHexNode.isTextual()) {
            throw new IOException("Missing cborHex in signing key file " + signingKeyPath);
        }
        return cborHexNode.asText();
    }

    private byte[] loadSigningKey(String signingKeyPath) throws IOException {
        String cborHex = readCborHex(signingKeyPath);
        SecretKey secretKey = new SecretKey(cborHex);
        byte[] bytes = secretKey.getBytes();
        if (bytes == null || bytes.length == 0) {
            throw new IOException("Empty signing key bytes in " + signingKeyPath);
        }
        return bytes;
    }

    private final class HydraWebSocketListener implements WebSocket.Listener {
        private final StringBuilder frameBuffer = new StringBuilder();

        @Override
        public void onOpen(WebSocket webSocket) {
            webSocket.request(1);
        }

        @Override
        public CompletionStage<?> onText(WebSocket webSocket, CharSequence data, boolean last) {
            frameBuffer.append(data);
            if (last) {
                String message = frameBuffer.toString();
                frameBuffer.setLength(0);
                listenerExecutor.execute(() -> handleWebSocketMessage(message));
            }
            webSocket.request(1);
            return CompletableFuture.completedFuture(null);
        }

        @Override
        public CompletionStage<?> onClose(WebSocket webSocket, int statusCode, String reason) {
            listenerExecutor.execute(() ->
                onWebSocketInterrupted(webSocket, "closed (" + statusCode + "): " + (reason == null ? "" : reason))
            );
            return CompletableFuture.completedFuture(null);
        }

        @Override
        public void onError(WebSocket webSocket, Throwable error) {
            listenerExecutor.execute(() ->
                onWebSocketInterrupted(webSocket, "error: " + (error == null ? "unknown" : error.getMessage()))
            );
        }
    }

    private record HydraUtxo(String txHash, int index, long lovelace) {}

    private record SignedTx(String cborHex, String txId) {}
}
