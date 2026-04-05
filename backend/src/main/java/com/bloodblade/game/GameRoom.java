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

    private long tickCount = 0;

    public GameRoom(GameConfig cfg, PhysicsWorld physics, ObjectMapper mapper) {
        this.cfg = cfg;
        this.physics = physics;
        this.mapper = mapper;
        spawnBots(1);
    }

    /** Crea N bots y los añade directamente al mundo. */
    private void spawnBots(int count) {
        for (int i = 0; i < count; i++) {
            NpcBot bot = new NpcBot(cfg, "[Bot] Caballero " + (i + 1));
            activePlayers.put(bot.player.id, bot.player);
            bots.add(bot);
            log.info("Bot '{}' ({}) añadido al mundo.", bot.player.name, bot.player.id);
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
        if (p != null) p.lastInput = input;
    }

    // ─── Tick principal (llamado por GameLoop) ────────────────────────────

    public void tick(double dt) {
        tickCount++;
        long now = System.currentTimeMillis();

        // 0. Actualizar IA de bots (genera lastInput antes de applyInput)
        for (NpcBot bot : bots) {
            InputFrame botInput = bot.buildInput(now, activePlayers.values());
            if (botInput != null) bot.player.lastInput = botInput;
        }

        // 1. Aplicar inputs y mover jugadores
        for (Player p : activePlayers.values()) {
            if (!p.alive && now >= p.respawnAt) {
                p.spawnAtRandom();
            }
            if (p.alive) {
                p.applyInput(p.lastInput, dt);
            }
        }

        // 2. Resolver colisiones entre cápsulas
        physics.resolveCollisions(activePlayers.values());

        // 3. Avanzar máquina de estados de combate y detectar hits
        List<GameEvent> events = processCombat(now);

        // 4. Construir y difundir snapshot
        WorldSnapshot snap = buildSnapshot();
        broadcastSnapshot(snap);

        // 5. Difundir eventos discretos
        for (GameEvent ev : events) broadcastEvent(ev);
    }

    // ─── Máquina de estados de combate ───────────────────────────────────

    private List<GameEvent> processCombat(long now) {
        List<GameEvent> events = new ArrayList<>();

        for (Player attacker : activePlayers.values()) {
            if (!attacker.alive) continue;
            InputFrame inp = attacker.lastInput;

            // Transiciones por tiempo de fase
            advanceSwingPhase(attacker, now);

            if (inp == null) continue;

            // Inicio de ataque: WINDUP mientras se mantiene el botón; sin daño hasta RELEASE
            if (inp.attackStart && attacker.swingPhase == SwingPhase.IDLE) {
                attacker.swingPhase = SwingPhase.WINDUP;
                attacker.swingDir = inp.swingDir;
                attacker.swingPhaseEnd = 0L; // no hay timeout: solo attackRelease pasa a RELEASE
                attacker.momentum = Math.min(1f, attacker.momentum + 0.4f);
            }

            // Soltar el botón durante WINDUP ejecuta el golpe de inmediato
            if (inp.attackRelease && attacker.swingPhase == SwingPhase.WINDUP) {
                attacker.swingPhase = SwingPhase.RELEASE;
                attacker.swingPhaseEnd = now + cfg.releaseMs;
                attacker.hitIdsThisRelease.clear();
            }

            // Liberar ataque: WINDUP → RELEASE
            if (inp.attackRelease && attacker.swingPhase == SwingPhase.IDLE) {
                // re-swing directo si tiene momentum suficiente
            }

            // Inicio de bloqueo
            if (inp.blockDown && !attacker.blocking) {
                attacker.blocking = true;
                attacker.blockDir = inp.swingDir;
            }

            // Fin de bloqueo + posible redirección con bajo loss de momentum
            if (inp.blockUp && attacker.blocking) {
                attacker.blocking = false;
                if (attacker.swingPhase == SwingPhase.WINDUP) {
                    attacker.swingDir = inp.swingDir;
                    attacker.momentum = Math.max(0, attacker.momentum - cfg.blockRedirectMomentumLoss);
                }
            }

            // Actualizar dirección de swing mientras se carga (el jugador apunta con el mouse)
            if (attacker.swingPhase == SwingPhase.WINDUP) {
                attacker.swingDir = inp.swingDir;
            }

            // Actualizar dirección de bloqueo continuamente mientras bloquea
            if (attacker.blocking) {
                attacker.blockDir = inp.swingDir;
            }

            // Detectar hits durante RELEASE (el tajo sigue hasta fin de release; puede cortar a varios rivales)
            if (attacker.swingPhase == SwingPhase.RELEASE) {
                for (Player defender : activePlayers.values()) {
                    if (defender.id.equals(attacker.id) || !defender.alive) continue;
                    if (attacker.hitIdsThisRelease.contains(defender.id)) continue;

                    HitResult hr = physics.detectHit(attacker, defender);
                    if (!hr.hit()) continue;

                    // Comprobar bloqueo: si el defensor bloquea en la dirección correcta
                    if (defender.blocking && defender.blockDir.covers(attacker.swingDir)) {
                        attacker.swingPhase = SwingPhase.BLOCKED;
                        attacker.swingPhaseEnd = now + cfg.blockedMs;
                        attacker.momentum = 0;
                        events.add(GameEvent.blockSuccess(defender.id, attacker.id));
                        log.debug("BLOQUEADO: {} bloqueó el swing {} de {}",
                                defender.name, attacker.swingDir, attacker.name);
                        break;
                    } else {
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

            // Decaimiento de momentum cuando está en IDLE
            if (attacker.swingPhase == SwingPhase.IDLE) {
                attacker.momentum = Math.max(0, attacker.momentum - 0.015f);
            }
        }

        return events;
    }

    private void advanceSwingPhase(Player p, long now) {
        // WINDUP no expira por tiempo: el golpe solo sale al soltar (attackRelease).
        if (p.swingPhase == SwingPhase.WINDUP) return;
        if (now < p.swingPhaseEnd) return;
        switch (p.swingPhase) {
            case RELEASE  -> { p.swingPhase = SwingPhase.RECOVERY; p.swingPhaseEnd = now + cfg.recoveryMs; }
            case RECOVERY -> { p.swingPhase = SwingPhase.IDLE;     p.swingPhaseEnd = 0; }
            case BLOCKED  -> { p.swingPhase = SwingPhase.IDLE;     p.swingPhaseEnd = 0; }
            default -> {}
        }
    }

    private int calculateDamage(Player attacker, HitResult hr) {
        float momentumFactor = 0.6f + attacker.momentum * 0.4f;
        int raw = (int) ((cfg.baseDamage + cfg.momentumBonusDamage * attacker.momentum) * momentumFactor);
        return Math.round(raw * hr.zone().damageMultiplier);
    }

    // ─── Snapshot y broadcast ─────────────────────────────────────────────

    private WorldSnapshot buildSnapshot() {
        WorldSnapshot snap = new WorldSnapshot();
        snap.tick = tickCount;
        snap.serverTime = System.currentTimeMillis();
        snap.players = activePlayers.values().stream().map(p -> {
            WorldSnapshot.PlayerState ps = new WorldSnapshot.PlayerState();
            ps.id = p.id;
            ps.name = p.name;
            ps.x = p.x; ps.y = p.y; ps.z = p.z;
            ps.yaw = p.yaw; ps.pitch = p.pitch;
            ps.health = p.health;
            ps.maxHealth = p.maxHealth;
            ps.swingPhase = p.swingPhase.name();
            ps.swingDir = p.swingDir.name();
            ps.blocking = p.blocking;
            ps.blockDir = p.blockDir.name();
            ps.momentum = p.momentum;
            ps.kills = p.kills.get();
            ps.deaths = p.deaths.get();
            return ps;
        }).collect(Collectors.toList());
        return snap;
    }

    private void broadcastSnapshot(WorldSnapshot snap) {
        String json = toJson(snap);
        if (json == null) return;
        TextMessage msg = new TextMessage(json);
        for (Player p : activePlayers.values()) {
            if (p.session != null) sendSafe(p.session, msg);
        }
    }

    private void broadcastEvent(GameEvent ev) {
        String json = toJson(ev);
        if (json == null) return;
        TextMessage msg = new TextMessage(json);
        for (Player p : activePlayers.values()) {
            if (p.session != null) sendSafe(p.session, msg);
        }
    }

    // ─── Cola de espera ───────────────────────────────────────────────────

    private void admitPlayer(WebSocketSession session, String playerName) {
        Player p = new Player(session, playerName, cfg);
        activePlayers.put(p.id, p);
        sessionToPlayer.put(session.getId(), p);

        // Enviar WELCOME al jugador
        Map<String, Object> welcome = new LinkedHashMap<>();
        welcome.put("type", "WELCOME");
        welcome.put("playerId", p.id);
        welcome.put("worldWidth", cfg.worldWidth);
        welcome.put("worldDepth", cfg.worldDepth);
        String json = toJson(welcome);
        if (json != null) sendSafe(session, new TextMessage(json));

        broadcastEvent(GameEvent.playerJoined(p.id, p.name));
        log.info("Player '{}' ({}) admitido. Activos: {}", p.name, p.id, activePlayers.size());
    }

    private void promoteFromQueue() {
        QueueEntry next = waitQueue.poll();
        if (next == null) return;
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
            if (q.session.getId().equals(session.getId())) break;
            pos++;
        }
        Map<String, Object> msg = new LinkedHashMap<>();
        msg.put("type", "QUEUE_UPDATE");
        msg.put("position", pos);
        msg.put("total", total);
        String json = toJson(msg);
        if (json != null) sendSafe(session, new TextMessage(json));
    }

    private void broadcastQueueUpdates() {
        waitQueue.forEach(q -> {
            if (q.session.isOpen()) sendQueueUpdate(q.session);
        });
    }

    // ─── Utilidades ───────────────────────────────────────────────────────

    private void sendSafe(WebSocketSession session, TextMessage msg) {
        if (!session.isOpen()) return;
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

    public int getActiveCount() { return activePlayers.size(); }
    public int getQueueSize()   { return waitQueue.size(); }

    private record QueueEntry(WebSocketSession session, String playerName) {}
}
