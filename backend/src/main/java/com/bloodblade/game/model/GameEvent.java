package com.bloodblade.game.model;

/** Evento discreto enviado a todos los clientes (complementa el snapshot) */
public class GameEvent {
    public String type;       // PLAYER_HIT | PLAYER_KILLED | BLOCK_SUCCESS | FEINT | PLAYER_JOINED | PLAYER_LEFT
    public String attackerId;
    public String victimId;
    public Integer damage;
    public String zone;       // HEAD | TORSO | LEGS
    public String message;

    private GameEvent() {}

    public static GameEvent playerKilled(String killerId, String victimId) {
        GameEvent e = new GameEvent();
        e.type = "PLAYER_KILLED";
        e.attackerId = killerId;
        e.victimId = victimId;
        return e;
    }

    public static GameEvent playerHit(String attackerId, String victimId, int damage, HitZone zone) {
        GameEvent e = new GameEvent();
        e.type = "PLAYER_HIT";
        e.attackerId = attackerId;
        e.victimId = victimId;
        e.damage = damage;
        e.zone = zone.name();
        return e;
    }

    /** @param blockerId jugador que bloqueó; @param blockedAttackerId atacante cuyo golpe fue rechazado */
    public static GameEvent blockSuccess(String blockerId, String blockedAttackerId) {
        GameEvent e = new GameEvent();
        e.type = "BLOCK_SUCCESS";
        e.attackerId = blockerId;
        e.victimId = blockedAttackerId;
        return e;
    }

    public static GameEvent feint(String attackerId) {
        GameEvent e = new GameEvent();
        e.type = "FEINT";
        e.attackerId = attackerId;
        return e;
    }

    public static GameEvent playerJoined(String playerId, String name) {
        GameEvent e = new GameEvent();
        e.type = "PLAYER_JOINED";
        e.attackerId = playerId;
        e.message = name + " entered the battlefield";
        return e;
    }

    public static GameEvent playerLeft(String playerId, String name) {
        GameEvent e = new GameEvent();
        e.type = "PLAYER_LEFT";
        e.attackerId = playerId;
        e.message = name + " left the battle";
        return e;
    }

    public static GameEvent message(String type, String msg) {
        GameEvent e = new GameEvent();
        e.type = type;
        e.message = msg;
        return e;
    }
}
