import { addPendingMessage, sendMessageToClient, sendOutputMessage } from './communication.js';
import { Position, findEmptyLocation } from './coords.js';
import { SHIPNAMES, Side, ShipCondition, MAX_TORPEDOES, MAX_SHIP_ENERGY, MAX_SHIELD_ENERGY } from './settings.js';
import { Player } from './player.js';


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
    public player: Player;
    public position: Position;
    public energy: number;
    public shieldsUp: boolean;
    public level: number;
    public name: string | null;
    public isDestroyed: boolean;
    public side: Side;
    public docked: boolean;
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
    public condition: ShipCondition;
    public damage: number;
    public cooldowns: Cooldowns;

    constructor(player: Player) {
        this.player = player;
        this.position = findEmptyLocation() || { v: 1, h: 1 };
        this.energy = MAX_SHIP_ENERGY;
        this.shieldsUp = false;
        this.level = MAX_SHIELD_ENERGY;
        this.docked = false;
        this.name = null;
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

    raiseShields(): void {
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
        const shieldRoom = Math.max(0, maxShieldEnergy - this.level);
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

        this.level += transferable;
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
            SHORT: `SH ${this.level}`,
            MEDIUM: `Shield energy: ${this.level}`,
            LONG: `Current shield reserve: ${this.level}`
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

        const transferable = Math.min(amount, this.level, roomInShip);

        if (transferable <= 0) {
            sendOutputMessage(this.player, {
                SHORT: "SH > NO SH",
                MEDIUM: "Not enough energy in shields.",
                LONG: "Insufficient shield energy available for transfer."
            });

            return 0;
        }

        this.level -= transferable;
        this.energy += transferable;

        sendOutputMessage(this.player, {
            SHORT: `-SH ${transferable}`,
            MEDIUM: `Transferred ${transferable} from shields.`,
            LONG: `Transferred ${transferable} units of energy from shields to ship.`
        });
        return transferable;
    }

    computeShieldStrength(): string {
        const percentage = (this.level / MAX_SHIELD_ENERGY) * 100;
        const strength = Math.max(0, Math.floor(percentage));
        return strength === 100
            ? `${strength}%`
            : `${this.shieldsUp ? '+' : '-'}${strength}%`;
    }

    computePercent(): number {
        const percent = (this.level / MAX_SHIELD_ENERGY) * 100;
        return this.shieldsUp ? Math.round(percent) : -Math.round(percent);
    }

    // static createShip(player: Player): Ship {
    //     const ship = new Ship(player);
    //     ship.side = "NEUTRAL";
    //     ship.name = "UNKNOWN";
    //     ship.position = { x: 0, y: 0 };
    //     return ship;
    // }
    static resolveShipName(abbreviation: string): string | null {
        const upper = abbreviation.toUpperCase();
        return SHIPNAMES.find(name => name.startsWith(upper)) || null;
    }
}



