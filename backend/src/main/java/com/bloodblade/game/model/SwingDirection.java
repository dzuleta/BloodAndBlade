package com.bloodblade.game.model;

public enum SwingDirection {
    UP, DOWN, LEFT, RIGHT;

    /** Devuelve true si la dirección de bloqueo cubre el ataque entrante */
    public boolean covers(SwingDirection attack) {
        return this == attack;
    }
}
