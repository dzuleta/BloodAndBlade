package com.bloodblade.game.model;

import java.util.UUID;

public class Destructible {
    public enum Type { WALL, CASTLE }

    public final String id = UUID.randomUUID().toString();
    public final Type type;
    public final double x, z, width, depth;
    public int health;
    public final int maxHealth;

    public Destructible(Type type, double x, double z, double w, double d, int maxHealth) {
        this.type = type;
        this.x = x;
        this.z = z;
        this.width = w;
        this.depth = d;
        this.health = maxHealth;
        this.maxHealth = maxHealth;
    }

    public boolean alive() { return health > 0; }
}
