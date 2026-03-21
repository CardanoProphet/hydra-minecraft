package org.hydramc.hydramc;

import java.nio.file.Path;

public final class HydraConfig {
    private final String apiUrl;
    private final String wsUrl;
    private final Path keysDir;
    private final int keyIndex;
    private final boolean loggingEnabled;

    private HydraConfig(String apiUrl, String wsUrl, Path keysDir, int keyIndex, boolean loggingEnabled) {
        this.apiUrl = apiUrl;
        this.wsUrl = wsUrl;
        this.keysDir = keysDir;
        this.keyIndex = keyIndex;
        this.loggingEnabled = loggingEnabled;
    }

    public static HydraConfig fromEnv() {
        String apiUrl = getenv("HYDRA_API_URL", "http://hydra-node-1:4001");
        String wsUrl = getenv("HYDRA_WS_URL", toWsUrl(apiUrl));
        String keysDirRaw = getenv("HYDRA_KEYS_DIR", "/keys");
        int keyIndex = parseInt(getenv("HYDRA_KEY_INDEX", "1"), 1);
        boolean loggingEnabled = parseBoolean(getenv("LOGGING_ENABLED", "false"), false);

        return new HydraConfig(apiUrl, wsUrl, Path.of(keysDirRaw), keyIndex, loggingEnabled);
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

    private static boolean parseBoolean(String value, boolean fallback) {
        if (value == null) {
            return fallback;
        }
        String normalized = value.trim().toLowerCase();
        if ("true".equals(normalized) || "1".equals(normalized) || "yes".equals(normalized) || "on".equals(normalized)) {
            return true;
        }
        if ("false".equals(normalized) || "0".equals(normalized) || "no".equals(normalized) || "off".equals(normalized)) {
            return false;
        }
        return fallback;
    }

    private static String toWsUrl(String apiUrl) {
        if (apiUrl.startsWith("https://")) {
            return "wss://" + apiUrl.substring("https://".length());
        }
        if (apiUrl.startsWith("http://")) {
            return "ws://" + apiUrl.substring("http://".length());
        }
        return apiUrl;
    }

    public String getApiUrl() {
        return apiUrl;
    }

    public String getWsUrl() {
        return wsUrl;
    }

    public Path getKeysDir() {
        return keysDir;
    }

    public int getKeyIndex() {
        return keyIndex;
    }

    public boolean isLoggingEnabled() {
        return loggingEnabled;
    }

    public Path getSigningKeyPath() {
        return keysDir.resolve(String.valueOf(keyIndex)).resolve("cardano-funding.skey");
    }

    public Path getAddressPath() {
        return keysDir.resolve(String.valueOf(keyIndex)).resolve("address-funding.preprod");
    }
}
