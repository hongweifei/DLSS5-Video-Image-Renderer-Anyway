// The request router.
//
// Routing is a lookup table rather than a chain of `if (url.pathname === ... && req.method ...)`
// checks. Every API path was already compared for exact equality, so `"<METHOD> <path>"` is a
// faithful key: same matching semantics, but the table can be scanned, and a duplicate or a typo
// is a startup error instead of a route that silently never fires.
//
// Anything that matches no API route falls through to the static handler for the page itself.
const { serveStatic } = require('./static');

const ROUTE_MODULES = [
    require('./status'),
    require('./job'),
    require('./picker'),
    require('./render'),
    require('./media'),
    require('./batch'),
    require('./export'),
];

// "<METHOD> /api/x" -> handler(req, res, url). Built once at load; a duplicate key means two
// modules claimed the same route, which would otherwise make one of them dead code.
const table = new Map();
for (const mod of ROUTE_MODULES) {
    for (const [method, routePath, fn] of mod) {
        const key = method + ' ' + routePath;
        if (table.has(key)) throw new Error('duplicate route registration: ' + key);
        table.set(key, fn);
    }
}

const handler = async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const route = table.get(req.method + ' ' + url.pathname);
    if (route) return route(req, res, url);
    return serveStatic(req, res, url);
};

module.exports = { handler, routes: table };
