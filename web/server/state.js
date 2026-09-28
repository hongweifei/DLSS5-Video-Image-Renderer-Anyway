// Mutable singletons shared by the render-queue pipeline and the routes that report on it.
//
// These live in their own module instead of being passed down as arguments because they are
// genuinely process-wide: one active render, one queue, one "last finished job" that the page
// reads to offer the "open the result" affordance. Routes only READ this state, or ask the queue
// module to act on it, so the module is a plain holder rather than a set of accessors.
//
// `current` is REASSIGNED (start the next job / clear on exit). Consumers must therefore import
// this object and write `state.current = ...`, never destructure the field at load time -- a
// destructured copy would keep pointing at the old job forever.
module.exports = {
    // { id, steps, passIndex, done, total, framesPerPass, lines, t0, t1, finished, cancelled,
    //   code, cfg, output, master, preview, export, child } -- the ACTIVE job only.
    current: null,

    // Jobs waiting behind the active one; each carries its own cfg snapshot.
    jobQueue: [],

    // { id, input, start, output, code, at } of the most recently finished job.
    lastDone: null,

    nextId: 1,

    // UI liveness: the page polls /api/status every ~500ms while open. When that stops (browser
    // tab/window closed) and no render job is running, the disposable frame cache is swept after
    // this grace period -- so closing just the BROWSER also cleans up, not only closing the guard
    // console. The guard console close still does the authoritative recursive sweep.
    uiLastPoll: Date.now(),
    uiIdleGraceMs: 60000,
};
