package com.bloodblade.game.physics;

import com.bloodblade.game.model.HitZone;

public record HitResult(boolean hit, HitZone zone, float velocityFactor) {}
