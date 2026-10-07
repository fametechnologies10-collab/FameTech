// Strips control characters (including newlines, which could otherwise forge log lines)
// and truncates to a bounded length. Used for any supplier-controlled string before it is
// persisted to the DB (audit-trail bloat/pollution) or written to console output (log-line
// forgery). Not a SQL-injection concern here — all DB writes that use this go through
// parameterized RPC/query-builder calls — this is purely about bounding untrusted input.
//
// Shared by app/api/webhooks/agentportal/route.ts and lib/agentportal-apply-outcome.ts so
// both call sites sanitize supplier-controlled strings identically.
export function sanitizeForStorage(value: unknown, maxLen = 300): string {
    const str = value == null ? '' : String(value)
    // eslint-disable-next-line no-control-regex -- deliberately stripping control chars incl. \n\r
    return str.replace(/[\x00-\x1F\x7F]/g, '').slice(0, maxLen)
}
