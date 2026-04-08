package com.bloodblade.game;

import com.bloodblade.game.model.*;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.Collection;
import java.util.ArrayList;
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

    private Collection<Destructible> lastVisibleDestructibles = new ArrayList<>();

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
        this.lastVisibleDestructibles = destructibles;
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
            handleBarbarianLogic(now, enemy, allPlayers, destructibles, inp);
        } else {
            handleKnightLogic(now, enemy, allPlayers, inp);
        }

        return inp;
    }

    private void handleBarbarianLogic(long now, Player enemy, Collection<Player> allPlayers, Collection<Destructible> destructibles, InputFrame inp) {
        // Priorizar enemigos cercanos si están en rango de detección
        if (enemy != null) {
            double dx   = enemy.x - player.x;
            double dz   = enemy.z - player.z;
            double dSq  = dx * dx + dz * dz;

            if (dSq < CHASE_RANGE_SQ) {
                double dist = Math.sqrt(dSq);
                moveTowardsWithSteering(enemy.x, enemy.z, dist, allPlayers, inp);
                attackTarget(dist, inp, now);
                return;
            }
        }

        // Si no hay enemigos cerca, buscar murallas o el castillo
        Destructible targetObj = findNearestDestructible(destructibles);
        if (targetObj != null) {
            // Añadir un pequeño "jitter" al objetivo para que no todos golpeen el mismo punto exacto del muro
            double targetX = targetObj.x + (rng.nextDouble() * 2 - 1) * (targetObj.width * 0.4);
            double targetZ = targetObj.z + (rng.nextDouble() * 2 - 1) * (targetObj.depth * 0.4);
            
            double dx   = targetX - player.x;
            double dz   = targetZ - player.z;
            double dist = Math.sqrt(dx * dx + dz * dz);
            
            moveTowardsWithSteering(targetX, targetZ, dist, allPlayers, inp);
            attackTarget(dist, inp, now);
        } else {
            // Si no hay objetivo, ir hacia la base enemiga (Castillo del Caballero en Z=75)
            double castleX = 0;
            double castleZ = cfg.worldDepth / 2.0 - 10.0;
            double dx = castleX - player.x;
            double dz = castleZ - player.z;
            moveTowardsWithSteering(castleX, castleZ, Math.sqrt(dx*dx + dz*dz), allPlayers, inp);
        }
    }

    private void handleKnightLogic(long now, Player enemy, Collection<Player> allPlayers, InputFrame inp) {
        // Detectar bárbaros y atacarlos
        if (enemy != null) {
            double dx   = enemy.x - player.x;
            double dz   = enemy.z - player.z;
            double dSq  = dx * dx + dz * dz;

            if (dSq < DETECTION_RANGE_SQ) {
                double dist = Math.sqrt(dSq);
                moveTowardsWithSteering(enemy.x, enemy.z, dist, allPlayers, inp);
                attackTarget(dist, inp, now);
                return;
            }
        }

        // Si no hay enemigos, atacar la base de los bárbaros (Sur)
        double baseTargetX = 0;
        double baseTargetZ = -cfg.worldDepth / 2.0 + 10.0;
        double dx = baseTargetX - player.x;
        double dz = baseTargetZ - player.z;
        double dist = Math.sqrt(dx*dx + dz*dz);
        moveTowardsWithSteering(baseTargetX, baseTargetZ, dist, allPlayers, inp);
        attackTarget(dist, inp, now);
    }

    private void moveTowardsWithSteering(double tx, double tz, double dist, Collection<Player> allPlayers, InputFrame inp) {
        // Vector hacia el objetivo (Atracción)
        double dx = tx - player.x;
        double dz = tz - player.z;
        double attractX = dx / Math.max(0.1, dist);
        double attractZ = dz / Math.max(0.1, dist);

        // Vector de repulsión de aliados (para no amontonarse)
        double repelX = 0;
        double repelZ = 0;
        for (Player other : allPlayers) {
            if (other == player || !other.alive || other.team != player.team) continue;
            double odx = player.x - other.x;
            double odz = player.z - other.z;
            double dSq = odx * odx + odz * odz;
            if (dSq < 20.25) { // Radio de repulsión aumentado: 4.5 unidades (4.5^2 = 20.25)
                double d = Math.sqrt(dSq);
                double force = (4.5 - d) / 4.5;
                repelX += (odx / Math.max(0.1, d)) * force;
                repelZ += (odz / Math.max(0.1, d)) * force;
            }
        }

        // Fuerza neta con mayor peso en la repulsión
        double netX = attractX + repelX * 4.0;
        double netZ = attractZ + repelZ * 4.0;

        // Orientar la mirada siempre al objetivo
        double angle = Math.atan2(dx, -dz);
        player.yaw = angle;
        inp.yaw    = angle;

        // Transformar dirección neta a espacio LOCAL para el input (W/A/S/D)
        double sinY = Math.sin(angle);
        double cosY = Math.cos(angle);
        double localMx = netX * cosY + netZ * sinY;
        double localMz = -netX * sinY + netZ * cosY;

        // --- Evitando muros (Obstacle Avoidance) ---
        // Si detectamos un muro cerca en la dirección que queremos ir, deslizar
        for (Destructible d : lastVisibleDestructibles) {
            if (!d.alive()) continue;
            double hw = d.width / 2.0 + 1.2; // Margen de seguridad
            double hd = d.depth / 2.0 + 1.2;
            
            // Si el jugador está dentro de un radio de influencia del muro
            if (Math.abs(player.x - d.x) < hw && Math.abs(player.z - d.z) < hd) {
                // Empujar hacia afuera del centro del muro
                double offX = player.x - d.x;
                double offZ = player.z - d.z;
                if (Math.abs(offX) / hw > Math.abs(offZ) / hd) {
                    netX += Math.signum(offX) * 2.5; 
                } else {
                    netZ += Math.signum(offZ) * 2.5;
                }
            }
        }

        // Recalcular localMx/Mz tras la evasión de muros
        localMx = netX * cosY + netZ * sinY;
        localMz = -netX * sinY + netZ * cosY;

        // Limitar velocidad
        double mag = Math.sqrt(localMx * localMx + localMz * localMz);
        if (mag > 1.0) {
            localMx /= mag;
            localMz /= mag;
        }

        if (dist > cfg.hitReach * 0.9) {
            double speed = (dist > cfg.hitReach * 3.0) ? 0.85 : 0.55;
            inp.move.x = localMx * speed;
            inp.move.z = localMz * speed;
        } else {
            // Ya en rango de ataque: la repulsión es prioritaria para repartir el ataque
            inp.move.x = (repelX * cosY + repelZ * sinY) * 0.55;
            inp.move.z = (-repelX * sinY + repelZ * cosY) * 0.55;
        }
    }

    private void attackTarget(double dist, InputFrame inp, long now) {
        // Atacar cuando en rango, no bloqueando y no en swing
        if (dist <= cfg.hitReach * 1.2 && !player.blocking && player.swingPhase == SwingPhase.IDLE && now >= nextAttackAt) {
            SwingDirection chosen = rng.nextBoolean() ? SwingDirection.LEFT : SwingDirection.RIGHT;
            inp.attackStart = true;
            inp.swingDir    = chosen;
            player.swingDir = chosen;
            long chargeMs   = (long) (cfg.windupMs * (0.45 + rng.nextDouble() * 0.40));
            botSwingReleaseAt = now + chargeMs;
            nextAttackAt      = now + 1200 + rng.nextInt(1000);
            log.debug("[Bot {}] ATACANDO (dist={})", player.name, String.format("%.2f", dist));
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
            if (!d.alive() || d.team == player.team) continue;
            double dx = d.x - player.x;
            double dz = d.z - player.z;
            double dSq = dx * dx + dz * dz;
            if (dSq < minSq) { minSq = dSq; nearest = d; }
        }
        return nearest;
    }
}
