// CommonJS, deterministic, no deps.
// Outputs CSV of the phaser parity grid (10× lighter damage; shows both debit policies).

const RANDOM_FALLOFF = 0.91;      // fixed 0.90..0.92 stand-in
const PHADAM_PHIT_DIVISOR = 10;   // 10× lighter visible damage

function phaserShot({ distance, shieldsPct, shieldsUp, isBase, phitInput, damagedPhaser, damagedComputer }) {
    const damaged = !!(damagedPhaser || damagedComputer);

    // distance falloff + damage penalty
    let hit = Math.pow(RANDOM_FALLOFF, Math.max(0, distance));
    if (damaged) hit *= 0.8;

    // powfac halves when base or shields up (and > 0)
    let powfac = 80;
    if (isBase || (shieldsUp && shieldsPct > 0)) powfac = 40;

    const phitIn = Math.max(0, Math.floor(phitInput / PHADAM_PHIT_DIVISOR));

    const shieldsBefore = shieldsPct;
    let through = 0;
    let shieldDrain = 0;
    let hull = 0;

    const treatedAsShielded = isBase || (shieldsUp && shieldsPct > 0);
    if (treatedAsShielded) {
        through = hit * (1000 - shieldsPct) * 0.001;
        const pctFactor = Math.max(shieldsPct * 0.001, 0.1);
        shieldDrain = (hit * powfac * phitIn * pctFactor + 10) * 0.03;
        shieldsPct = Math.max(0, shieldsPct - shieldDrain);
        hull = through * powfac * phitIn;
    } else {
        hull = hit * powfac * phitIn;
    }

    if (shieldsBefore >= 999.999 && treatedAsShielded) { through = 0; hull = 0; }

    const critEstimate = hull >= 1700;
    return { powfac, phitIn, shieldsAfter: shieldsPct, through, hull, shieldDrain, critEstimate };
}

function runGrid() {
    const distances = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const shieldLevels = [1000, 500, 0];
    const userInputs = [50, 200, 500];
    const cases = [
        { label: 'Ship: shields UP', flags: { isBase: false, shieldsUp: true } },
        { label: 'Ship: shields DOWN', flags: { isBase: false, shieldsUp: false } },
        { label: 'Base', flags: { isBase: true, shieldsUp: true } },
    ];

    const rows = [[
        'scenario', 'user_input', 'distance', 'powfac', 'phit_in_for_damage',
        'shields_up?', 'shields_pct_before', 'shields_pct_after', 'shield_drain',
        'through', 'hull_damage', 'crit_estimate', 'energy_debit_legacy_x10', 'energy_debit_scaled_x1'
    ].join(',')];

    for (const c of cases) {
        for (const E of userInputs) {
            for (const dist of distances) {
                for (const s of shieldLevels) {
                    const out = phaserShot({
                        distance: dist,
                        shieldsPct: s,
                        shieldsUp: c.flags.shieldsUp,
                        isBase: c.flags.isBase,
                        phitInput: E,
                    });
                    const legacyDebit = E * 10; // FORTRAN policy
                    const scaledDebit = E * 1;  // alternative policy
                    rows.push([
                        c.label,
                        E,
                        dist,
                        out.powfac.toFixed(1),
                        out.phitIn.toFixed(0),
                        String(c.flags.shieldsUp),
                        s.toFixed(0),
                        out.shieldsAfter.toFixed(3),
                        (s - out.shieldsAfter).toFixed(3),
                        out.through.toFixed(6),
                        out.hull.toFixed(3),
                        String(out.critEstimate),
                        legacyDebit.toFixed(0),
                        scaledDebit.toFixed(0),
                    ].join(','));
                }
            }
        }
    }
    return rows.join('\n');
}

// Always run and print (no ESM/CJS guard)
const csv = runGrid();
console.log(csv);
