// Journey reconstruction + the analysis report over the click log.
//
// A JOURNEY is one player's continuous visit: their events in time order, cut
// after a `session_ended` or wherever they go quiet for longer than GAP_SECONDS.
// A `teleported` event (lobby -> game, restart hop, ...) does NOT cut it, so a
// journey follows the player across servers the way they experienced it.

export const GAP_SECONDS = 30 * 60;
const RAGE_WINDOW_SECONDS = 2;
const RAGE_MIN_CLICKS = 4;
const SESSION_EDGES = new Set(['session_started', 'session_ended', 'teleported']);

// 'MainUI/Root/Shop/Items/Card/BuyButton' -> 'MainUI/…/Card/BuyButton': the
// head names the ScreenGui, the tail names the button.
export function shortTarget(event) {
    if (event.kind !== 'button') return event.name;
    const parts = event.name.split('/');
    if (parts.length <= 4) return parts.join('/');
    return [parts[0], '…', ...parts.slice(-2)].join('/');
}

export function label(event) {
    if (event.kind === 'event') return event.name;
    const target = shortTarget(event);
    return event.kind === 'world' ? target : `click ${target}`;
}

export function buildJourneys(events, gapSeconds = GAP_SECONDS) {
    const journeys = [];
    let current = null;
    for (const event of events) {
        const startNew =
            !current ||
            current.userId !== event.user_id ||
            event.at - current.end > gapSeconds ||
            current.ended;
        if (startNew) {
            current = {
                id: `${event.user_id}@${Math.floor(event.at)}`,
                userId: event.user_id,
                start: event.at,
                end: event.at,
                places: new Set(),
                ended: false,
                events: [],
            };
            journeys.push(current);
        }
        current.events.push(event);
        current.end = event.at;
        if (event.place) current.places.add(event.place);
        if (event.kind === 'event' && event.name === 'session_ended') current.ended = true;
    }
    return journeys.map(summarise);
}

function summarise(journey) {
    const clicks = journey.events.filter((e) => e.kind !== 'event');
    const first = journey.events.find((e) => e.kind === 'event' && e.name === 'session_started');
    const end = journey.events.findLast((e) => e.kind === 'event' && e.name === 'session_ended');
    const userType = end?.props?.user_type ?? null;
    return {
        ...journey,
        places: [...journey.places],
        durationSeconds: journey.end - journey.start,
        clickCount: clicks.length,
        // is this the player's first-ever visit? (new = join-time snapshot)
        userType: typeof userType === 'string' ? userType.replace(/^User - /, '').toLowerCase() : null,
        sawStart: Boolean(first),
        rage: findRageClicks(clicks),
    };
}

// Bursts of RAGE_MIN_CLICKS+ clicks on one target inside RAGE_WINDOW_SECONDS:
// the usual sign a button looked clickable and didn't respond.
export function findRageClicks(clicks) {
    const bursts = [];
    let i = 0;
    while (i < clicks.length) {
        let j = i;
        while (
            j + 1 < clicks.length &&
            clicks[j + 1].name === clicks[i].name &&
            clicks[j + 1].at - clicks[i].at <= RAGE_WINDOW_SECONDS
        ) {
            j++;
        }
        if (j - i + 1 >= RAGE_MIN_CLICKS) {
            bursts.push({ target: shortTarget(clicks[i]), count: j - i + 1, at: clicks[i].at });
        }
        i = j + 1;
    }
    return bursts;
}

const fmtClock = (seconds) => {
    const s = Math.max(0, Math.round(seconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};
const fmtDate = (unix) => new Date(unix * 1000).toISOString().replace('T', ' ').slice(0, 19);
const pct = (part, whole) => (whole ? `${Math.round((part / whole) * 100)}%` : '–');
const median = (values) => {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

function countTop(items, limit) {
    const counts = new Map();
    for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

const table = (rows, headers) =>
    rows.length
        ? [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n')
        : '_none_';

// One journey as a compact timeline: offsets from the start, consecutive
// repeats folded ("×3"), the menu each click happened in.
export function timeline(journey) {
    const lines = [];
    let previous = null;
    for (const event of journey.events) {
        if (event.kind === 'event' && event.name === 'session_started') continue;
        const text = label(event) + (event.kind !== 'event' && event.menu ? `  [${event.menu}]` : '');
        if (previous && previous.text === text) {
            previous.count++;
            lines[lines.length - 1] = `${previous.prefix}${text} ×${previous.count}`;
            continue;
        }
        const marker = event.kind === 'event' ? '•' : '→';
        const prefix = `  +${fmtClock(event.at - journey.start)} ${marker} `;
        previous = { text, count: 1, prefix };
        lines.push(prefix + text);
    }
    const head =
        `### Journey ${journey.id} — user ${journey.userId}` +
        `${journey.userType ? ` (${journey.userType})` : ''}\n` +
        `${fmtDate(journey.start)} UTC · ${fmtClock(journey.durationSeconds)} · ` +
        `${journey.clickCount} clicks · ${journey.places.join(' → ') || 'unknown place'} · ` +
        `${journey.ended ? 'quit' : 'no session_ended (still playing, crashed or cut by a gap)'}`;
    return `${head}\n${lines.join('\n')}`;
}

// The full markdown report: aggregates first, then per-journey timelines.
export function report(journeys, { timelines = 20, contextSteps = 3 } = {}) {
    const out = [];
    const ended = journeys.filter((j) => j.ended);
    const newOnes = journeys.filter((j) => j.userType === 'new');
    const users = new Set(journeys.map((j) => j.userId));

    out.push('# Player journey report', '');
    if (!journeys.length) {
        out.push('No events in range.');
        return out.join('\n');
    }
    out.push(
        `${fmtDate(journeys.reduce((m, j) => Math.min(m, j.start), Infinity))} → ` +
            `${fmtDate(journeys.reduce((m, j) => Math.max(m, j.end), 0))} UTC`,
        '',
        table(
            [
                ['players', users.size],
                ['journeys', journeys.length],
                ['ended with a quit', `${ended.length} (${pct(ended.length, journeys.length)})`],
                ['new-player journeys', newOnes.length],
                ['median journey length', fmtClock(median(journeys.map((j) => j.durationSeconds)))],
                ['median clicks / journey', median(journeys.map((j) => j.clickCount))],
                ['journeys under 3 min', pct(journeys.filter((j) => j.durationSeconds < 180).length, journeys.length)],
            ],
            ['metric', 'value'],
        ),
        '',
    );

    // where players leave: the last few actions before each quit
    const exits = ended.map((j) =>
        j.events
            .filter((e) => !SESSION_EDGES.has(e.name) || e.kind !== 'event')
            .slice(-contextSteps)
            .map(label)
            .join(' → '),
    );
    out.push(`## Exit points (last ${contextSteps} actions before quitting)`, '');
    out.push(table(countTop(exits, 15).map(([path, n]) => [path || '(nothing)', n, pct(n, ended.length)]), ['path', 'quits', 'share']), '');

    const lastMenus = ended.map((j) => j.events.findLast((e) => e.kind !== 'event')?.menu ?? '(no menu open)');
    out.push('## Menu open at the last click before quitting', '');
    out.push(table(countTop(lastMenus, 10).map(([menu, n]) => [menu, n, pct(n, ended.length)]), ['menu', 'quits', 'share']), '');

    // the opening of a new player's visit
    const openings = newOnes.map((j) =>
        j.events
            .filter((e) => e.kind !== 'event')
            .slice(0, 3)
            .map(label)
            .join(' → '),
    );
    out.push('## New players: first 3 clicks', '');
    out.push(table(countTop(openings, 10).map(([path, n]) => [path || '(no clicks)', n, pct(n, newOnes.length)]), ['path', 'journeys', 'share']), '');

    const allClicks = journeys.flatMap((j) => j.events.filter((e) => e.kind !== 'event'));
    out.push('## Most clicked', '');
    out.push(
        table(
            countTop(allClicks.map((e) => `${label(e)}${e.menu ? ` [${e.menu}]` : ''}`), 20).map(([t, n]) => [t, n]),
            ['target [menu]', 'clicks'],
        ),
        '',
    );

    // reach: share of journeys that clicked a target at least once
    const reach = journeys.flatMap((j) => [...new Set(j.events.filter((e) => e.kind === 'button').map(shortTarget))]);
    out.push('## Button reach (share of journeys that ever clicked it)', '');
    out.push(table(countTop(reach, 20).map(([t, n]) => [t, n, pct(n, journeys.length)]), ['button', 'journeys', 'share']), '');

    const rage = journeys.flatMap((j) => j.rage);
    out.push(`## Rage clicks (${RAGE_MIN_CLICKS}+ on one target within ${RAGE_WINDOW_SECONDS}s)`, '');
    out.push(table(countTop(rage.map((r) => r.target), 15).map(([t, n]) => [t, n]), ['target', 'bursts']), '');

    // common 3-step click sequences anywhere in a journey
    const trigrams = journeys.flatMap((j) => {
        const steps = [];
        for (const e of j.events) {
            if (e.kind === 'event') continue;
            const l = label(e);
            if (steps.at(-1) !== l) steps.push(l);
        }
        const grams = [];
        for (let i = 0; i + 2 < steps.length; i++) grams.push(steps.slice(i, i + 3).join(' → '));
        return grams;
    });
    out.push('## Common 3-click sequences', '');
    out.push(table(countTop(trigrams, 15).map(([t, n]) => [t, n]), ['sequence', 'times']), '');

    if (timelines > 0) {
        const picked = [...journeys].sort((a, b) => b.start - a.start).slice(0, timelines);
        out.push(`## Journeys (${picked.length} most recent of ${journeys.length})`, '');
        for (const journey of picked) out.push(timeline(journey), '');
    }
    return out.join('\n');
}

// '24h' / '7d' / '30m' / ISO date / unix seconds -> unix seconds
export function parseSince(value, now = Date.now() / 1000) {
    if (value === undefined || value === null || value === '') return null;
    const rel = /^(\d+(?:\.\d+)?)([mhd])$/.exec(value);
    if (rel) return now - Number(rel[1]) * { m: 60, h: 3600, d: 86400 }[rel[2]];
    if (/^\d+(\.\d+)?$/.test(value)) return Number(value);
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) throw new Error(`can't read time "${value}" (use 24h, 7d, an ISO date or unix seconds)`);
    return parsed / 1000;
}
