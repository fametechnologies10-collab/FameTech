import { createPollGuard } from '@/lib/poll-guard'

function ok(cond: boolean, msg: string) {
    if (!cond) throw new Error(msg)
}

const g = createPollGuard()
const t1 = g.begin()
ok(g.isCurrent(t1), 'fresh token is current')
const t2 = g.begin()
ok(!g.isCurrent(t1), 'first token stale after second begin')
ok(g.isCurrent(t2), 'second token current')
g.cancel()
ok(!g.isCurrent(t2), 'latest token stale after cancel')
const t3 = g.begin()
ok(g.isCurrent(t3), 'token after cancel is current')
ok(!g.isCurrent(t1) && !g.isCurrent(t2), 'stale tokens stay stale')
