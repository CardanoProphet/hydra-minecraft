package org.hydramc.hydramc;

import java.nio.file.Path;

public final class HydraConfig {
    private final String apiUrl;
    private final Path keysDir;
    private final int keyIndex;

    private HydraConfig(String apiUrl, Path keysDir, int keyIndex) {
        this.apiUrl = apiUrl;
        this.keysDir = keysDir;
        this.keyIndex = keyIndex;
    }

    public static HydraConfig fromEnv() {
        String apiUrl = getenv("HYDRA_API_URL", "http://hydra-node-1:4001");
        String keysDirRaw = getenv("HYDRA_KEYS_DIR", "/keys");
        int keyIndex = parseInt(getenv("HYDRA_KEY_INDEX", "1"), 1);

        return new HydraConfig(apiUrl, Path.of(keysDirRaw), keyIndex);
    }

    private static String getenv(String key, String fallback) {
        String value = System.getenv(key);
        return value == null || value.isBlank() ? fallback : value.trim();
    }

    private static int parseInt(String value, int fallback) {
        try {
            return Integer.parseInt(value);
        } catch (NumberFormatException ex) {
            return fallback;
        }
    }

    public String getApiUrl() {
        return apiUrl;
    }

    public Path getKeysDir() {
        return keysDir;
    }

    public int getKeyIndex() {
        return keyIndex;
    }

    public Path getSigningKeyPath() {
        return keysDir.resolve(String.valueOf(keyIndex)).resolve("cardano-funding.skey");
    }

    public Path getAddressPath() {
        return keysDir.resolve(String.valueOf(keyIndex)).resolve("address-funding.preprod");
    }
}
