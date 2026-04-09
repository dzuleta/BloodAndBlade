package com.bloodblade.game.model;

/** DTO que el cliente envía cada ~33 ms (30 Hz) */
public class InputFrame {
    public String type;
    public int seq;
    public long timestamp;

    // Movimiento (vector ya normalizado, rango [-1, 1])
    public MoveVector move = new MoveVector();
    public double yaw;
    public double pitch;

    // Combate
    public boolean attackStart;
    public boolean attackRelease;
    public boolean attackHeld;
    public boolean blockDown;
    public boolean blockUp;
    public SwingDirection swingDir = SwingDirection.RIGHT;
    public boolean jump;

    public static class MoveVector {
        public double x;
        public double z;
    }
}
