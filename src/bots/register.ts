// bots/spawn.ts
import { Player } from "../player.js";
import { Ship } from "../ship.js";
import { NullSocket } from "../util/nullsocket.js";
import { players, pointsManager } from "../game.js";
import { findEmptyLocation } from "../coords.js";
import { FEDERATION_SHIPS, EMPIRE_SHIPS, type Side } from "../settings.js";
export type BotRole = "aggressor" | "defender" | "raider" | "patrol";



export function registerBot(player: Player, role: BotRole): void {
    // attach role/state to the player or track in a Map
    // and make sure your main tick calls your bot loop
    (player as unknown as { botRole?: BotRole }).botRole = role;
}


function listTakenUppercase(): Set<string> {
    const taken = new Set<string>();
    for (const p of players) {
        const name = p.ship?.name;
        if (name) taken.add(name.toUpperCase());
    }
    return taken;
}

/**
 * Prefer a free roster name for the side.
 * If `preferred` is provided, it must be in the roster and free to be used.
 * Only synthesize a BOT-* name if the roster is fully taken.
 */
export function pickAvailableShipName(side: Side, preferred?: string): string {
    const roster = side === "FEDERATION" ? FEDERATION_SHIPS : EMPIRE_SHIPS;
    const taken = listTakenUppercase();

    // 1) Use a free roster name (PRIMARY path)
    for (const name of roster) {
        if (!taken.has(name.toUpperCase())) return name;
    }

    // 2) If roster is exhausted, allow a preferred name only if it's free and in roster (rare case)
    if (preferred) {
        const candidate = preferred.trim();
        if (
            candidate &&
            roster.some(r => r.toUpperCase() === candidate.toUpperCase()) &&
            !taken.has(candidate.toUpperCase())
        ) {
            return candidate;
        }
    }

    // 3) Last resort: synthesize a unique BOT-* name
    let i = 1;
    while (true) {
        const synth = `${side === "FEDERATION" ? "F" : "E"}-BOT-${i}`;
        if (!taken.has(synth.toUpperCase())) return synth;
        i += 1;
    }
}

export function spawnAndRegisterBot(
    role: BotRole,
    side: Side,
    preferredShipName?: string
): Player {
    const bot = new Player(new NullSocket());//, { isBot: true });

    // IMPORTANT: call pickAvailableShipName BEFORE pushing the player to `players`
    const shipName = pickAvailableShipName(side, preferredShipName);

    bot.ship = new Ship(bot);
    bot.ship.name = shipName;
    bot.ship.side = side;
    bot.ship.energy = 5000;
    bot.ship.shieldEnergy = 0;
    bot.ship.damage = 0;
    bot.ship.torpedoes = 10;

    bot.settings.name = shipName; // keep label in sync

    bot.ship.position = findEmptyLocation() ?? { v: 1, h: 1 };

    players.push(bot);

    (pointsManager as unknown as { incrementShipsCommissioned?(s: Side): void })
        .incrementShipsCommissioned?.(side);

    registerBot(bot, role);
    return bot;
}