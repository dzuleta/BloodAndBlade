package com.bloodblade.game.physics;

import com.bloodblade.game.model.GameConfig;
import com.bloodblade.game.model.HitZone;
import com.bloodblade.game.model.Player;
import org.springframework.stereotype.Component;

import java.util.Collection;

/**
 * Física simplificada para el juego:
 * - Cápsulas verticales (radio + altura) para jugadores
 * - Detección de impacto: distancia + arco frontal (no usa la pose 3D del cliente)
 * - Zonas de daño: cabeza / torso / piernas según dirección del swing ({@link com.bloodblade.game.model.SwingDirection})
 */
@Component
public class PhysicsWorld {

    private final double hitReach;

    public PhysicsWorld(GameConfig cfg) {
        this.hitReach = cfg.hitReach;
    }

    /**
     * Resuelve solapamientos entre todas las cápsulas de jugadores (empuje lateral).
     */
    public void resolveCollisions(Collection<Player> players) {
        Player[] arr = players.toArray(new Player[0]);
        for (int i = 0; i < arr.length; i++) {
            for (int j = i + 1; j < arr.length; j++) {
                resolvePair(arr[i], arr[j]);
            }
        }
    }

    private void resolvePair(Player a, Player b) {
        double dx = b.x - a.x;
        double dz = b.z - a.z;
        double distSq = dx * dx + dz * dz;
        double minDist = 0.7; // radio a + radio b
        if (distSq < minDist * minDist && distSq > 0.0001) {
            double dist = Math.sqrt(distSq);
            double overlap = (minDist - dist) / 2.0;
            double nx = dx / dist;
            double nz = dz / dist;
            a.x -= nx * overlap;
            a.z -= nz * overlap;
            b.x += nx * overlap;
            b.z += nz * overlap;
        }
    }

    /**
     * Detecta si el swing del atacante impacta al defensor.
     *
     * Convención de coordenadas del juego:
     *   adelante = (sin(yaw), -cos(yaw))  en (X, Z)
     *   derecha   = (cos(yaw),  sin(yaw))  en (X, Z)
     *
     * El defensor debe estar dentro de {@code hitReach} y en el semiplano frontal
     * del atacante (producto escalar con el vector "adelante" >= 0).
     */
    public HitResult detectHit(Player attacker, Player defender) {
        if (!attacker.alive || !defender.alive) return new HitResult(false, null, 0);

        double dx   = defender.x - attacker.x;
        double dz   = defender.z - attacker.z;
        double dist = Math.sqrt(dx * dx + dz * dz);

        if (dist > hitReach) return new HitResult(false, null, 0);

        // Verificar que el defensor esté en el arco frontal (no detrás)
        double sinY = Math.sin(attacker.yaw);
        double cosY = Math.cos(attacker.yaw);
        double forwardDot = dx * sinY + dz * (-cosY);
        if (forwardDot < 0) return new HitResult(false, null, 0);

        // Zona de impacto según dirección del swing
        HitZone zone = switch (attacker.swingDir) {
            case UP   -> HitZone.HEAD;
            case DOWN -> HitZone.LEGS;
            default   -> HitZone.TORSO;
        };

        return new HitResult(true, zone, attacker.momentum);
    }
}
