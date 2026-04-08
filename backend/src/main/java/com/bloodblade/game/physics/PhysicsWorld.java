package com.bloodblade.game.physics;

import com.bloodblade.game.model.GameConfig;
import com.bloodblade.game.model.HitZone;
import com.bloodblade.game.model.Player;
import com.bloodblade.game.model.SwingDirection;
import com.bloodblade.game.model.SwingPhase;
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
     * Resuelve colisiones entre jugadores y objetos destructibles (Muros/Castillos).
     */
    public void resolveWorldCollisions(Collection<Player> players, Collection<com.bloodblade.game.model.Destructible> world) {
        for (Player p : players) {
            if (!p.alive) continue;
            for (com.bloodblade.game.model.Destructible d : world) {
                if (!d.alive()) continue;
                
                // AABB simplificado para el objeto destructible
                double hw = d.width / 2.0;
                double hd = d.depth / 2.0;
                
                // Encontrar el punto más cercano en el rectángulo al jugador
                double closestX = Math.max(d.x - hw, Math.min(p.x, d.x + hw));
                double closestZ = Math.max(d.z - hd, Math.min(p.z, d.z + hd));
                
                double dx = p.x - closestX;
                double dz = p.z - closestZ;
                double distSq = dx * dx + dz * dz;
                double r = 0.45;
                
                // Si el centro del jugador está DENTRO del objeto (dx=0, dz=0)
                if (distSq < 0.0001) {
                    // Puntos de empuje según el lado más cercano
                    double pX = p.x - d.x;
                    double pZ = p.z - d.z;
                    if (Math.abs(pX/hw) > Math.abs(pZ/hd)) {
                        p.x = d.x + Math.signum(pX) * (hw + r);
                    } else {
                        p.z = d.z + Math.signum(pZ) * (hd + r);
                    }
                    continue;
                }

                if (distSq < r * r) {
                    double dist = Math.sqrt(distSq);
                    double overlap = r - dist;
                    p.x += (dx / dist) * overlap;
                    p.z += (dz / dist) * overlap;
                }
            }
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

        // Detectar choque de espadas: si el defensor tiene arma activa y sus direcciones coinciden
        boolean swordOut = defender.blocking || 
                           defender.swingPhase == SwingPhase.WINDUP ||
                           defender.swingPhase == SwingPhase.RELEASE;
        
        // El arma bloquea si la dirección coincide.
        // Si el defensor bloquea explícitamente se usa blockDir; si está cargado/atacando se usa swingDir.
        SwingDirection defDir = defender.blocking ? defender.blockDir : defender.swingDir;

        if (swordOut && defDir.covers(attacker.swingDir)) {
            // Verificar que estén enfrentados para un choque realista
            double dxDef = -dx;
            double dzDef = -dz;
            double sinYDef = Math.sin(defender.yaw);
            double cosYDef = Math.cos(defender.yaw);
            double defForwardDot = dxDef * sinYDef + dzDef * (-cosYDef);
            
            if (defForwardDot > 0) {
                return new HitResult(true, HitZone.SWORD, attacker.stamina);
            }
        }

        // Zona de impacto según dirección del swing para cuerpo
        HitZone zone = switch (attacker.swingDir) {
            case UP   -> HitZone.HEAD;
            case DOWN -> HitZone.LEGS;
            default   -> HitZone.TORSO;
        };

        return new HitResult(true, zone, attacker.stamina);
    }

    public boolean detectDestructibleHit(Player attacker, com.bloodblade.game.model.Destructible d) {
        if (!attacker.alive || !d.alive()) return false;

        // AABB simplificado (rectángulo x-z)
        double dx = Math.max(d.x - d.width/2.0, Math.min(attacker.x, d.x + d.width/2.0));
        double dz = Math.max(d.z - d.depth/2.0, Math.min(attacker.z, d.z + d.depth/2.0));
        
        double distX = attacker.x - dx;
        double distZ = attacker.z - dz;
        double distSq = distX * distX + distZ * distZ;

        if (distSq > hitReach * hitReach) return false;

        // Arco frontal
        double sinY = Math.sin(attacker.yaw);
        double cosY = Math.cos(attacker.yaw);
        double fwdDot = (dx - attacker.x) * sinY + (dz - attacker.z) * (-cosY);
        return fwdDot > 0;
    }
}
