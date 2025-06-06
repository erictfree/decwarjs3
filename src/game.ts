import { Blackhole } from "./blackhole.js";
import { Planet } from "./planet.js";
import { Player } from "./player.js";
import { Star } from "./star.js";
import { setRandomSeed } from './util/random.js';

export let players: Player[] = [];
export let limbo: Player[] = [];
export let planets: Planet[] = [];
export const bases = {
    federation: [] as Planet[],
    empire: [] as Planet[],
};
export let stars: Star[] = [];
export let blackholes: Blackhole[] = [];
export let stardate: number = 0;

export function generateGalaxy(seed?: string): void {
    if (!seed) {
        seed = Date.now().toString();
    }
    setRandomSeed(seed);

    planets = Planet.generate();
    Planet.generateBases();
    Blackhole.generate();
    Star.generate();
    //generated = true;
    console.log(stars);
}
