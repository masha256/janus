import { parseArgs } from "node:util";
import { openDb } from "../db/connect.js";
import { resolveSession, readSessionDate, stampPhase } from "../db/repo/session.js";
import { recordRegime, getRegime } from "../db/repo/phase.js";
import { listClusters } from "../db/repo/cluster.js";
import { assertPhaseOrder, nowIso } from "../domain/session.js";
import { num, oneOf, readText, required, pairs, unknownVerb } from "./args.js";
const STATES = ["RISK_ON", "NEUTRAL", "RISK_OFF"];
export async function handle(verb, argv) {
    const db = openDb();
    try {
        const { values } = parseArgs({
            args: argv,
            options: {
                state: { type: "string" }, score: { type: "string" }, confidence: { type: "string" },
                summary: { type: "string" }, metric: { type: "string", multiple: true },
                date: { type: "string" }, force: { type: "boolean" },
            },
        });
        if (verb === "record") {
            const now = nowIso();
            const session = resolveSession(db, values.date, now);
            assertPhaseOrder(session, "regime", values.force === true);
            recordRegime(db, session.session_date, {
                state: oneOf(values.state, "state", STATES),
                summary: required(readText(values.summary), "summary"),
                // score and confidence are metrics like any other; the named flags win
                // over a --metric of the same key so the validated value is what lands.
                metrics: {
                    ...pairs(values.metric, "metric"),
                    score: num(values.score, "score", -2, 2),
                    confidence: num(values.confidence, "confidence", 0, 2),
                },
            }, now);
            stampPhase(db, session.session_date, "regime", now);
            const stamped = ["regime"];
            // A phase with nothing to read is vacuously complete. Without this, a
            // session with no clusters could never stamp cluster_read_at, because
            // cluster-read record requires a cluster key that does not exist.
            if (listClusters(db).length === 0) {
                stampPhase(db, session.session_date, "cluster_read", now);
                stamped.push("cluster_read");
            }
            return {
                session_date: session.session_date,
                stamped,
                ...getRegime(db, session.session_date),
            };
        }
        if (verb === "show") {
            const date = readSessionDate(db, values.date, nowIso());
            return { session_date: date, ...getRegime(db, date) };
        }
        throw unknownVerb(verb, "regime", "record, show");
    }
    finally {
        db.close();
    }
}
