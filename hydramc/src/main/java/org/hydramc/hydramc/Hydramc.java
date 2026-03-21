package org.hydramc.hydramc;

import org.bukkit.plugin.java.JavaPlugin;

public final class Hydramc extends JavaPlugin {
    private HydraTxService hydraTxService;
    private HydraConfig hydraConfig;

    @Override
    public void onEnable() {
        hydraConfig = HydraConfig.fromEnv();
        hydraTxService = new HydraTxService(this, hydraConfig);
        hydraTxService.startListening();
        getServer().getPluginManager().registerEvents(
            new BlockBreakLogger(this, hydraTxService, hydraConfig.isLoggingEnabled()),
            this
        );
    }

    @Override
    public void onDisable() {
        if (hydraTxService != null) {
            hydraTxService.shutdown();
        }
    }
}
