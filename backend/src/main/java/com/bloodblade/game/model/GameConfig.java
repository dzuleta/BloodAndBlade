package com.bloodblade.game.model;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "game.room")
public class GameConfig {
    public int maxPlayers = 64;
    public int tickRateHz = 20;
    public double worldWidth = 80.0;
    public double worldDepth = 160.0;
    public long roundDurationMs = 300000;    // 5 minutos
    public double moveSpeed = 6.0;
    public double playerHeight = 1.8;
    public double playerRadius = 0.35;
    public int maxHealth = 100;

    // ─── Combate ──────────────────────────────────────────────────────────
    // Duración de cada fase de swing (ms)
    public long windupMs = 300;
    public long releaseMs = 200;
    public long recoveryMs = 350;
    public long blockedMs = 250;

    /** Alcance del golpe (mundo); coincide con la esfera/cilindro lógico de detectHit, no con el mesh de la espada. */
    public double hitReach = 2.0;

    // Daño base
    public int baseDamage = 35;

    // Stamina
    public float staminaRegenPerTick = 0.05f;
    public float staminaMinToAttack = 0.30f;
    public float staminaFullDamageThreshold = 0.45f;
    public float staminaCostSuccess = 0.20f;
    public float staminaCostMiss = 0.20f;

    // Respawn delay ms
    public long respawnDelayMs = 3000;
}
