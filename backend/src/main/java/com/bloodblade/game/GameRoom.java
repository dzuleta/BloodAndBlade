package com.bloodblade.game;

import com.bloodblade.game.model.*;
import com.bloodblade.game.physics.HitResult;
import com.bloodblade.game.physics.PhysicsWorld;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

import java.io.IOException;
import java.util.*;
import java.util.concurrent.*;
import java.util.stream.Collectors;

/**
 * Sala única del mundo: máximo MAX_PLAYERS en juego activo + cola FIFO.
 * El GameLoop llama a tick() a la tasa configurada.
 */
public class GameRoom {

    private static final Logger log = LoggerFactory.getLogger(GameRoom.class);

    private final GameConfig cfg;
    private final PhysicsWorld physics;
    private final ObjectMapper mapper;

    // ─── Jugadores activos (en partida) ───────────────────────────────────
    private final ConcurrentHashMap<String, Player> activePlayers = new ConcurrentHashMap<>();

    // ─── Cola de espera (FIFO) ────────────────────────────────────────────
    // Cada entrada es [sessionId, session, playerName]
    private final ConcurrentLinkedQueue<QueueEntry> waitQueue = new ConcurrentLinkedQueue<>();

    // Mapeo sessionId → Player para búsquedas rápidas
    private final ConcurrentHashMap<String, Player> sessionToPlayer = new ConcurrentHashMap<>();

    // ─── Bots de entrenamiento ────────────────────────────────────────────
    private final List<NpcBot> bots = new ArrayList<>();
    private final List<Destructible> destructibles = new ArrayList<>();
    private long roundEndTime;

    private long tickCount = 0;

    public GameRoom(GameConfig cfg, PhysicsWorld physics, ObjectMapper mapper) {
        this.cfg = cfg;
        this.physics = physics;
        this.mapper = mapper;
        restartRound();
    }

    private void restartRound() {
        this.roundEndTime = System.currentTimeMillis() + cfg.roundDurationMs;
        this.destructibles.clear();

        // Castillo de los Caballeros (Norte, z ≈ +75)
        destructibles.add(
                new Destructible(Destructible.Type.CASTLE, 0, cfg.worldDepth / 2.0 - 5.0, 15, 10, 2000, Team.KNIGHT));
        // Murallas de los Caballeros (z ≈ +55)
        for (int i = -1; i <= 1; i++) {
            destructibles.add(new Destructible(Destructible.Type.WALL, i * 20, cfg.worldDepth / 2.0 - 25.0, 15, 3, 800,
                    Team.KNIGHT));
        }

        // Base de los Bárbaros (Sur, z ≈ -75)
        destructibles.add(new Destructible(Destructible.Type.CASTLE, 0, -cfg.worldDepth / 2.0 + 5.0, 15, 10, 2000,
                Team.BARBARIAN));
        // Murallas de los Bárbaros (z ≈ -55)
        for (int i = -1; i <= 1; i++) {
            destructibles.add(new Destructible(Destructible.Type.WALL, i * 20, -cfg.worldDepth / 2.0 + 25.0, 15, 3, 800,
                    Team.BARBARIAN));
        }

        // Posicionar jugadores
        for (Player p : activePlayers.values()) {
            p.spawnAtRandom();
        }
    }

    private void maintainTeamBalance() {
        long bbq = activePlayers.values().stream().filter(p -> p.team == Team.BARBARIAN).count();
        long knq = activePlayers.values().stream().filter(p -> p.team == Team.KNIGHT).count();
        if (bbq < 6)
            spawnBot(Team.BARBARIAN);
        if (knq < 6)
            spawnBot(Team.KNIGHT);
    }

    private void spawnBot(Team team) {
        String name = team == Team.BARBARIAN ? "[Bot] Barbaro " : "[Bot] Caballero ";
        NpcBot bot = new NpcBot(cfg, name + (bots.size() + 1));
        bot.player.team = team;
        bot.player.spawnAtRandom();
        activePlayers.put(bot.player.id, bot.player);
        bots.add(bot);
    }

    private void checkRoundEnd(long now, List<GameEvent> events) {
        boolean castleDestroyed = destructibles.stream()
                .anyMatch(d -> d.type == Destructible.Type.CASTLE && !d.alive());
        boolean timeOut = now >= roundEndTime;

        if (castleDestroyed || timeOut) {
            Team winner = castleDestroyed ? Team.BARBARIAN : Team.KNIGHT;
            String msg = (winner == Team.BARBARIAN ? "BARBARIANS WIN!" : "KNIGHTS WIN!") + " Castle Defended: "
                    + !castleDestroyed;
            events.add(GameEvent.message("ROUND_OVER", msg));
            restartRound();
        }
    }

    // ─── Gestión de conexiones ────────────────────────────────────────────

    public void onConnect(WebSocketSession session, String playerName) {
        if (activePlayers.size() < cfg.maxPlayers) {
            admitPlayer(session, playerName);
        } else {
            // Poner en cola y notificar posición
            waitQueue.offer(new QueueEntry(session, playerName));
            sendQueueUpdate(session);
            log.info("Player '{}' en cola. Posición {}", playerName, waitQueue.size());
        }
    }

    public void onDisconnect(String sessionId) {
        Player p = sessionToPlayer.remove(sessionId);
        if (p != null) {
            activePlayers.remove(p.id);
            broadcastEvent(GameEvent.playerLeft(p.id, p.name));
            log.info("Player '{}' desconectado. Activos: {}", p.name, activePlayers.size());
            promoteFromQueue();
        } else {
            // Remover de la cola si estaba esperando
            waitQueue.removeIf(q -> q.session.getId().equals(sessionId));
            broadcastQueueUpdates();
        }
    }

    public void onInput(String sessionId, InputFrame input) {
        Player p = sessionToPlayer.get(sessionId);
        if (p != null)
            p.lastInput = input;
    }

    // ─── Tick principal (llamado por GameLoop) ────────────────────────────

    public void tick(double dt) {
        tickCount++;
        long now = System.currentTimeMillis();

        maintainTeamBalance();

        for (NpcBot bot : bots) {
            InputFrame botInput = bot.buildInput(now, activePlayers.values(), destructibles);
            if (botInput != null)
                bot.player.lastInput = botInput;
        }

        for (Player p : activePlayers.values()) {
            if (!p.alive && now >= p.respawnAt)
                p.spawnAtRandom();
            if (p.alive)
                p.applyInput(p.lastInput, dt);
            if (p.carriedWindupCharge > 0f && p.swingPhase != SwingPhase.WINDUP) {
                p.carriedWindupCharge = Math.max(0f, p.carriedWindupCharge - (cfg.feintMomentumDecayPerSecond * (float) dt));
            }
        }

        physics.resolveCollisions(activePlayers.values());
        physics.resolveWorldCollisions(activePlayers.values(), destructibles);
        List<GameEvent> events = processCombat(now);
        checkRoundEnd(now, events);

        WorldSnapshot snap = buildSnapshot();
        broadcastSnapshot(snap);
        for (GameEvent ev : events)
            broadcastEvent(ev);
    }

    // ─── Máquina de estados de combate ───────────────────────────────────

    private List<GameEvent> processCombat(long now) {
        List<GameEvent> events = new ArrayList<>();

        for (Player attacker : activePlayers.values()) {
            if (!attacker.alive)
                continue;
            InputFrame inp = attacker.lastInput;

            // Transiciones por tiempo de fase
            advanceSwingPhase(attacker, now);

            if (inp == null)
                continue;

            // Inicio de ataque: pulsación instantánea o hold sostenido.
            // attackHeld evita perder intentos durante RECOVERY: al volver a IDLE, comienza WINDUP.
            boolean canAttack = attacker.swingPhase == SwingPhase.IDLE;
            if ((inp.attackStart || inp.attackHeld) && canAttack) {
                float initialCharge = Math.max(0f, Math.min(cfg.chargeWeakThreshold - 0.01f, attacker.carriedWindupCharge));
                attacker.swingPhase = SwingPhase.WINDUP;
                attacker.swingDir = inp.swingDir;
                attacker.swingPhaseEnd = 0L;
                attacker.windupStartedAt = now - (long) (initialCharge * cfg.windupMs);
                attacker.swingCharge = initialCharge;
                attacker.swingPowerTier = tierFromCharge(initialCharge);
                attacker.releaseDamageMultiplier = cfg.fullSwingDamageMultiplier;
                attacker.blocking = false; // Atacar cancela el bloqueo
                attacker.hitIdsThisRelease.clear(); // Limpiar hits del swing anterior
                attacker.carriedWindupCharge = 0f; // Se consume al iniciar un nuevo hold
            }

            if (attacker.swingPhase == SwingPhase.WINDUP) {
                attacker.swingCharge = computeCharge(now, attacker.windupStartedAt);
                attacker.swingPowerTier = tierFromCharge(attacker.swingCharge);
            }

            // Soltar el botón durante WINDUP ejecuta el golpe de inmediato
            if (inp.attackRelease && attacker.swingPhase == SwingPhase.WINDUP) {
                float charge = computeCharge(now, attacker.windupStartedAt);
                attacker.swingCharge = charge;
                attacker.swingPowerTier = tierFromCharge(charge);

                if (charge <= cfg.chargeCancelThreshold) {
                    attacker.swingPhase = SwingPhase.IDLE;
                    attacker.swingPhaseEnd = 0L;
                    attacker.windupStartedAt = 0L;
                    attacker.carriedWindupCharge = 0f;
                    attacker.releaseDamageMultiplier = cfg.fullSwingDamageMultiplier;
                    events.add(GameEvent.feint(attacker.id));
                } else {
                    attacker.swingPhase = SwingPhase.RELEASE;
                    attacker.swingPhaseEnd = now + cfg.releaseMs;
                    attacker.hitIdsThisRelease.clear();
                    attacker.windupStartedAt = 0L;
                    attacker.releaseDamageMultiplier = "FULL".equals(attacker.swingPowerTier)
                            ? cfg.fullSwingDamageMultiplier
                            : cfg.weakSwingDamageMultiplier;
                }
            }

            // Inicio de bloqueo (Click derecho)
            if (inp.blockDown && !attacker.blocking) {
                attacker.blocking = true;
                attacker.blockDir = inp.swingDir;

                // Si estaba en WINDUP, cancelar ataque (Feint)
                if (attacker.swingPhase == SwingPhase.WINDUP) {
                    float charge = computeCharge(now, attacker.windupStartedAt);
                    if (charge > cfg.chargeCancelThreshold && charge < cfg.chargeWeakThreshold) {
                        attacker.carriedWindupCharge = charge;
                    } else {
                        attacker.carriedWindupCharge = 0f;
                    }
                    attacker.swingPhase = SwingPhase.IDLE;
                    attacker.swingPhaseEnd = 0;
                    attacker.windupStartedAt = 0L;
                    attacker.swingCharge = 0.0f;
                    attacker.swingPowerTier = "CANCEL";
                    attacker.releaseDamageMultiplier = cfg.fullSwingDamageMultiplier;
                }
            }

            // Fin de bloqueo
            if (inp.blockUp && attacker.blocking) {
                attacker.blocking = false;
            }

            // Actualizar dirección de swing mientras se carga (el jugador apunta con el
            // mouse)
            if (attacker.swingPhase == SwingPhase.WINDUP) {
                if (attacker.swingDir != inp.swingDir) {
                    // Si cambia la dirección durante la carga, reiniciar la carga para evitar
                    // "full instantáneo" en la nueva dirección.
                    attacker.windupStartedAt = now;
                    attacker.swingCharge = 0.0f;
                    attacker.swingPowerTier = "CANCEL";
                }
                attacker.swingDir = inp.swingDir;
            }

            // Actualizar dirección de bloqueo continuamente mientras bloquea
            if (attacker.blocking) {
                attacker.blockDir = inp.swingDir;
            }

            // Detectar hits durante RELEASE
            if (attacker.swingPhase == SwingPhase.RELEASE) {
                // 1. Hits sobre destructibles (Cualquiera daña la base enemiga)
                for (Destructible d : destructibles) {
                    if (d.alive() && d.team != attacker.team && physics.detectDestructibleHit(attacker, d)) {
                        if (!attacker.hitIdsThisRelease.contains(d.id)) {
                            d.health -= calculateDamage(attacker, new HitResult(true, HitZone.TORSO, 1.0f));
                            attacker.hitIdsThisRelease.add(d.id);
                        }
                    }
                }

                // 2. Hits sobre otros jugadores
                for (Player defender : activePlayers.values()) {
                    if (defender.id.equals(attacker.id) || !defender.alive)
                        continue;
                    if (defender.team == attacker.team)
                        continue; // No fuego amigo
                    if (attacker.hitIdsThisRelease.contains(defender.id))
                        continue;

                    HitResult hr = physics.detectHit(attacker, defender);
                    if (!hr.hit())
                        continue;

                    // Bloqueo o Choque de espadas
                    if (hr.zone() == HitZone.SWORD) {
                        attacker.swingPhase = SwingPhase.BLOCKED;
                        attacker.swingPhaseEnd = now + cfg.blockedMs;

                        // Si el rival también está en medio de un golpe, interrumpirlo
                        if (defender.swingPhase == SwingPhase.RELEASE || defender.swingPhase == SwingPhase.WINDUP) {
                            defender.swingPhase = SwingPhase.BLOCKED;
                            defender.swingPhaseEnd = now + cfg.blockedMs;
                        }

                        GameEvent be = GameEvent.blockSuccess(defender.id, attacker.id);
                        be.message = defender.name + " blocked " + attacker.name;
                        events.add(be);

                        log.debug("CLASH: {} y {} chocaron espadas ({})",
                                defender.name, attacker.name, attacker.swingDir);
                        break;
                    } else {
                        // Impacto en el cuerpo
                        attacker.hitIdsThisRelease.add(defender.id);
                        int dmg = calculateDamage(attacker, hr);
                        defender.health -= dmg;
                        events.add(GameEvent.playerHit(attacker.id, defender.id, dmg, hr.zone()));
                        log.debug("HIT: {} → {} | {} dmg | zona {} | hp restante: {}/{}",
                                attacker.name, defender.name, dmg, hr.zone(), defender.health, defender.maxHealth);

                        if (defender.health <= 0) {
                            defender.alive = false;
                            defender.health = 0;
                            defender.respawnAt = now + cfg.respawnDelayMs;
                            attacker.kills.incrementAndGet();
                            defender.deaths.incrementAndGet();
                            events.add(GameEvent.playerKilled(attacker.id, defender.id));
                            log.debug("KILL: {} eliminó a {}", attacker.name, defender.name);
                        }
                    }
                }
            }

            if (attacker.swingPhase == SwingPhase.IDLE) {
                attacker.swingCharge = 0.0f;
                attacker.swingPowerTier = "CANCEL";
                attacker.releaseDamageMultiplier = cfg.fullSwingDamageMultiplier;
            }
        }

        return events;
    }

    private void advanceSwingPhase(Player p, long now) {
        // WINDUP no expira por tiempo: el golpe solo sale al soltar (attackRelease).
        if (p.swingPhase == SwingPhase.WINDUP)
            return;
        if (now < p.swingPhaseEnd)
            return;
        switch (p.swingPhase) {
            case RELEASE -> {
                p.swingPhase = SwingPhase.RECOVERY;
                p.swingPhaseEnd = now + cfg.recoveryMs;
            }
            case RECOVERY -> {
                p.swingPhase = SwingPhase.IDLE;
                p.swingPhaseEnd = 0;
                p.swingCharge = 0.0f;
                p.swingPowerTier = "CANCEL";
                p.releaseDamageMultiplier = cfg.fullSwingDamageMultiplier;
            }
            case BLOCKED -> {
                p.swingPhase = SwingPhase.IDLE;
                p.swingPhaseEnd = 0;
                p.swingCharge = 0.0f;
                p.swingPowerTier = "CANCEL";
                p.releaseDamageMultiplier = cfg.fullSwingDamageMultiplier;
            }
            default -> {
            }
        }
    }

    private int calculateDamage(Player attacker, HitResult hr) {
        float chargedDamage = 25f * attacker.releaseDamageMultiplier;
        return Math.max(1, Math.round(chargedDamage));
    }

    private long phaseTotalMs(Player p) {
        return switch (p.swingPhase) {
            case RELEASE -> cfg.releaseMs;
            case RECOVERY -> cfg.recoveryMs;
            case BLOCKED -> cfg.blockedMs;
            default -> 0L;
        };
    }

    private long phaseRemainingMs(Player p, long now) {
        long total = phaseTotalMs(p);
        if (total <= 0L) return 0L;
        return Math.max(0L, p.swingPhaseEnd - now);
    }

    private float computeCharge(long now, long windupStartedAt) {
        if (windupStartedAt <= 0L || cfg.windupMs <= 0) return 0.0f;
        float ratio = (float) (now - windupStartedAt) / (float) cfg.windupMs;
        return Math.max(0.0f, Math.min(1.0f, ratio));
    }

    private String tierFromCharge(float charge) {
        if (charge <= cfg.chargeCancelThreshold) return "CANCEL";
        if (charge < cfg.chargeWeakThreshold) return "WEAK";
        return "FULL";
    }

    // ─── Snapshot y broadcast ─────────────────────────────────────────────

    private WorldSnapshot buildSnapshot() {
        WorldSnapshot snap = new WorldSnapshot();
        snap.tick = tickCount;
        snap.serverTime = System.currentTimeMillis();
        snap.roundTimeLeft = Math.max(0, roundEndTime - snap.serverTime);

        long now = snap.serverTime;
        snap.players = activePlayers.values().stream().map(p -> {
            WorldSnapshot.PlayerState ps = new WorldSnapshot.PlayerState();
            ps.id = p.id;
            ps.name = p.name;
            ps.x = p.x;
            ps.y = p.y;
            ps.z = p.z;
            ps.yaw = p.yaw;
            ps.pitch = p.pitch;
            ps.health = p.health;
            ps.maxHealth = p.maxHealth;
            ps.swingPhase = p.swingPhase.name();
            ps.swingDir = p.swingDir.name();
            ps.swingCharge = p.swingCharge;
            ps.swingPowerTier = p.swingPowerTier;
            ps.phaseRemainingMs = phaseRemainingMs(p, now);
            ps.phaseTotalMs = phaseTotalMs(p);
            ps.blocking = p.blocking;
            ps.blockDir = p.blockDir.name();
            ps.momentum = p.stamina;
            ps.kills = p.kills.get();
            ps.deaths = p.deaths.get();
            ps.team = p.team.name();
            return ps;
        }).collect(Collectors.toList());

        snap.worldObjects = destructibles.stream().map(d -> {
            WorldSnapshot.DestructibleState ds = new WorldSnapshot.DestructibleState();
            ds.id = d.id;
            ds.type = d.type.name();
            ds.x = d.x;
            ds.z = d.z;
            ds.width = d.width;
            ds.depth = d.depth;
            ds.health = d.health;
            ds.maxHealth = d.maxHealth;
            return ds;
        }).collect(Collectors.toList());

        return snap;
    }

    private void broadcastSnapshot(WorldSnapshot snap) {
        String json = toJson(snap);
        if (json == null)
            return;
        TextMessage msg = new TextMessage(json);
        for (Player p : activePlayers.values()) {
            if (p.session != null)
                sendSafe(p.session, msg);
        }
    }

    private void broadcastEvent(GameEvent ev) {
        String json = toJson(ev);
        if (json == null)
            return;
        TextMessage msg = new TextMessage(json);
        for (Player p : activePlayers.values()) {
            if (p.session != null)
                sendSafe(p.session, msg);
        }
    }

    // ─── Cola de espera ───────────────────────────────────────────────────

    private void admitPlayer(WebSocketSession session, String playerName) {
        Player p = new Player(session, playerName, cfg);

        // Asignación aleatoria de equipo
        p.team = Math.random() > 0.5 ? Team.BARBARIAN : Team.KNIGHT;
        p.spawnAtRandom();

        activePlayers.put(p.id, p);
        sessionToPlayer.put(session.getId(), p);

        // Enviar WELCOME al jugador
        Map<String, Object> welcome = new LinkedHashMap<>();
        welcome.put("type", "WELCOME");
        welcome.put("playerId", p.id);
        welcome.put("team", p.team.name());
        welcome.put("worldWidth", cfg.worldWidth);
        welcome.put("worldDepth", cfg.worldDepth);
        String json = toJson(welcome);
        if (json != null)
            sendSafe(session, new TextMessage(json));

        broadcastEvent(GameEvent.playerJoined(p.id, p.name));
        log.info("Player '{}' ({}) admitido en equipo {}. Activos: {}", p.name, p.id, p.team, activePlayers.size());
    }

    private void promoteFromQueue() {
        QueueEntry next = waitQueue.poll();
        if (next == null)
            return;
        if (!next.session.isOpen()) {
            promoteFromQueue(); // saltar sesiones cerradas
            return;
        }
        admitPlayer(next.session, next.playerName);
        broadcastQueueUpdates();
    }

    private void sendQueueUpdate(WebSocketSession session) {
        int pos = 1;
        int total = waitQueue.size();
        for (QueueEntry q : waitQueue) {
            if (q.session.getId().equals(session.getId()))
                break;
            pos++;
        }
        Map<String, Object> msg = new LinkedHashMap<>();
        msg.put("type", "QUEUE_UPDATE");
        msg.put("position", pos);
        msg.put("total", total);
        String json = toJson(msg);
        if (json != null)
            sendSafe(session, new TextMessage(json));
    }

    private void broadcastQueueUpdates() {
        waitQueue.forEach(q -> {
            if (q.session.isOpen())
                sendQueueUpdate(q.session);
        });
    }

    // ─── Utilidades ───────────────────────────────────────────────────────

    private void sendSafe(WebSocketSession session, TextMessage msg) {
        if (!session.isOpen())
            return;
        try {
            synchronized (session) {
                session.sendMessage(msg);
            }
        } catch (IOException e) {
            log.warn("Error enviando mensaje a {}: {}", session.getId(), e.getMessage());
        }
    }

    private String toJson(Object obj) {
        try {
            return mapper.writeValueAsString(obj);
        } catch (Exception e) {
            log.error("Error serializando JSON", e);
            return null;
        }
    }

    public int getActiveCount() {
        return activePlayers.size();
    }

    public int getQueueSize() {
        return waitQueue.size();
    }

    private record QueueEntry(WebSocketSession session, String playerName) {
    }
}
