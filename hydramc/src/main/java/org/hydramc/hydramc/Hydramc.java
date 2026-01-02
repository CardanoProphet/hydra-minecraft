package org.hydramc.hydramc;

import org.bukkit.plugin.java.JavaPlugin;

public final class Hydramc extends JavaPlugin {

    @Override
    public void onEnable() {
        getServer().getPluginManager().registerEvents(new BlockBreakLogger(this), this);
    }

    @Override
    public void onDisable() {}
}
