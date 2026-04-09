package com.bloodblade.game.model;

import org.springframework.web.socket.WebSocketSession;

import java.util.HashSet;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;

/** Estado completo de un jugador en el servidor (autoritativo) */
public class Player {

    // ─── Identificación ───────────────────────────────────────────────────
    public final String id = UUID.randomUUID().toString();
    public String name;
    public final WebSocketSession session;

    // ─── Posición y orientación ───────────────────────────────────────────
    public double x = 0;
    public double y = 0;
    public double z = 0;
    public double yaw = 0;
    public double pitch = 0;

    // ─── Vida ─────────────────────────────────────────────────────────────
    public int health;
    public final int maxHealth;
    public boolean alive = true;
    public long respawnAt = 0;                 // ms epoch; 0 = ya puede spawnear

    // ─── Estadísticas de sesión ───────────────────────────────────────────
    public final AtomicInteger kills = new AtomicInteger(0);
    public final AtomicInteger deaths = new AtomicInteger(0);

    // ─── Combate ─────────────────────────────────────────────────────────
    public SwingPhase swingPhase = SwingPhase.IDLE;
    public SwingDirection swingDir = SwingDirection.RIGHT;
    public long swingPhaseEnd = 0;            // ms epoch cuando termina la fase actual
    public long windupStartedAt = 0;          // ms epoch cuando inicio la carga del golpe
    public float swingCharge = 0.0f;          // [0,1] porcentaje de carga actual (HUD)
    public String swingPowerTier = "CANCEL";  // CANCEL | WEAK | FULL
    public float releaseDamageMultiplier = 1.0f;
    public float carriedWindupCharge = 0.0f;  // Carga retenida por feint (70-99%) con decay
    public boolean blocking = false;
    public SwingDirection blockDir = SwingDirection.RIGHT;
    public float stamina = 1.0f;             // [0, 1]

    public Team team = Team.KNIGHT;               // Equipo asignado

    /** Víctimas ya dañadas en este RELEASE (un tajo puede atravesar a varios, sin doble daño al mismo). */
    public final Set<String> hitIdsThisRelease = new HashSet<>();

    // ─── Input más reciente ────────────────────────────────────────────────
    public volatile InputFrame lastInput = null;

    // ─── Configuración del mundo (inyectada al crear) ──────────────────────
    private final GameConfig cfg;

    public Player(WebSocketSession session, String name, GameConfig cfg) {
        this.session = session;
        this.name = name;
        this.cfg = cfg;
        this.maxHealth = cfg.maxHealth;
        this.health = cfg.maxHealth;
        spawnAtRandom();
    }

    public void spawnAtRandom() {
        // Spawn aleatorio seguro (lejos de los castillos que están en +-70)
        this.x = (Math.random() * 2 - 1) * 25.0;
        
        if (team == Team.BARBARIAN) {
            this.z = -40.0 + (Math.random() * 10); // Entre -30 y -40
        } else {
            this.z = 40.0 - (Math.random() * 10);  // Entre 30 y 40
        }
        
        this.y = 0;
        this.health = maxHealth;
        this.alive = true;
        this.swingPhase = SwingPhase.IDLE;
        this.windupStartedAt = 0;
        this.swingCharge = 0.0f;
        this.swingPowerTier = "CANCEL";
        this.releaseDamageMultiplier = 1.0f;
        this.carriedWindupCharge = 0.0f;
        this.blocking = false;
        this.stamina = 1.0f;
        this.hitIdsThisRelease.clear();
    }

    public void applyInput(InputFrame inp, double dt) {
        if (!alive || inp == null) return;

        yaw = inp.yaw;
        pitch = inp.pitch;

        double mx = inp.move.x;
        double mz = inp.move.z;

        if (mx != 0 || mz != 0) {
            double sinY = Math.sin(yaw);
            double cosY = Math.cos(yaw);
            double speed = cfg.moveSpeed;
            x += (cosY * mx - sinY * mz) * speed * dt;
            z += (sinY * mx + cosY * mz) * speed * dt;
        }

        // Límites del mundo (cápsula con radio)
        double hw = cfg.worldWidth / 2.0 - cfg.playerRadius;
        double hd = cfg.worldDepth / 2.0 - cfg.playerRadius;
        x = Math.max(-hw, Math.min(hw, x));
        z = Math.max(-hd, Math.min(hd, z));
    }

    public boolean isSessionOpen() {
        return session != null && session.isOpen();
    }
}
