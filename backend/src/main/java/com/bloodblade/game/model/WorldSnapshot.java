package com.bloodblade.game.model;

import java.util.List;

/** Serializado a JSON y enviado a todos los clientes en cada tick */
public class WorldSnapshot {
    public final String type = "SNAPSHOT";
    public long tick;
    public long serverTime;
    public List<PlayerState> players;

    public static class PlayerState {
        public String id;
        public String name;
        public double x, y, z;
        public double yaw, pitch;
        public int health;
        public int maxHealth;
        public String swingPhase;
        public String swingDir;
        public boolean blocking;
        public String blockDir;
        public float momentum;
        public int kills;
        public int deaths;
    }
}
