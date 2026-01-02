package org.hydramc.hydramc;

import org.bukkit.Bukkit;
import org.bukkit.Location;
import org.bukkit.block.Block;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.block.BlockBreakEvent;
import org.bukkit.event.block.BlockPlaceEvent;
import org.bukkit.plugin.java.JavaPlugin;

public class BlockBreakLogger implements Listener {
    private final JavaPlugin plugin;

    public BlockBreakLogger(JavaPlugin plugin) {
        this.plugin = plugin;
    }

    @EventHandler
    public void onBlockBreak(BlockBreakEvent event) {
        Block block = event.getBlock();
        Location location = block.getLocation();

        String blockName = block.getType().name();
        String blockId = block.getType().getKey().toString();
        String worldName = location.getWorld() != null ? location.getWorld().getName() : "unknown";
        String coordinates = String.format("(%d, %d, %d)", location.getBlockX(), location.getBlockY(), location.getBlockZ());

        String message = String.format("Block broken: %s [%s] at %s in %s", blockName, blockId, coordinates, worldName);
        Bukkit.getServer().broadcastMessage(message);
    }

    @EventHandler
    public void onBlockPlace(BlockPlaceEvent event) {
        Block block = event.getBlockPlaced();
        Location location = block.getLocation();

        String blockName = block.getType().name();
        String blockId = block.getType().getKey().toString();
        String worldName = location.getWorld() != null ? location.getWorld().getName() : "unknown";
        String coordinates = String.format("(%d, %d, %d)", location.getBlockX(), location.getBlockY(), location.getBlockZ());

        String message = String.format("Block placed: %s [%s] at %s in %s", blockName, blockId, coordinates, worldName);
        Bukkit.getServer().broadcastMessage(message);
    }
}
