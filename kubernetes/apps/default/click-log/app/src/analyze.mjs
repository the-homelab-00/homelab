// Journey analysis CLI: reads the click-log SQLite file directly and prints the
// markdown report (or JSON journeys) -- the thing to hand Claude when asking
// "what are players doing?".
//
//   node src/analyze.mjs [--db ./data/clicks.db] [--since 7d] [--until ...]
//                        [--user <userId>] [--timelines 20] [--live-only] [--json]
import { parseArgs } from 'node:util';
import { openDb, queryEvents } from './db.mjs';
import { buildJourneys, parseSince, report, timeline } from './journeys.mjs';

const { values } = parseArgs({
    options: {
        db: { type: 'string', default: process.env.DB_PATH ?? './data/clicks.db' },
        since: { type: 'string', default: '7d' },
        until: { type: 'string' },
        user: { type: 'string' },
        timelines: { type: 'string', default: '20' },
        // Studio playtest rows are included unless asked otherwise
        'live-only': { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
    },
});

const db = openDb(values.db);
const events = queryEvents(db, {
    since: parseSince(values.since),
    until: parseSince(values.until),
    userId: values.user ? Number(values.user) : null,
    includeStudio: !values['live-only'],
});
const journeys = buildJourneys(events);

if (values.json) {
    console.log(JSON.stringify(journeys, null, 2));
} else if (values.user) {
    // one player: every journey in full, oldest first
    console.log(journeys.map(timeline).join('\n\n') || 'No events for that user in range.');
} else {
    console.log(report(journeys, { timelines: Number(values.timelines) }));
}
