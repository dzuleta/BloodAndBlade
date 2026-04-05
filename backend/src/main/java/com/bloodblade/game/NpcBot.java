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
    public InputFrame buildInput(long now, Collection<Player> allPlayers) {
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

        Player target = findNearestHuman(allPlayers);

        handleBlocking(now, target, inp);

        if (target == null) {
            wander(now, inp);
        } else {
            double dx   = target.x - player.x;
            double dz   = target.z - player.z;
            double dist = Math.sqrt(dx * dx + dz * dz);

            // Orientar hacia el objetivo.
            // La dirección "adelante" en espacio mundo con yaw Y es (sinY, -cosY).
            // Queremos que apunte a (dx/dist, dz/dist), entonces:
            //   sinY = dx/dist, cosY = -dz/dist  →  angle = atan2(dx, -dz)
            double angle = Math.atan2(dx, -dz);
            player.yaw = angle;
            inp.yaw    = angle;

            if (dist > cfg.hitReach) {
                // Perseguir: avanzar en espacio local (applyInput rota por yaw)
                double speed = (dist > cfg.hitReach * 2.5) ? 0.65 : 0.35;
                inp.move.z = -speed;  // negativo = adelante (igual que W)
                inp.move.x = 0;
            }

            // Atacar cuando en rango, no bloqueando y no en swing
            if (!player.blocking && player.swingPhase == SwingPhase.IDLE && now >= nextAttackAt) {
                SwingDirection[] dirs = SwingDirection.values();
                SwingDirection chosen = dirs[rng.nextInt(dirs.length)];
                inp.attackStart = true;
                inp.swingDir    = chosen;
                player.swingDir = chosen;
                long chargeMs   = (long) (cfg.windupMs * (0.55 + rng.nextDouble() * 0.40));
                botSwingReleaseAt = now + chargeMs;
                nextAttackAt      = now + 2000 + rng.nextInt(1000);
                log.debug("[Bot {}] CARGANDO ataque {} (soltará en {}ms, dist={})", player.name, chosen, chargeMs, String.format("%.2f", dist));
            }
        }

        return inp;
    }

    // ─── Lógica de bloqueo ────────────────────────────────────────────────────

    private void handleBlocking(long now, Player threat, InputFrame inp) {
        // Soltar el bloqueo cuando expire
        if (player.blocking && now >= blockUntil) {
            inp.blockUp = true;
            log.debug("[Bot {}] Soltando bloqueo", player.name);
        }

        if (threat != null && threat.swingPhase == SwingPhase.WINDUP) {
            // Decidir solo una vez por WINDUP entrante
            if (!threat.id.equals(lastBlockCheckedFor)) {
                lastBlockCheckedFor = threat.id;
                if (!player.blocking && rng.nextInt(2) == 0) {
                    inp.blockDown   = true;
                    inp.swingDir    = threat.swingDir;
                    player.swingDir = threat.swingDir;
                    // El rival puede cargar indefinidamente: mantener bloqueo largo
                    blockUntil      = now + 2800;
                    log.debug("[Bot {}] BLOQUEANDO dirección {} (reacción a WINDUP de {})",
                            player.name, threat.swingDir, threat.name);
                }
            }
        } else {
            lastBlockCheckedFor = null;
        }
    }

    // ─── Deambulación aleatoria ───────────────────────────────────────────────

    private void wander(long now, InputFrame inp) {
        if (now >= wanderChangeAt) {
            wanderYaw      = rng.nextDouble() * Math.PI * 2;
            wanderChangeAt = now + 2000 + rng.nextInt(3000);
        }
        player.yaw = wanderYaw;
        inp.yaw    = wanderYaw;
        inp.move.z = -0.4;  // avanzar en la dirección que mira
        inp.move.x = 0;
    }

    // ─── Buscar objetivo humano más cercano ───────────────────────────────────

    private Player findNearestHuman(Collection<Player> players) {
        Player nearest = null;
        double minSq   = CHASE_RANGE_SQ;
        for (Player p : players) {
            // p.session == null identifica bots (sin sesión real)
            if (p == this.player || !p.alive || p.session == null) continue;
            double dx  = p.x - player.x;
            double dz  = p.z - player.z;
            double dSq = dx * dx + dz * dz;
            if (dSq < minSq) { minSq = dSq; nearest = p; }
        }
        return nearest;
    }
}
