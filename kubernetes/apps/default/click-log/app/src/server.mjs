// Click journey log server. Game servers POST batches to /ingest
// (@Server/ClickLogSink); /report and /journeys read them back.
//
//   HOST          bind address (default 127.0.0.1: local only; 0.0.0.0 to expose)
//   PORT          listen port (default 8787)
//   DB_PATH       SQLite file (default ./data/clicks.db)
//   INGEST_TOKEN  the game's `click_log_token` secret; defaults to 'local-dev'
//                 (what Studio sends) and is REQUIRED when HOST is not loopback
//   READ_TOKEN    bearer token for the read endpoints (default: INGEST_TOKEN)
import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { insertEvents, openDb, queryEvents } from './db.mjs';
import { buildJourneys, parseSince, report } from './journeys.mjs';

const MAX_BODY_BYTES = 8 * 1024 * 1024; // after decompression
const MAX_EVENTS_PER_REQUEST = 2000;
// what Studio playtests send (ClickLogSink LOCAL_TOKEN); only accepted on loopback
const LOCAL_TOKEN = 'local-dev';

function tokenMatches(header, expected) {
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
    const given = Buffer.from(header.slice(7));
    const want = Buffer.from(expected);
    return given.length === want.length && timingSafeEqual(given, want);
}

function send(res, status, body, type = 'application/json') {
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8` });
    res.end(payload);
}

async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) throw Object.assign(new Error('body too large'), { status: 413 });
        chunks.push(chunk);
    }
    let body = Buffer.concat(chunks);
    if (req.headers['content-encoding'] === 'gzip') {
        body = gunzipSync(body, { maxOutputLength: MAX_BODY_BYTES });
    }
    return JSON.parse(body.toString('utf8'));
}

export function createApp({ db, ingestToken, readToken = ingestToken }) {
    if (!ingestToken) throw new Error('INGEST_TOKEN is required');
    return createServer(async (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        try {
            if (req.method === 'GET' && url.pathname === '/health') {
                return send(res, 200, { ok: true });
            }
            if (req.method === 'POST' && url.pathname === '/ingest') {
                if (!tokenMatches(req.headers.authorization, ingestToken)) return send(res, 401, { error: 'unauthorized' });
                const body = await readBody(req);
                const events = Array.isArray(body?.events) ? body.events : null;
                if (!events || events.length > MAX_EVENTS_PER_REQUEST) return send(res, 400, { error: 'expected { events: [...] }' });
                return send(res, 200, insertEvents(db, events));
            }
            if (req.method === 'GET' && (url.pathname === '/report' || url.pathname === '/journeys')) {
                if (!tokenMatches(req.headers.authorization, readToken)) return send(res, 401, { error: 'unauthorized' });
                const userParam = url.searchParams.get('user_id');
                const events = queryEvents(db, {
                    since: parseSince(url.searchParams.get('since') ?? '7d'),
                    until: parseSince(url.searchParams.get('until')),
                    userId: userParam ? Number(userParam) : null,
                    includeStudio: url.searchParams.get('studio') !== '0',
                });
                const journeys = buildJourneys(events);
                if (url.pathname === '/report') {
                    const timelines = Number(url.searchParams.get('timelines') ?? 20);
                    return send(res, 200, report(journeys, { timelines }), 'text/markdown');
                }
                const limit = Number(url.searchParams.get('limit') ?? 100);
                return send(res, 200, journeys.slice(-limit));
            }
            return send(res, 404, { error: 'not found' });
        } catch (error) {
            const status = error.status ?? (error instanceof SyntaxError ? 400 : 500);
            if (status === 500) console.error(error);
            return send(res, status, { error: status === 500 ? 'internal error' : error.message });
        }
    });
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('server.mjs')) {
    const host = process.env.HOST ?? '127.0.0.1';
    const port = Number(process.env.PORT ?? 8787);
    const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
    const ingestToken = process.env.INGEST_TOKEN || (loopback ? LOCAL_TOKEN : null);
    if (!ingestToken) {
        console.error('INGEST_TOKEN is required when HOST is not loopback');
        process.exit(1);
    }
    const db = openDb(process.env.DB_PATH ?? './data/clicks.db');
    createApp({ db, ingestToken, readToken: process.env.READ_TOKEN || undefined }).listen(port, host, () => {
        console.log(`click-log-server listening on http://${host}:${port}`);
    });
}
