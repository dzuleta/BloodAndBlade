package com.bloodblade.game.model;

public enum HitZone {
    HEAD(2.0f),
    TORSO(1.0f),
    LEGS(0.6f);

    public final float damageMultiplier;

    HitZone(float damageMultiplier) {
        this.damageMultiplier = damageMultiplier;
    }
}
