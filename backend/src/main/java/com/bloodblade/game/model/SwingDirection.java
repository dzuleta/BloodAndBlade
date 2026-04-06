package com.bloodblade.game.model;

public enum SwingDirection {
    UP, DOWN, LEFT, RIGHT;

    /** Devuelve true si la dirección de bloqueo cubre el ataque entrante */
    public boolean covers(SwingDirection attack) {
        if (this == UP || this == DOWN) return this == attack;
        if (this == LEFT) return attack == RIGHT;
        if (this == RIGHT) return attack == LEFT;
        return false;
    }

    /** Devuelve la dirección necesaria para bloquear este ataque */
    public SwingDirection getOpposite() {
        if (this == LEFT) return RIGHT;
        if (this == RIGHT) return LEFT;
        return this; // UP/DOWN son iguales
    }
}
