import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { mountAppCore, inkressApi, orderStatusName, isPaidStatus } from "@inkress/apps-core";
import { openPg } from "@inkress/apps-core/pgdb";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
for (const k of ["OAUTH_CLIENT_ID", "OAUTH_CLIENT_SECRET", "INKRESS_API_BASE"]) {
  if (!process.env[k]) { console.error(`[enhanced-analytics] Missing env: ${k}`); process.exit(1); }
}

// Saved custom reports (per merchant): a named preset of range + status filter.
const db = await openPg("enhanced_analytics", `
  CREATE TABLE IF NOT EXISTS saved_reports (
    id BIGSERIAL PRIMARY KEY, merchant_id BIGINT NOT NULL,
    name TEXT NOT NULL, range TEXT NOT NULL DEFAULT '30d', status TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`);

const app = express();
const core = mountAppCore(app, {
  clientId: process.env.OAUTH_CLIENT_ID, clientSecret: process.env.OAUTH_CLIENT_SECRET,
  apiBaseUrl: process.env.INKRESS_API_BASE, frameAncestors: process.env.FRAME_ANCESTORS,
  staticDir: path.join(__dirname, "dist"),
});

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const RANGES = { "7d": 7, "30d": 30, "90d": 90 };
const curOf = (o) => o.currency?.code || o.currency_code || "JMD";
const tsOf = (o) => new Date(o.inserted_at || o.created_at || 0).getTime();
const custOf = (o) => o.customer?.id || o.customer?.email || null;

// Windowed paginated order fetch (covers the requested range + the prior one for deltas).
async function fetchOrdersSince(session, since, maxPages = 12) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const r = await inkressApi(core.cfg, session.accessToken, `orders?limit=200&page=${page}&order=id desc`);
    const entries = r?.result?.entries || [];
    out.push(...entries);
    if (!entries.length) break;
    if (tsOf(entries[entries.length - 1]) < since) break;
  }
  return out;
}

// Order line items (orders:read covers order_lines). Each line carries the
// frozen product name + line total + quantity, so a product breakdown needs
// no products:read and no joins — we just keep the lines belonging to the
// paid, in-range orders. Returns { lines, capped }.
async function fetchOrderLines(session, keepOrderId, maxPages = 18) {
  const lines = [];
  let capped = false;
  for (let page = 1; page <= maxPages; page++) {
    const r = await inkressApi(core.cfg, session.accessToken, `order_lines?limit=200&page=${page}&order=id desc`).catch(() => null);
    const entries = r?.result?.entries || [];
    for (const l of entries) if (keepOrderId(l.order_id)) lines.push(l);
    if (!entries.length) break;
    if (page === maxPages) capped = true;
  }
  return { lines, capped };
}

const pct = (a, b) => (b ? Math.round(((a - b) / b) * 100) : (a ? 100 : 0));

app.get("/api/analytics", core.requireSession, async (req, res) => {
  const days = RANGES[req.query.range] || 30;
  const tzOffsetMin = Math.max(-840, Math.min(840, parseInt(req.query.tz || "0", 10) || 0)); // local-time bucketing
  const now = Date.now();
  const since = now - days * 86400 * 1000;
  const prevSince = since - days * 86400 * 1000;

  // Optional status filter — narrows totals/trend/customers to one order status.
  const statusFilter = String(req.query.status || "").trim();
  const matchStatus = (o) => !statusFilter || orderStatusName(o) === statusFilter;

  try {
    const all = await fetchOrdersSince(req.session, prevSince);
    const curAll = all.filter((o) => tsOf(o) >= since);
    const cur = curAll.filter(matchStatus);
    const prev = all.filter((o) => tsOf(o) >= prevSince && tsOf(o) < since && matchStatus(o));

    // Status breakdown over the unfiltered in-range set (a real "breakdown").
    const statusBreakdown = {};
    for (const o of curAll) { const s = orderStatusName(o) || "unknown"; statusBreakdown[s] = (statusBreakdown[s] || 0) + 1; }

    // local Date for an order (apply merchant tz offset)
    const localDate = (o) => new Date(tsOf(o) - tzOffsetMin * 60 * 1000);

    const summarize = (orders) => {
      let revenue = 0, paid = 0, refunds = 0;
      for (const o of orders) {
        if (orderStatusName(o) === "refunded") refunds++;
        if (isPaidStatus(o)) { paid++; revenue = round2(revenue + Number(o.total || 0)); }
      }
      return { revenue, paid, orders: orders.length, refunds, aov: paid ? round2(revenue / paid) : 0,
               refund_rate: orders.length ? Math.round((refunds / orders.length) * 100) : 0 };
    };
    const curT = summarize(cur), prevT = summarize(prev);

    // Trends — by day (paid revenue + order count)
    const byDay = new Map();
    // Peak times — hour-of-day (0..23) and day-of-week (0=Sun..6)
    const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, orders: 0, revenue: 0 }));
    const dows = Array.from({ length: 7 }, (_, d) => ({ dow: d, orders: 0, revenue: 0 }));
    for (const o of cur) {
      if (!isPaidStatus(o)) continue;
      const ld = localDate(o); const amt = Number(o.total || 0);
      const dkey = ld.toISOString().slice(0, 10);
      const day = byDay.get(dkey) || { date: dkey, revenue: 0, orders: 0 };
      day.revenue = round2(day.revenue + amt); day.orders++; byDay.set(dkey, day);
      const h = ld.getUTCHours(); hours[h].orders++; hours[h].revenue = round2(hours[h].revenue + amt);
      const d = ld.getUTCDay(); dows[d].orders++; dows[d].revenue = round2(dows[d].revenue + amt);
    }
    const trend = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));

    // Customer patterns — new vs repeat (within fetched history), top customers, repeat rate
    const seenBefore = new Set(); // customers with an order before `since`
    for (const o of all) if (tsOf(o) < since) { const c = custOf(o); if (c) seenBefore.add(c); }
    const byCust = new Map();
    for (const o of cur) {
      const c = custOf(o); if (!c) continue;
      const m = byCust.get(c) || { id: c, name: o.customer ? ([o.customer.first_name, o.customer.last_name].filter(Boolean).join(" ") || o.customer.email) : "Customer", orders: 0, revenue: 0, isNew: !seenBefore.has(c) };
      m.orders++; if (isPaidStatus(o)) m.revenue = round2(m.revenue + Number(o.total || 0));
      byCust.set(c, m);
    }
    const custs = [...byCust.values()];
    const newCount = custs.filter((c) => c.isNew).length;
    const repeatCount = custs.filter((c) => c.orders > 1 || !c.isNew).length;
    const topCustomers = custs.sort((a, b) => b.revenue - a.revenue).slice(0, 8);

    res.json({
      range: req.query.range || "30d",
      status: statusFilter || null,
      totals: {
        ...curT,
        revenue_delta: pct(curT.revenue, prevT.revenue),
        orders_delta: pct(curT.paid, prevT.paid),
        aov_delta: pct(curT.aov, prevT.aov),
      },
      trend,
      peak_hours: hours,
      peak_dows: dows,
      status_breakdown: Object.entries(statusBreakdown).map(([status, count]) => ({ status, count })).sort((a, b) => b.count - a.count),
      customers: {
        total: custs.length, new: newCount, repeat: repeatCount,
        repeat_rate: custs.length ? Math.round((repeatCount / custs.length) * 100) : 0,
        top: topCustomers,
      },
      coverage: { fetched: all.length, in_range: curAll.length },
    });
  } catch (err) {
    res.status(502).json({ error: "analytics_failed", message: err?.message });
  }
});

const custName = (o) => o.customer ? ([o.customer.first_name, o.customer.last_name].filter(Boolean).join(" ") || o.customer.email || "Customer") : "Customer";
const custEmail = (o) => o.customer?.email || null;

// Full customer directory with lifetime value over the window (orders:read).
app.get("/api/customers", core.requireSession, async (req, res) => {
  const days = RANGES[req.query.range] || 90;
  const since = Date.now() - days * 86400 * 1000;
  try {
    const orders = (await fetchOrdersSince(req.session, since)).filter((o) => tsOf(o) >= since);
    const by = new Map();
    for (const o of orders) {
      const c = custOf(o); if (!c) continue;
      const ts = tsOf(o);
      const m = by.get(c) || { id: String(c), name: custName(o), email: custEmail(o), orders: 0, paid_orders: 0, revenue: 0, first_order: null, last_order: null, currency: curOf(o) };
      m.orders++;
      if (m.first_order == null || ts < m.first_order) m.first_order = ts;
      if (m.last_order == null || ts > m.last_order) m.last_order = ts;
      if (isPaidStatus(o)) { m.paid_orders++; m.revenue = round2(m.revenue + Number(o.total || 0)); }
      by.set(c, m);
    }
    const customers = [...by.values()].map((m) => ({
      ...m,
      first_order: m.first_order ? new Date(m.first_order).toISOString() : null,
      last_order: m.last_order ? new Date(m.last_order).toISOString() : null,
      aov: m.paid_orders ? round2(m.revenue / m.paid_orders) : 0,
    })).sort((a, b) => b.revenue - a.revenue);
    res.json({ customers, range: req.query.range || "90d" });
  } catch (err) { res.status(502).json({ error: "customers_failed", message: err?.message }); }
});

// One customer's journey — order history timeline + lifetime totals (orders:read).
app.get("/api/customer/:id", core.requireSession, async (req, res) => {
  const id = String(req.params.id);
  const days = RANGES[req.query.range] || 90;
  const since = Date.now() - days * 86400 * 1000;
  try {
    const orders = (await fetchOrdersSince(req.session, since))
      .filter((o) => tsOf(o) >= since && String(custOf(o)) === id)
      .sort((a, b) => tsOf(b) - tsOf(a));
    let revenue = 0, paid = 0;
    const timeline = orders.map((o) => {
      if (isPaidStatus(o)) { paid++; revenue = round2(revenue + Number(o.total || 0)); }
      return { id: o.id, title: o.title || o.reference_id || `Order ${o.id}`, total: round2(Number(o.total || 0)), currency: curOf(o), status: orderStatusName(o), at: new Date(tsOf(o)).toISOString() };
    });
    const head = orders[0];
    res.json({
      customer: {
        id, name: head ? custName(head) : "Customer", email: head ? custEmail(head) : null,
        orders: orders.length, paid_orders: paid, revenue, aov: paid ? round2(revenue / paid) : 0,
        currency: head ? curOf(head) : "JMD",
        first_order: orders.length ? new Date(tsOf(orders[orders.length - 1])).toISOString() : null,
        last_order: orders.length ? new Date(tsOf(orders[0])).toISOString() : null,
      },
      timeline,
    });
  } catch (err) { res.status(502).json({ error: "customer_failed", message: err?.message }); }
});

// Product-level breakdown — top products by revenue + units, built from
// order_lines of the merchant's paid, in-range orders (orders:read only).
app.get("/api/products", core.requireSession, async (req, res) => {
  const days = RANGES[req.query.range] || 30;
  const since = Date.now() - days * 86400 * 1000;
  try {
    const orders = await fetchOrdersSince(req.session, since);
    const paid = new Map();
    for (const o of orders) if (tsOf(o) >= since && isPaidStatus(o)) paid.set(o.id, o);
    if (!paid.size) return res.json({ products: [], orders_covered: 0, capped: false });

    const { lines, capped } = await fetchOrderLines(req.session, (id) => paid.has(id));
    const by = new Map();
    for (const l of lines) {
      const name = l.product_variant_name_frozen || "Unnamed item";
      const m = by.get(name) || { name, units: 0, revenue: 0, orders: new Set() };
      m.units += Number(l.quantity || 0);
      m.revenue = round2(m.revenue + Number(l.product_variant_total_frozen || 0));
      m.orders.add(l.order_id);
      by.set(name, m);
    }
    const products = [...by.values()]
      .map((m) => ({ name: m.name, units: m.units, revenue: m.revenue, orders: m.orders.size }))
      .sort((a, b) => b.revenue - a.revenue);
    res.json({ products, orders_covered: paid.size, capped, range: req.query.range || "30d" });
  } catch (err) { res.status(502).json({ error: "products_failed", message: err?.message }); }
});

// Saved custom reports (range + status preset) per merchant.
app.get("/api/reports", core.requireSession, async (req, res) => {
  const rows = await db.q(`SELECT id, name, range, status FROM saved_reports WHERE merchant_id=$1 ORDER BY id DESC`, [req.session.merchantId]);
  res.json({ reports: rows });
});
app.post("/api/reports", core.requireSession, express.json(), async (req, res) => {
  const { name, range, status } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: "name required" });
  const [row] = await db.q(
    `INSERT INTO saved_reports (merchant_id, name, range, status) VALUES ($1,$2,$3,$4) RETURNING id`,
    [req.session.merchantId, String(name).trim().slice(0, 60), RANGES[range] ? range : "30d", status ? String(status).slice(0, 40) : null]);
  res.json({ ok: true, id: row?.id });
});
app.delete("/api/reports/:id", core.requireSession, async (req, res) => {
  await db.run(`DELETE FROM saved_reports WHERE id=$1 AND merchant_id=$2`, [req.params.id, req.session.merchantId]);
  res.json({ ok: true });
});

core.mountSpaFallback();
app.listen(PORT, HOST, () => console.log(`[enhanced-analytics] listening on ${HOST}:${PORT}`));
