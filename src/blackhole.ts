import { findObjectAtPosition, Position } from './coords.js';
import { GRID_HEIGHT, GRID_WIDTH } from './settings.js';
import { blackholes } from './game.js';
import { getRandom } from './util/random.js';


export class Blackhole {
    position: Position;

    constructor(v: number, h: number) {
        this.position = { v, h };
    }

    static generate(): Blackhole[] {
        const count = 5 + Math.floor(getRandom() * 6); // 5–10
        let attempts = 0;

        while (blackholes.length < count && attempts < 1000) {
            const v = Math.floor(getRandom() * GRID_HEIGHT) + 1;
            const h = Math.floor(getRandom() * GRID_WIDTH) + 1;

            if (!findObjectAtPosition(v, h)) {
                blackholes.push(new Blackhole(v, h));
            }

            attempts++;
        }
        return blackholes;
    }
}

// export function checkForBlackHoles(): void {
//     for (const player of players) {
//         const ship = player.ship;
//         const { x, y } = ship.position;

//         // if that ship happens to be on a black‑hole sector…
//         if (blackHoles.some(bh => bh.x === x && bh.y === y)) {
//             sendMessageToClient(player,
//                 "You have fallen into a black hole. Your ship is crushed and annihilated.");
//             addNewsItem(`${ship.name} lost to a black hole at ${y}-${x}`);
//             putPlayerInLimbo(player, true);
//         }
//     }
// }

