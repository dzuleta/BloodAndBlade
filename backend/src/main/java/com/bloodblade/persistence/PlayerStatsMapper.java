package com.bloodblade.persistence;

import org.apache.ibatis.annotations.*;

import java.util.List;
import java.util.UUID;

@Mapper
public interface PlayerStatsMapper {

    @Insert("""
        INSERT INTO player_account (id, name)
        VALUES (#{id}, #{name})
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name
        """)
    void upsertAccount(@Param("id") UUID id, @Param("name") String name);

    @Insert("""
        INSERT INTO player_stats (player_id, kills_total, deaths_total)
        VALUES (#{playerId}, 0, 0)
        ON CONFLICT (player_id) DO NOTHING
        """)
    void initStats(@Param("playerId") UUID playerId);

    @Update("""
        UPDATE player_stats
        SET kills_total  = kills_total  + #{kills},
            deaths_total = deaths_total + #{deaths},
            updated_at   = now()
        WHERE player_id = #{playerId}
        """)
    void addStats(
        @Param("playerId") UUID playerId,
        @Param("kills") int kills,
        @Param("deaths") int deaths
    );

    @Select("""
        SELECT a.name, s.kills_total AS kills, s.deaths_total AS deaths
        FROM player_stats s
        JOIN player_account a ON a.id = s.player_id
        ORDER BY s.kills_total DESC
        LIMIT #{limit}
        """)
    List<LeaderboardEntry> getTopPlayers(@Param("limit") int limit);

    record LeaderboardEntry(String name, int kills, int deaths) {}
}
