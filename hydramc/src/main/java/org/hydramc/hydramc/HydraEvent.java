package org.hydramc.hydramc;

import org.bukkit.Location;

public final class HydraEvent {
    public enum Type {
        BLOCK_BREAK,
        BLOCK_PLACE
    }

    private final Type type;
    private final String playerName;
    private final String blockName;
    private final String blockId;
    private final String worldName;
    private final int x;
    private final int y;
    private final int z;
    private final long timestampMs;

    private HydraEvent(
        Type type,
        String playerName,
        String blockName,
        String blockId,
        String worldName,
        int x,
        int y,
        int z,
        long timestampMs
    ) {
        this.type = type;
        this.playerName = playerName;
        this.blockName = blockName;
        this.blockId = blockId;
        this.worldName = worldName;
        this.x = x;
        this.y = y;
        this.z = z;
        this.timestampMs = timestampMs;
    }

    public static HydraEvent blockBreak(
        String playerName,
        String blockName,
        String blockId,
        String worldName,
        Location location
    ) {
        return from(Type.BLOCK_BREAK, playerName, blockName, blockId, worldName, location);
    }

    public static HydraEvent blockPlace(
        String playerName,
        String blockName,
        String blockId,
        String worldName,
        Location location
    ) {
        return from(Type.BLOCK_PLACE, playerName, blockName, blockId, worldName, location);
    }

    private static HydraEvent from(
        Type type,
        String playerName,
        String blockName,
        String blockId,
        String worldName,
        Location location
    ) {
        return new HydraEvent(
            type,
            playerName,
            blockName,
            blockId,
            worldName,
            location.getBlockX(),
            location.getBlockY(),
            location.getBlockZ(),
            System.currentTimeMillis()
        );
    }

    public Type getType() {
        return type;
    }

    public String getPlayerName() {
        return playerName;
    }

    public String getBlockName() {
        return blockName;
    }

    public String getBlockId() {
        return blockId;
    }

    public String getWorldName() {
        return worldName;
    }

    public int getX() {
        return x;
    }

    public int getY() {
        return y;
    }

    public int getZ() {
        return z;
    }

    public long getTimestampMs() {
        return timestampMs;
    }
}
