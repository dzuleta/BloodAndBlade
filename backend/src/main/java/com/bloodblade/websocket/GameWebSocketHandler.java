package com.bloodblade.websocket;

import com.bloodblade.game.GameLoop;
import com.bloodblade.game.model.InputFrame;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.*;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import java.util.concurrent.ConcurrentHashMap;

@Component
public class GameWebSocketHandler extends TextWebSocketHandler {

    private static final Logger log = LoggerFactory.getLogger(GameWebSocketHandler.class);

    private final GameLoop gameLoop;
    private final ObjectMapper mapper;

    // sessionId → playerName (para reconectar / log)
    private final ConcurrentHashMap<String, String> sessionNames = new ConcurrentHashMap<>();

    public GameWebSocketHandler(GameLoop gameLoop, ObjectMapper mapper) {
        this.gameLoop = gameLoop;
        this.mapper = mapper;
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession session) {
        log.info("Nueva conexión WS: {}", session.getId());
        // El jugador debe enviar HELLO antes de aparecer en sala
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) {
        try {
            JsonNode node = mapper.readTree(message.getPayload());
            String type = node.path("type").asText();

            switch (type) {
                case "HELLO" -> {
                    String name = node.path("playerName").asText("Anónimo");
                    // Limpiar nombre
                    name = name.substring(0, Math.min(name.length(), 20)).trim();
                    if (name.isBlank()) name = "Warrior";
                    sessionNames.put(session.getId(), name);
                    gameLoop.playerConnected(session, name);
                }
                case "INPUT" -> {
                    InputFrame inp = mapper.treeToValue(node, InputFrame.class);
                    gameLoop.receiveInput(session.getId(), inp);
                }
                case "PING" -> {
                    // Responder PONG con el mismo timestamp para medir latencia
                    long t = node.path("t").asLong();
                    session.sendMessage(new TextMessage("{\"type\":\"PONG\",\"t\":" + t + "}"));
                }
                default -> log.warn("Tipo de mensaje desconocido '{}' de {}", type, session.getId());
            }
        } catch (Exception e) {
            log.warn("Error procesando mensaje de {}: {}", session.getId(), e.getMessage());
        }
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        String name = sessionNames.remove(session.getId());
        log.info("Conexión cerrada: {} ({}) — {}", session.getId(), name, status);
        gameLoop.playerDisconnected(session.getId());
    }

    @Override
    public void handleTransportError(WebSocketSession session, Throwable exception) {
        log.warn("Error de transporte en {}: {}", session.getId(), exception.getMessage());
    }
}
