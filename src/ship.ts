import { addPendingMessage, sendMessageToClient, sendOutputMessage } from './communication.js';
import { isInBounds, Position, findEmptyLocation, chebyshev, findObjectAtPosition, ocdefCoords, isAdjacent } from './coords.js';
import { SHIPNAMES, Condition, MAX_TORPEDOES, MAX_SHIP_ENERGY, MAX_SHIELD_ENERGY } from './settings.js';
import { Player } from './player.js';
import { players, planets } from './game.js';
import { Planet } from './planet.js';
import { bases } from './game.js';
import { Side } from './settings.js';
import { ran, iran } from './util/random.js';


type DockableTarget = { position: { v: number; h: number } }; // minimal shape

function hasDockTarget(s: Ship): s is Ship & { dockTarget?: DockableTarget | null } {
    // This keeps it structural: only cares that the property exists
    return "dockTarget" in (s as object);
}

type Cooldowns = {
    phasersAvailableAt: [number, number]; // [bank1, bank2]
};

export type DeviceName =
    | "warp"
    | "impulse"
    | "torpedo"
    | "phaser"
    | "shield"
    | "computer"
    | "radio"
    | "tractor"
    | "lifeSupport";

export interface DeviceStatus {
    [deviceName: string]: number; // damage value
}

export class Ship {
    /** Internal: prevents awarding kill credit more than once per hull. */
    public __killCredited: boolean = false;
    public player: Player;
    public position: Position;
    public energy: number;
    public shieldsUp: boolean;
    public shieldEnergy: number;
    public name: string;
    public isDestroyed: boolean;
    public side: Side;
    public docked: boolean;
    public dockPlanet: Planet | null;
    public tractorPartner: Ship | null;
    public romulanStatus: {
        isRomulan: boolean;
        isRevealed: boolean;
        cloaked: boolean;
    };
    public torpedoes: number;
    public devices: {
        warp: number;
        impulse: number;
        torpedo: number;
        phaser: number;
        shield: number;
        computer: number;
        radio: number;
        tractor: number;
        lifeSupport: number;
    }
    lifeSupportFailureTimer: number | null = null;
    public condition: Condition;
    public damage: number;
    public cooldowns: Cooldowns;

    constructor(player: Player) {
        this.player = player;
        this.position = findEmptyLocation() || { v: 1, h: 1 };
        this.energy = MAX_SHIP_ENERGY;
        this.shieldsUp = true;
        this.shieldEnergy = MAX_SHIELD_ENERGY;
        this.docked = false;
        this.dockPlanet = null;
        this.name = "Unknown";
        this.isDestroyed = false;
        this.side = "NEUTRAL";
        this.tractorPartner = null;
        this.romulanStatus = {
            isRomulan: false,
            isRevealed: false,
            cloaked: false
        };
        this.torpedoes = MAX_TORPEDOES;
        this.devices = {
            warp: 0,
            impulse: 0,
            torpedo: 0,
            phaser: 0,
            shield: 0,
            computer: 0,
            radio: 0,
            tractor: 0,
            lifeSupport: 0
        };
        this.lifeSupportFailureTimer = null;
        this.condition = "GREEN";
        this.damage = 0;
        this.cooldowns = { phasersAvailableAt: [0, 0] };
    }

    raiseShields(): void {   // TODO factor in shield device damange?
        if (!this.shieldsUp && this.energy >= 100) {
            this.energy -= 100;
            this.shieldsUp = true;
            if (this.tractorPartner) {
                if (this.tractorPartner.tractorPartner) {
                    this.tractorPartner.tractorPartner = null;
                    addPendingMessage(this.tractorPartner.player, `Tractor beam was broken, ${this.name} raised shields.`);
                }
                this.tractorPartner = null;
                sendMessageToClient(this.player, `Tractor beam broken, Captain.`);
            }
            sendOutputMessage(this.player, {
                SHORT: "SH > UP",
                MEDIUM: "Shields raised.",
                LONG: "Defensive shields have been raised. Energy expenditure: 100 units."
            });

            sendOutputMessage(this.player, {
                SHORT: `SH > ${this.computeShieldStrength()}`,
                MEDIUM: `Shield strength: ${this.computeShieldStrength()}`,
                LONG: `Current shield strength is ${this.computeShieldStrength()}`
            });

        } else if (this.shieldsUp) {
            sendOutputMessage(this.player, {
                SHORT: "SH > UP ALRDY",
                MEDIUM: "Shields are already up.",
                LONG: "Shields are already raised; no action taken."
            });

        } else {
            sendOutputMessage(this.player, {
                SHORT: "SH > NO E",
                MEDIUM: "Insufficient energy to raise shields.",
                LONG: "Unable to raise shields due to inadequate ship energy reserves."
            });

        }
    }

    lowerShields(): void {
        if (this.shieldsUp) {
            this.shieldsUp = false;

            sendOutputMessage(this.player, {
                SHORT: "SH > DN",
                MEDIUM: "Shields lowered.",
                LONG: "Defensive shields have been lowered."
            });

            sendOutputMessage(this.player, {
                SHORT: `SH > ${this.computeShieldStrength()}`,
                MEDIUM: `Shield strength: ${this.computeShieldStrength()}`,
                LONG: `Current shield strength is ${this.computeShieldStrength()}`
            });

        } else {
            sendOutputMessage(this.player, {
                SHORT: "SH > DN ALRDY",
                MEDIUM: "Shields are already down.",
                LONG: "Shields are already lowered; no action taken."
            });
        }
    }

    transferToShields(amount: number): number {
        const maxShieldEnergy = MAX_SHIELD_ENERGY;
        const availableShipEnergy = Math.max(0, this.energy);
        const shieldRoom = Math.max(0, maxShieldEnergy - this.shieldEnergy);
        const requestedAmount = Math.max(0, amount);

        const transferable = Math.min(requestedAmount, availableShipEnergy, shieldRoom);

        if (transferable <= 0) {
            sendOutputMessage(this.player, {
                SHORT: "SH > MAX",
                MEDIUM: "Shields full or insufficient energy.",
                LONG: "Shield energy is already at maximum or ship lacks energy for transfer."
            });
            return 0;
        }

        this.shieldEnergy += transferable;
        this.energy -= transferable;

        sendOutputMessage(this.player, {
            SHORT: `+SH ${transferable}`,
            MEDIUM: `Transferred ${transferable} to shields.`,
            LONG: `Transferred ${transferable} units of energy from ship to shields.`
        });

        sendOutputMessage(this.player, {
            SHORT: `EN ${this.energy}`,
            MEDIUM: `Ship energy: ${this.energy}`,
            LONG: `Remaining ship energy: ${this.energy}`
        });

        sendOutputMessage(this.player, {
            SHORT: `SH ${this.shieldEnergy}`,
            MEDIUM: `Shield energy: ${this.shieldEnergy}`,
            LONG: `Current shield reserve: ${this.shieldEnergy}`
        });

        return transferable;
    }

    transferFromShields(amount: number): number {
        const maxShipEnergy = MAX_SHIP_ENERGY;
        const shipEnergy = this.energy;
        const roomInShip = maxShipEnergy - shipEnergy;

        if (isNaN(amount) || amount <= 0) {
            sendOutputMessage(this.player, {
                SHORT: `SH > BAD AMT`,
                MEDIUM: `Invalid amount: ${amount}`,
                LONG: `Invalid energy transfer amount: ${amount}. Operation cancelled.`
            });

            return 0;
        }

        if (roomInShip <= 0) {
            sendOutputMessage(this.player, {
                SHORT: "SH > SHIP FULL",
                MEDIUM: "Ship already at full energy.",
                LONG: "Cannot transfer from shields — ship's energy storage is already full."
            });
            return 0;
        }

        const transferable = Math.min(amount, this.shieldEnergy, roomInShip);

        if (transferable <= 0) {
            sendOutputMessage(this.player, {
                SHORT: "SH > NO SH",
                MEDIUM: "Not enough energy in shields.",
                LONG: "Insufficient shield energy available for transfer."
            });

            return 0;
        }

        this.shieldEnergy -= transferable;
        this.energy += transferable;

        sendOutputMessage(this.player, {
            SHORT: `-SH ${transferable}`,
            MEDIUM: `Transferred ${transferable} from shields.`,
            LONG: `Transferred ${transferable} units of energy from shields to ship.`
        });
        return transferable;
    }

    computeShieldStrength(): string {
        const percentage = (this.shieldEnergy / MAX_SHIELD_ENERGY) * 100;    //TODO SHIELD AND LEVEL?  is this correct?
        const strength = Math.max(0, Math.floor(percentage));
        return strength === 100
            ? `${strength}%`
            : `${this.shieldsUp ? '+' : '-'}${strength}%`;
    }

    computeShieldPercent(): number {
        const percent = (this.shieldEnergy / MAX_SHIELD_ENERGY) * 100;
        return this.shieldsUp ? Math.round(percent) : -Math.round(percent);
    }

    isDeviceOperational(device: keyof typeof this.devices): boolean {
        function isDeviceInoperative(ship: Ship, device: keyof typeof ship.devices): boolean {
            return ship.devices[device] >= 300;
        }

        function deviceMayFail(ship: Ship, device: keyof typeof ship.devices): boolean {
            const dmg = ship.devices[device];
            return dmg >= 300 || (dmg >= 100 && ran() < 0.25);
        }

        function deviceMalfunctionMessage(device: string): string {
            const messages: Record<string, string> = {
                warp: "ERROR: Warp drive malfunction.",
                impulse: "ERROR: Impulse engines not responding.",
                torpedo: "ERROR: Torpedo system inoperative.",
                phaser: "ERROR: Phaser banks offline.",
                shield: "ERROR: Shield generator offline.",
                computer: "ERROR: Computer too damaged to compute coordinates.",
                lifeSupport: "WARNING: Life support system failing.",
                radio: "ERROR: Radio system inoperative.",
                tractor: "Tractor beam not in operation at this time, sir.",
            };
            return messages[device] ?? `ERROR: ${device} system failure.`;
        }

        if (isDeviceInoperative(this, device)) {
            sendMessageToClient(this.player, deviceMalfunctionMessage(device));
            return false;
        }
        if (deviceMayFail(this, device)) {
            sendMessageToClient(this.player, deviceMalfunctionMessage(device));
            return false;
        }
        return true;
    }


    computeCondition(): Condition {
        // 1. RED if any enemy ship within 10-man distance
        for (const other of players) {
            if (other === this.player || !other.ship) continue;
            if (other.ship.side === this.side) continue;

            // if (chebyshev(this.position, other.ship.position) <= 10) {  // TODO PUT BACK
            //     return "RED";
            // }
        }

        // 2. YELLOW if moderately low energy or significant damage
        if (this.damage >= 1000 || this.energy < 1000) {
            return "YELLOW";
        }

        // 3. GREEN otherwise
        return "GREEN";
    }

    static resolveShipName(abbreviation: string): string | null {
        const upper = abbreviation.toUpperCase();
        return SHIPNAMES.find(name => name.startsWith(upper)) || null;
    }

    static findPlayerByName(name: string): Player | undefined {
        return [...players].find(p => p.ship && p.ship.name === name);
    }

    static findShipByPartialName(partialName: string): Ship | null {
        if (!partialName) return null;
        const name = partialName.toUpperCase();
        const ship = players.find(
            (player: Player) => player.ship && player.ship.name && player.ship.name.toUpperCase().startsWith(name)
        )?.ship;
        return ship || null;
    }
}

export function applyDeviceDamage(
    ship: Ship,
    totalDamage = 150,
    targetDevices?: DeviceName[]
): void {
    const devices = (targetDevices ?? Object.keys(ship.devices)) as DeviceName[];

    const hits = 2 + iran(2); // 2 or 3 hits
    const perDevice = Math.floor(totalDamage / hits);

    const damageMap: Partial<Record<DeviceName, number>> = {};

    for (let i = 0; i < hits; i++) {
        const target = devices[iran(devices.length)];
        ship.devices[target] += perDevice;
        damageMap[target] = (damageMap[target] ?? 0) + perDevice;
    }

    for (const device of Object.keys(damageMap) as DeviceName[]) {
        const value = ship.devices[device];
        const status = value >= 300 ? "destroyed" : "damaged";
        addPendingMessage(ship.player, `${device} ${status}`);
    }
}

export function getNearbyAlliedShips(v: number, h: number, side: string, range: number): Player[] {
    return players.filter(p => {
        if (!p.ship) return false;
        if (p.ship.side !== side) return false;
        if (!p.radioOn) return false;

        return chebyshev(p.ship.position, { v: v, h: h }) <= range;
    });
}

export function attemptDisplaceFromImpact(attacker: Player, target: Player): void {
    if (!target.ship || !attacker.ship) return;

    const from = attacker.ship.position;
    const to = target.ship.position;

    const dv = Math.sign(to.v - from.v); // impact direction on Y
    const dh = Math.sign(to.h - from.h); // impact direction on X


    const newV = to.v + dv;
    const newH = to.h + dh;

    if (!isInBounds(newV, newH)) return;

    // Do not displace if the space is occupied by any game object (ship, planet, base, etc.)
    if (!findObjectAtPosition(newV, newH, true)) return;

    // Displace the ship
    target.ship.position = { v: newV, h: newH };

    const coords = ocdefCoords(attacker.settings.ocdef, attacker.ship.position, { v: newV, h: newH });
    addPendingMessage(target, `You were displaced to ${coords} by the torpedo impact.`);
    sendMessageToClient(attacker, `${target.ship.name} was knocked to ${newV}-${newH}.`);
}



export function getAdjacentFriendlyPlanets(ship: Ship): Planet[] {
    const { v, h } = ship.position;
    const team = ship.side;

    const adjacent: Planet[] = [];

    for (const planet of planets) {
        if (
            planet.side === team &&
            isAdjacent({ v, h }, planet.position) &&
            !adjacent.some(obj =>
                obj.position.v === planet.position.v &&
                obj.position.h === planet.position.h
            )
        ) {
            adjacent.push(planet);
        }
    }

    return adjacent;
}

export function handleUndockForAllShipsAfterPortDestruction(destroyedPort: Planet): void {
    const side = destroyedPort.side;
    if (side !== "FEDERATION" && side !== "EMPIRE") return; // nothing to do for neutral

    // Alive friendly bases
    const friendlyBases = (side === "FEDERATION" ? bases.federation : bases.empire)
        .filter(b => b.isBase && b.energy > 0);

    // Friendly captured planets (if your game allows docking at them)
    const friendlyPlanets = planets.filter(pl => pl.side === side && !pl.isBase /* captured planet */);

    for (const p of players) {
        const ship = p.ship;
        if (!ship || !ship.docked) continue;
        if (ship.side !== side) continue; // only ships of the destroyed side are affected

        // If ship is still adjacent to ANY friendly base or friendly captured planet, it can remain docked.
        const stillAdjacentToFriendlyBase = friendlyBases.some(b => isAdjacent(ship.position, b.position));
        const stillAdjacentToFriendlyPlanet = friendlyPlanets.some(pl => isAdjacent(ship.position, pl.position));
        const canRemainDocked = stillAdjacentToFriendlyBase || stillAdjacentToFriendlyPlanet;

        if (!canRemainDocked) {
            // Force undock and set RED (BASKIL behavior)
            ship.docked = false;
            ship.condition = "RED";

            // Clear any tracked dock target if present
            if (hasDockTarget(ship)) {
                ship.dockTarget = undefined;
            }

            addPendingMessage(p, "Your docking port was destroyed. You are now UNDOCKED. Condition set to RED.");
        } else {
            // Optional retargeting if you track a dock target (safe no-op otherwise)
            // if (hasDockTarget(ship)) {
            //   const teamBases = ship.side === "FEDERATION" ? bases.federation : bases.empire;
            //   const nearbyBase = teamBases.find(b => isAdjacent(ship.position, b.position));
            //   const nearbyPlanet = planets.find(pl => pl.side === ship.side && isAdjacent(ship.position, pl.position));
            //   ship.dockTarget = nearbyBase ?? nearbyPlanet ?? ship.dockTarget;
            // }
        }
    }
}