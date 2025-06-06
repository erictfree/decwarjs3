import { GRID_WIDTH, GRID_HEIGHT } from './settings.js';
import { stars } from './game.js';
import { findObjectAtPosition, Position } from './coords.js';
import { getRandom } from './util/random.js';

export class Star {
    position: Position;

    constructor(v: number, h: number) {
        this.position = { v, h };
    }

    static generate(count?: number): Star[] {
        if (typeof count !== 'number') {
            count = Math.floor(getRandom() * 21) + 40; // 40–60
        }
        let attempts = 0;

        while (stars.length < count && attempts < 1000) {
            const v = Math.floor(getRandom() * GRID_WIDTH) + 1;
            const h = Math.floor(getRandom() * GRID_HEIGHT) + 1;

            if (!findObjectAtPosition(v, h)) {
                stars.push(new Star(v, h));
            }

            attempts++;
        }
        return stars;
    }
}
