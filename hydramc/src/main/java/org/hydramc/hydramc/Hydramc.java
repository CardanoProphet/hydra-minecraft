package org.hydramc.hydramc;

import org.bukkit.plugin.java.JavaPlugin;

public final class Hydramc extends JavaPlugin {
    private HydraTxService hydraTxService;

    @Override
    public void onEnable() {
        hydraTxService = new HydraTxService(this, HydraConfig.fromEnv());
        getServer().getPluginManager().registerEvents(new BlockBreakLogger(this, hydraTxService), this);
    }

    @Override
    public void onDisable() {
        if (hydraTxService != null) {
            hydraTxService.shutdown();
        }
    }
}
