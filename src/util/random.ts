import seedrandom from 'seedrandom';
import type { PRNG } from 'seedrandom';
//const seedrandom = require('seedrandom')
//import seedrandom from 'seedrandom';

//var seedrandom = require('seedrandom');
let rng: PRNG | null = null;

export let galaxySeed: string;

export function setRandomSeed(str: string): void {
    galaxySeed = str;
    rng = seedrandom(galaxySeed);
}

export function getRandom(): number {
    if (rng) {
        return rng();
    } else {
        return 0;
    }
}