import { Socket } from 'net';
import { Ship } from './ship.js';
import { sendMessageToClient } from './communication.js';
import { players, removePlayerFromGame } from './game.js';
import { Side, ScanSetting, PromptSetting, OCDEF, ICDEF, OutputSetting, MAX_SHIELD_ENERGY, LS_CRITICAL_DAMAGE } from './settings.js';
import { AuthSession } from './util/auth.js';
import { findEmptyLocation } from './coords.js';
import { emitShipLeft, emitShipDestroyed } from './api/events.js';


const suffocationMessages = [
    "Life support failed. Your crew drew their final breaths and fell silent.",
    "Oxygen tanks empty. The ship now drifts, silent and lifeless.",
    "You hear one final gasp... then only the hum of dead systems remains.",
    "Without life support, the crew could not survive. All hands lost.",
    "No air. No hope. Just a hulk in space, and the echo of a failed mission."
];

export class Player {
    public auth: AuthSession;
    public joinTime: number;
    public stardate: number;
    public lastActivity: number;
    public socket: Socket;
    public isAdmin: boolean;
    public isOnHold: boolean;
    public inputBuffer: string;
    public pendingMessages: string[] = [];
    public multiLine: boolean;
    public ship: Ship | null;
    public gagList: Set<string>;
    public radioOn: boolean;
    //public alive: boolean;
    public history: string[];
    public historyIndex: number;
    public ready: boolean;
    public commandQueue: string[];
    public processingCommand: boolean;
    public currentCommandTimer: NodeJS.Timeout | null = null;
    public knownEnemyBases: { x: number; y: number; side: Side }[];
    public points: {
        damageToEnemies: number;
        enemiesDestroyed: number;
        damageToBases: number;
        planetsCaptured: number;
        basesBuilt: number;
        damageToRomulans: number;
        starsDestroyed: number;
        planetsDestroyed: number;
    };
    public settings: {
        scan: ScanSetting;
        prompt: PromptSetting;
        ocdef: OCDEF;
        icdef: ICDEF;
        output: OutputSetting;
        name: string | null;
    }
    public currentPrompt?: string;

    public callBack?: (who: Player, resp: string) => void;

    constructor(socket: Socket) {
        this.auth = {
            ip: socket.remoteAddress ?? 'unknown',
            email: undefined,
            code: undefined,
            authed: false,
            createdAt: Date.now()
        };
        this.socket = socket;
        this.isAdmin = false;
        this.joinTime = Date.now();
        this.stardate = 0;
        this.lastActivity = Date.now();
        this.isOnHold = false;
        this.inputBuffer = '';
        this.pendingMessages = [];
        this.multiLine = false;
        this.ship = this.createShip();
        this.gagList = new Set();
        this.radioOn = true;
        //this.alive = false;
        this.history = [];
        this.historyIndex = -1;
        this.ready = false;
        this.commandQueue = [];
        this.processingCommand = false;
        this.currentCommandTimer = null;
        this.knownEnemyBases = [];
        this.points = {
            damageToEnemies: 0,
            enemiesDestroyed: 0,
            damageToBases: 0,
            planetsCaptured: 0,
            basesBuilt: 0,
            damageToRomulans: 0,
            starsDestroyed: 0,
            planetsDestroyed: 0,
        };
        this.settings = {
            scan: "LONG",
            prompt: "NORMAL",
            ocdef: "ABSOLUTE",
            icdef: "ABSOLUTE",
            output: "LONG",
            name: null
        }
        this.currentPrompt = undefined;
    }

    getPrompt(): string {
        if (!this.ship) {
            return '??> ';
        }

        if (this.currentPrompt) {
            return `${this.currentPrompt}`;
        }

        if (!players.includes(this)) {
            return 'PG> ';
        }

        // NORMAL prompt style
        if (this.settings.prompt === 'NORMAL') {
            return 'Command: ';
        }

        // INFORMATIVE prompt style
        const flags: string[] = [];
        const ship = this.ship;

        // S: shields down or <10%
        if (ship.shieldsUp && ship.shieldEnergy < 0.1 * MAX_SHIELD_ENERGY) {
            flags.push('S');
        }

        // E: energy < 1000 (yellow alert)
        if (ship.energy < 1000) {
            flags.push('E');
        }

        // D: total device damage > 2000
        const totalDamage = Object.values(ship.devices)
            .reduce((sum, d) => sum + d, 0);
        if (totalDamage > 2000) {
            flags.push('D');
        }

        if (ship.devices.lifeSupport >= LS_CRITICAL_DAMAGE && ship.lifeSupportFailureTimer != null) {
            flags.push(`${ship.lifeSupportFailureTimer}L`);
        }

        // Combine flags; leave blank if none
        const prefix = flags.length ? flags.join('') : '';
        return `${prefix}> `;
    }

    toggleRadio(state: boolean): void {
        this.radioOn = state;
        sendMessageToClient(this, `Radio turned ${state ? "on" : "off"}.`);
    }

    gagShip(inputName: string): void {
        const resolved = Ship.resolveShipName(inputName);
        if (!resolved) {
            sendMessageToClient(this, `Unknown ship: ${inputName} `);
            return;
        }

        if (this.ship && this.ship.name === resolved) {
            sendMessageToClient(this, `You cannot gag yourself.`);
            return;
        }

        this.gagList.add(resolved.toUpperCase());
        sendMessageToClient(this, `Radio messages from ${resolved} will be ignored.`);
    }

    ungagShip(inputName: string): void {
        const resolved = Ship.resolveShipName(inputName);
        if (!resolved) {
            sendMessageToClient(this, `Unknown ship: ${inputName} `);
            return;
        }

        const removed = this.gagList.delete(resolved.toUpperCase());
        if (removed) {
            sendMessageToClient(this, `Radio messages from ${resolved} will now be received.`);
        } else {
            sendMessageToClient(this, `${resolved} was not gagged.`);
        }
    }

    updateLifeSupport(): void {
        if (!this.ship) return;
        if (this.ship.docked) return;              // parity: no drain while docked
        const damage = this.ship.devices?.lifeSupport ?? 0;

        if (damage >= LS_CRITICAL_DAMAGE) {
            // LS is inoperative
            if (this.ship.lifeSupportFailureTimer == null) {
                this.ship.lifeSupportFailureTimer = 60; // Start 60-stardate countdown
                sendMessageToClient(this, "WARNING: Life support failure. You must dock or repair within 5 stardates.");
            } else {
                this.ship.lifeSupportFailureTimer--;
                if (this.ship.lifeSupportFailureTimer > 0) {
                    sendMessageToClient(this, `Life support failure: ${this.ship.lifeSupportFailureTimer} stardates remaining.`);
                } else {
                    sendMessageToClient(this, suffocationMessages[Math.floor(Math.random() * suffocationMessages.length)]);
                    if (this.ship) {
                        emitShipDestroyed(
                            this.ship.name,
                            this.ship.side,
                            { v: this.ship.position.v, h: this.ship.position.h },
                          /* by */ undefined,
                            "other"
                        );
                    }
                    removePlayerFromGame(this);
                }
            }
        } else {
            // LS repaired — reset countdown
            if (this.ship.lifeSupportFailureTimer !== null) {
                sendMessageToClient(this, "Life support repaired. Countdown cancelled.");
            }
            this.ship.lifeSupportFailureTimer = null;
        }
    }


    addToHistory(line: string): void {
        const trimmed = line.trim();
        if (trimmed.length === 0) return;
        if (trimmed.toUpperCase().startsWith("TE")) return;

        this.history.push(trimmed);
        if (this.history.length > 20) {
            this.history.shift();
        }

        this.historyIndex = -1; // reset browsing on new entry
    }

    getNextHistory(): string | undefined {
        const len = this.history.length;
        if (len === 0) return undefined;
        // return this.history[len - 1];
        //Move backward in history
        this.historyIndex--;

        if (this.historyIndex < 0) {
            this.historyIndex = len - 1; // loop back to most recent
        }

        return this.history[this.historyIndex];
    }


    quitGame(): void {
        emitShipLeft(this, "logout"); // or "logout"/"timeout"/"idle"
        const idx = players.findIndex(p => p === this);
        if (idx !== -1) players.splice(idx, 1);

        this.socket?.end();
        this.socket?.destroy();
    }

    createShip(): Ship | null {
        const ship = new Ship(this);
        ship.side = "NEUTRAL";
        ship.name = "NEUTRAL";
        const pos = findEmptyLocation();
        if (pos) {
            ship.position = pos;
        } else {
            return null;
        }
        return ship;
    }
}
