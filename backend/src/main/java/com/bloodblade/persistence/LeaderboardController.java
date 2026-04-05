package com.bloodblade.persistence;

import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/api/leaderboard")
@CrossOrigin(origins = "*")
public class LeaderboardController {

    private final PlayerStatsMapper statsMapper;

    public LeaderboardController(PlayerStatsMapper statsMapper) {
        this.statsMapper = statsMapper;
    }

    @GetMapping
    public List<PlayerStatsMapper.LeaderboardEntry> getTop(
        @RequestParam(defaultValue = "20") int limit
    ) {
        return statsMapper.getTopPlayers(Math.min(limit, 100));
    }
}
