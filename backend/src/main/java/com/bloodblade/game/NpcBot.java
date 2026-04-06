package com.bloodblade.game;

import com.bloodblade.game.model.*;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.Collection;
import java.util.Random;

/**
 * IA simple para combate de entrenamiento.
 * Persigue al jugador humano más cercano, ataca en rango y reacciona bloqueando.
 */
public class NpcBot {

    private static final Logger log = LoggerFactory.getLogger(NpcBot.class);

    public final Player player;
    private final GameConfig cfg;
    private final Random rng = new Random();

    // ─── Rangos ───────────────────────────────────────────────────────────────
    private static final double CHASE_RANGE_SQ = 20.0 * 20.0;
    private static final double DETECTION_RANGE_SQ = 25.0 * 25.0;

    // ─── Estado de deambulación ───────────────────────────────────────────────
    private long wanderChangeAt = 0;
    private double wanderYaw    = 0;

    // ─── Estado de combate ────────────────────────────────────────────────────
    private long   nextAttackAt        = 0;
    private long   blockUntil          = 0;
    private String lastBlockCheckedFor = null;
    /** Momento en que el bot suelta el attack tras cargar (WINDUP → RELEASE) */
    private long   botSwingReleaseAt   = 0L;

    public NpcBot(GameConfig cfg, String name) {
        this.cfg    = cfg;
        this.player = new Player(null, name, cfg);
    }

    /**
     * Genera el InputFrame del bot para el tick actual.
     * Debe llamarse antes de applyInput() en cada tick del GameRoom.
     *
     * IMPORTANTE: el movimiento se expresa en espacio LOCAL (igual que WASD del jugador humano).
     * applyInput() lo rotará por yaw para obtener el desplazamiento en espacio mundo.
     * Por eso: avanzar = inp.move.z = -1 (tecla W), no coordenadas de mundo.
     */
    public InputFrame buildInput(long now, Collection<Player> allPlayers, Collection<Destructible> destructibles) {
        if (!player.alive) return null;

        InputFrame inp = new InputFrame();
        inp.type     = "INPUT";
        inp.yaw      = player.yaw;
        inp.swingDir = player.swingDir;

        // Tras cargar el ataque, soltar en un momento creíble (humano: windup variable)
        if (player.swingPhase == SwingPhase.WINDUP && botSwingReleaseAt > 0 && now >= botSwingReleaseAt) {
            inp.attackRelease = true;
            botSwingReleaseAt = 0L;
        }

        Player enemy = findNearestEnemy(allPlayers);
        handleBlocking(now, enemy, inp);

        if (player.team == Team.BARBARIAN) {
            handleBarbarianLogic(now, enemy, destructibles, inp);
        } else {
            handleKnightLogic(now, enemy, inp);
        }

        return inp;
    }

    private void handleBarbarianLogic(long now, Player enemy, Collection<Destructible> destructibles, InputFrame inp) {
        // Priorizar enemigos cercanos si están en rango de detección
        if (enemy != null) {
            double dx   = enemy.x - player.x;
            double dz   = enemy.z - player.z;
            double dSq  = dx * dx + dz * dz;

            if (dSq < CHASE_RANGE_SQ) {
                engageTarget(enemy.x, enemy.z, Math.sqrt(dSq), inp, now);
                return;
            }
        }

        // Si no hay enemigos cerca, buscar murallas o el castillo
        Destructible targetObj = findNearestDestructible(destructibles);
        if (targetObj != null) {
            double dx   = targetObj.x - player.x;
            double dz   = targetObj.z - player.z;
            double dist = Math.sqrt(dx * dx + dz * dz);
            
            // Si está muy cerca de una muralla, la golpea
            engageTarget(targetObj.x, targetObj.z, dist, inp, now);
        } else {
            wander(now, inp);
        }
    }

    private void handleKnightLogic(long now, Player enemy, InputFrame inp) {
        // Detectar bárbaros y atacarlos
        if (enemy != null) {
            double dx   = enemy.x - player.x;
            double dz   = enemy.z - player.z;
            double dSq  = dx * dx + dz * dz;

            if (dSq < DETECTION_RANGE_SQ) {
                engageTarget(enemy.x, enemy.z, Math.sqrt(dSq), inp, now);
                return;
            }
        }

        // Si no hay enemigos, patrullar el patio
        patrol(now, inp);
    }

    private void engageTarget(double tx, double tz, double dist, InputFrame inp, long now) {
        double dx = tx - player.x;
        double dz = tz - player.z;
        double angle = Math.atan2(dx, -dz);
        player.yaw = angle;
        inp.yaw    = angle;

        if (dist > cfg.hitReach * 0.8) {
            double speed = (dist > cfg.hitReach * 2.5) ? 0.65 : 0.35;
            inp.move.z = -speed;
            inp.move.x = 0;
        }

        // Atacar cuando en rango, no bloqueando y no en swing
        if (dist <= cfg.hitReach * 1.2 && !player.blocking && player.swingPhase == SwingPhase.IDLE && now >= nextAttackAt) {
            SwingDirection chosen = rng.nextBoolean() ? SwingDirection.LEFT : SwingDirection.RIGHT;
            inp.attackStart = true;
            inp.swingDir    = chosen;
            player.swingDir = chosen;
            long chargeMs   = (long) (cfg.windupMs * (0.45 + rng.nextDouble() * 0.40));
            botSwingReleaseAt = now + chargeMs;
            nextAttackAt      = now + 1200 + rng.nextInt(1000);
            log.debug("[Bot {}] CARGANDO ataque {} (soltará en {}ms, dist={})", 
                    player.name, chosen, chargeMs, String.format("%.2f", dist));
        }
    }

    // ─── Lógica de bloqueo ────────────────────────────────────────────────────

    private void handleBlocking(long now, Player threat, InputFrame inp) {
        if (player.blocking && now >= blockUntil) {
            inp.blockUp = true;
        }

        if (threat != null && threat.swingPhase == SwingPhase.WINDUP) {
            double dx = threat.x - player.x;
            double dz = threat.z - player.z;
            double dSq = dx * dx + dz * dz;

            if (dSq < cfg.hitReach * cfg.hitReach * 1.5 && !threat.id.equals(lastBlockCheckedFor)) {
                lastBlockCheckedFor = threat.id;
                if (!player.blocking && rng.nextInt(100) < 60) { // 60% chance de bloquear
                    SwingDirection blockDir = threat.swingDir.getOpposite();
                    inp.blockDown   = true;
                    inp.swingDir    = blockDir;
                    player.swingDir = blockDir;
                    blockUntil      = now + 1500;
                }
            }
        } else {
            lastBlockCheckedFor = null;
        }
    }

    // ─── Navegación y Patrulla ───────────────────────────────────────────────

    private double patrolTargetX = 0;
    private double patrolTargetZ = 60;
    private long patrolNextChange = 0;

    private void patrol(long now, InputFrame inp) {
        if (now >= patrolNextChange) {
            // El patio está cerca del castillo (z=75) y murallas (z=55)
            patrolTargetX = (rng.nextDouble() * 2 - 1) * (cfg.worldWidth * 0.4);
            patrolTargetZ = 58 + rng.nextDouble() * 12; // Entre murallas y castillo
            patrolNextChange = now + 5000 + rng.nextInt(5000);
        }

        double dx = patrolTargetX - player.x;
        double dz = patrolTargetZ - player.z;
        double dist = Math.sqrt(dx * dx + dz * dz);

        if (dist > 1.0) {
            double angle = Math.atan2(dx, -dz);
            player.yaw = angle;
            inp.yaw    = angle;
            inp.move.z = -0.4;
        } else {
            wander(now, inp);
        }
    }

    private void wander(long now, InputFrame inp) {
        if (now >= wanderChangeAt) {
            wanderYaw      = rng.nextDouble() * Math.PI * 2;
            wanderChangeAt = now + 2000 + rng.nextInt(3000);
        }
        player.yaw = wanderYaw;
        inp.yaw    = wanderYaw;
        inp.move.z = -0.4;
        inp.move.x = 0;
    }

    // ─── Buscar Objetivos ───────────────────────────────────────────────────

    private Player findNearestEnemy(Collection<Player> players) {
        Player nearest = null;
        double minSq   = DETECTION_RANGE_SQ;
        for (Player p : players) {
            if (p == this.player || !p.alive || p.team == player.team) continue;
            double dx  = p.x - player.x;
            double dz  = p.z - player.z;
            double dSq = dx * dx + dz * dz;
            if (dSq < minSq) { minSq = dSq; nearest = p; }
        }
        return nearest;
    }

    private Destructible findNearestDestructible(Collection<Destructible> objects) {
        Destructible nearest = null;
        double minSq = Double.MAX_VALUE;
        for (Destructible d : objects) {
            if (!d.alive()) continue;
            double dx = d.x - player.x;
            double dz = d.z - player.z;
            double dSq = dx * dx + dz * dz;
            if (dSq < minSq) { minSq = dSq; nearest = d; }
        }
        return nearest;
    }
}
