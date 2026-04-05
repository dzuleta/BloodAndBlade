package com.bloodblade.game.model;

public enum SwingPhase {
    IDLE,
    WINDUP,    // cargando el golpe; se puede hacer feint aquí
    RELEASE,   // en movimiento; puede impactar
    RECOVERY,  // recuperando; vulnerable
    BLOCKED    // fue bloqueado
}
