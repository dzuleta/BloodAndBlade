package com.bloodblade.game;

import com.bloodblade.game.model.GameConfig;
import com.bloodblade.game.physics.PhysicsWorld;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.WebSocketSession;

import com.bloodblade.game.model.InputFrame;

import java.util.concurrent.*;

/**
 * Hilo dedicado al tick del juego a la tasa configurada (por defecto 20 Hz = 50 ms/tick).
 * Es el único lugar donde se modifica el estado del GameRoom.
 */
@Component
public class GameLoop {

    private static final Logger log = LoggerFactory.getLogger(GameLoop.class);

    private final GameConfig cfg;
    private final GameRoom room;

    private ScheduledExecutorService executor;
    private long lastTick;
    private long tickCount = 0;

    public GameLoop(GameConfig cfg, PhysicsWorld physics, ObjectMapper mapper) {
        this.cfg = cfg;
        this.room = new GameRoom(cfg, physics, mapper);
    }

    @PostConstruct
    public void start() {
        long periodMs = 1000L / cfg.tickRateHz;
        executor = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "game-loop");
            t.setDaemon(true);
            return t;
        });
        lastTick = System.currentTimeMillis();
        executor.scheduleAtFixedRate(this::tick, periodMs, periodMs, TimeUnit.MILLISECONDS);
        log.info("GameLoop iniciado a {} Hz ({} ms/tick)", cfg.tickRateHz, periodMs);
    }

    @PreDestroy
    public void stop() {
        if (executor != null) executor.shutdownNow();
    }

    private void tick() {
        try {
            long now = System.currentTimeMillis();
            double dt = (now - lastTick) / 1000.0;
            lastTick = now;

            room.tick(dt);
            tickCount++;

            if (tickCount % (cfg.tickRateHz * 10L) == 0) {
                log.debug("Tick #{} — jugadores: {} / cola: {}", tickCount, room.getActiveCount(), room.getQueueSize());
            }
        } catch (Exception e) {
            log.error("Error en tick del GameLoop", e);
        }
    }

    // ─── API para el WebSocket handler ────────────────────────────────────

    public void playerConnected(WebSocketSession session, String playerName) {
        // Ejecutar en el thread del loop para evitar race conditions
        executor.execute(() -> room.onConnect(session, playerName));
    }

    public void playerDisconnected(String sessionId) {
        executor.execute(() -> room.onDisconnect(sessionId));
    }

    public void receiveInput(String sessionId, InputFrame input) {
        // Solo almacenamos el último input; el loop lo consume en el siguiente tick
        executor.execute(() -> room.onInput(sessionId, input));
    }
}
