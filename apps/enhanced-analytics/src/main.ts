import "./index.css";
import {
  initBv, makeToast, bvApi, type BvToastFn,
  mountShell, statRow, dataTable, card, emptyState, pill, flash, h, skeleton,
} from "./bv-init";

interface Totals { revenue: number; paid: number; orders: number; refunds: number; aov: number; refund_rate: number; revenue_delta: number; orders_delta: number; aov_delta: number; }
interface Day { date: string; revenue: number; orders: number; }
interface Bucket { hour?: number; dow?: number; orders: number; revenue: number; }
interface Cust { id: string; name: string; orders: number; revenue: number; isNew: boolean; }
interface StatusCount { status: string; count: number; }
interface Analytics {
  range: string; status: string | null; totals: Totals; trend: Day[]; peak_hours: Bucket[]; peak_dows: Bucket[];
  status_breakdown: StatusCount[];
  customers: { total: number; new: number; repeat: number; repeat_rate: number; top: Cust[] };
  coverage: { fetched: number; in_range: number };
}
interface CustomerRow { id: string; name: string; email: string | null; orders: number; paid_orders: number; revenue: number; aov: number; first_order: string | null; last_order: string | null; currency: string; }
interface JourneyStop { id: number; title: string; total: number; currency: string; status: string; at: string; }
interface SavedReport { id: number; name: string; range: string; status: string | null; }
interface ProductRow { name: string; units: number; revenue: number; orders: number; }

const root = document.getElementById("root")!;
let toast: BvToastFn;
let merchantName = "Merchant";
let currency = "JMD";
let range = "30d";
let statusFilter = "";
let data: Analytics | null = null;
let reports: SavedReport[] = [];
let shell: ReturnType<typeof mountShell>;
const RANGES: [string, string][] = [["7d", "7 days"], ["30d", "30 days"], ["90d", "90 days"]];
const STATUS_OPTS: [string, string][] = [["", "All statuses"], ["paid", "Paid"], ["pending", "Pending"], ["refunded", "Refunded"], ["cancelled", "Cancelled"], ["failed", "Failed"]];
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const STATUS_TONE: Record<string, string> = { paid: "ok", pending: "warning", refunded: "bad", cancelled: "", failed: "bad", processing: "primary" };

(async () => {
  let session;
  if (import.meta.env.DEV && !new URLSearchParams(location.search).has("inkress_session")) {
    const m = await import("./dev-mock"); m.installMockFetch(); session = m.mockSession();
  } else {
    try { session = await initBv(); }
    catch (err: any) { root.innerHTML = ""; root.append(fatal(err?.message)); return; }
  }
  toast = makeToast(session.inkress);
  merchantName = session.merchant.name || session.merchant.username || "Merchant";
  currency = session.merchant.currency_code || "JMD";
  loadReports();

  shell = mountShell({
    brandIcon: "chart", brandLogo: "/logo.svg",
    title: "Enhanced Analytics",
    subtitle: `${merchantName} · trends, breakdowns, customers & reports`,
    poweredBy: "Marketplace",
    tabs: [
      { id: "overview",   label: "Overview",    icon: "chart",   render: renderOverview },
      { id: "products",   label: "Products",    icon: "box",     render: renderProducts },
      { id: "peak",       label: "Peak times",  icon: "clock",   render: renderPeak },
      { id: "customers",  label: "Customers",   icon: "users",   render: renderCustomers },
    ],
  });
})();

/* ---------------------------------------------------------------- helpers */
const tzMin = () => new Date().getTimezoneOffset();
const money = (n: number) => {
  try { return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(n); }
  catch { return `${currency} ${Math.round(n)}`; }
};
const moneyCompact = (n: number) => {
  if (n >= 1_000_000) return money(n / 1_000_000).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return money(n / 1_000).replace(/\.0$/, "") + "K";
  return money(n);
};
const delta = (p: number) => `${p > 0 ? "+" : ""}${p}% vs prior period`;
const tone = (p: number): "ok" | "bad" | undefined => p > 0 ? "ok" : p < 0 ? "bad" : undefined;
const dateStr = (s?: string | null) => s ? new Date(s).toLocaleDateString() : "—";
const shortDate = (d: string) => { const t = new Date(d + "T00:00:00"); return `${t.getMonth() + 1}/${t.getDate()}`; };
const hourLabel = (h24: number) => h24 === 0 ? "12a" : h24 < 12 ? `${h24}a` : h24 === 12 ? "12p" : `${h24 - 12}p`;

async function loadReports() {
  reports = (await bvApi<{ reports: SavedReport[] }>("/api/reports").catch(() => ({ reports: [] })))?.reports || [];
}

/* ---------------------------------------------------------------- Skeletons */
function skelStats(count = 4): HTMLElement {
  const wrap = h("div", { class: "ea-skel-stats" });
  for (let i = 0; i < count; i++) {
    wrap.append(h("div", { class: "ea-skel-stat" },
      skeleton("45%", 9),
      skeleton("60%", 28),
      skeleton("50%", 9)));
  }
  return wrap;
}
function skelChart(): HTMLElement {
  const heights = [40, 60, 90, 70, 110, 80, 130, 100, 75, 90, 60, 50];
  return h("div", { class: "ea-skel-card" },
    skeleton("32%", 10),
    h("div", { class: "ea-skel-chart" },
      ...heights.map((pct) => {
        const b = h("div", { class: "ea-skel-bar" });
        b.style.height = `${pct}%`;
        b.style.animationDelay = `${Math.random() * 0.4}s`;
        return b;
      })));
}
function skelTable(rows = 5, cols = 4): HTMLElement {
  return h("div", { class: "ea-skel-card" },
    skeleton("28%", 10),
    h("div", { class: "ea-skel-rows" },
      ...Array.from({ length: rows }, () =>
        h("div", { class: "ea-skel-row" },
          ...Array.from({ length: cols }, () => skeleton(`${50 + Math.random() * 40}%`, 9))))));
}

/* ---------------------------------------------------------------- Controls bar */
function controls(tab: string): HTMLElement {
  const ranges = h("div", { class: "ea-ranges" },
    ...RANGES.map(([v, l]) =>
      h("button", { class: "ea-range" + (range === v ? " is-on" : ""), onClick: () => { range = v; shell.select(tab); } }, l)));

  const status = h("select", { class: "ea-select" },
    ...STATUS_OPTS.map(([v, l]) =>
      h("option", { value: v, ...(statusFilter === v ? { selected: true } : {}) }, l))) as HTMLSelectElement;
  status.addEventListener("change", () => { statusFilter = status.value; shell.select(tab); });

  const save = h("button", { class: "ea-save", onClick: async () => {
    const name = prompt("Name this saved view:");
    if (!name?.trim()) return;
    const r = await bvApi<{ ok?: boolean; error?: string }>(
      "/api/reports",
      { method: "POST", body: JSON.stringify({ name: name.trim(), range, status: statusFilter || null }) }
    ).catch((e: any): { ok?: boolean; error?: string } => ({ error: e?.message }));
    if (r?.ok) { flash("View saved", "success"); await loadReports(); shell.select(tab); }
    else flash(r?.error || "Couldn't save", "error");
  } }, "Save view");

  const chips = reports.map((rep) => {
    const label = `${rep.name} · ${rep.range}${rep.status ? " · " + rep.status : ""}`;
    return h("span", { class: "ea-chip" },
      h("button", { class: "ea-chip-apply", title: label, onClick: () => {
        range = RANGES.some(([v]) => v === rep.range) ? rep.range : "30d";
        statusFilter = rep.status || "";
        shell.select(tab);
      } }, label),
      h("button", { class: "ea-chip-x", title: "Remove saved view", "aria-label": "Remove", onClick: async () => {
        await bvApi(`/api/reports/${rep.id}`, { method: "DELETE" }).catch(() => {});
        await loadReports();
        shell.select(tab);
      } }, "×"));
  });

  const chipsRow = chips.length
    ? h("div", { class: "ea-chips" }, ...chips)
    : null;

  return h("div", { class: "ea-controls" },
    h("div", { class: "ea-bar-controls" }, ranges, h("span", { class: "ea-spacer" }), status, save),
    chipsRow);
}

/* ---------------------------------------------------------------- load helper (with skeleton) */
async function load(host: HTMLElement, skelFn: () => HTMLElement): Promise<Analytics | null> {
  const skel = skelFn();
  host.append(skel);
  const q = `/api/analytics?range=${range}&tz=${tzMin()}${statusFilter ? `&status=${encodeURIComponent(statusFilter)}` : ""}`;
  const r = await bvApi<Analytics>(q).catch(() => null);
  skel.remove();
  data = r;
  return r;
}

/* ================================================================ Overview */
async function renderOverview(host: HTMLElement) {
  host.append(controls("overview"));

  // Skeleton while loading
  host.append(skelStats(4));
  host.append(skelChart());
  host.append(skelTable(4, 3));

  const q = `/api/analytics?range=${range}&tz=${tzMin()}${statusFilter ? `&status=${encodeURIComponent(statusFilter)}` : ""}`;
  const d = await bvApi<Analytics>(q).catch(() => null);
  data = d;

  // Remove skeletons
  while (host.children.length > 1) host.lastElementChild!.remove();

  if (!d) { host.append(unavailable()); return; }
  const t = d.totals;

  if (d.status) {
    host.append(h("div", { class: "ea-activefilter" },
      "Showing:", pill(d.status, STATUS_TONE[d.status] || "")));
  }

  host.append(statRow([
    { k: "Revenue",     v: money(t.revenue), d: delta(t.revenue_delta), tone: tone(t.revenue_delta), icon: "cash" },
    { k: "Paid orders", v: String(t.paid),   d: delta(t.orders_delta),  tone: tone(t.orders_delta),  icon: "receipt" },
    { k: "Avg order",   v: money(t.aov),     d: delta(t.aov_delta),     tone: tone(t.aov_delta),     icon: "tag" },
    { k: "Refund rate", v: `${t.refund_rate}%`, icon: "alert", tone: t.refund_rate >= 5 ? "bad" : undefined },
  ]));

  host.append(card({
    title: "Revenue trend",
    body: barChart(
      d.trend.map((x) => ({ label: shortDate(x.date), value: x.revenue, sub: `${x.orders} order${x.orders !== 1 ? "s" : ""}` })),
      { yAxisFmt: moneyCompact }
    ),
  }));

  const sb = d.status_breakdown || [];
  const tot = sb.reduce((s, x) => s + x.count, 0);
  host.append(card({
    title: "Order status breakdown",
    body: sb.length
      ? h("div", { class: "ea-breakdown" },
          ...sb.map((x) => {
            const pct = tot ? Math.round((x.count / tot) * 100) : 0;
            const fill = h("div", { class: "ea-bd-fill" });
            fill.dataset["status"] = x.status;
            fill.style.width = `${pct}%`;
            return h("div", { class: "ea-bd-row" },
              h("span", null, pill(x.status, STATUS_TONE[x.status] || "")),
              h("div", { class: "ea-bd-track" }, fill),
              h("span", { class: "ea-bd-n" }, `${x.count} · ${pct}%`));
          }))
      : emptyState({ icon: "chart", title: "No orders in range", text: "Order statuses will appear here once orders come in." }),
  }));
}

/* ================================================================ Products */
async function renderProducts(host: HTMLElement) {
  host.append(controls("products"));
  host.append(skelStats(3));
  host.append(skelChart());
  host.append(skelTable(6, 5));

  const r = await bvApi<{ products: ProductRow[]; orders_covered: number; capped: boolean }>(
    `/api/products?range=${range}`
  ).catch(() => null);

  while (host.children.length > 1) host.lastElementChild!.remove();

  if (!r) { host.append(unavailable()); return; }
  const list = r.products || [];
  const totalRev = list.reduce((s, p) => s + p.revenue, 0);
  const totalUnits = list.reduce((s, p) => s + p.units, 0);

  host.append(statRow([
    { k: "Products sold", v: String(list.length),    icon: "box",     tone: "accent" },
    { k: "Units",         v: String(totalUnits),      icon: "package" },
    { k: "From orders",   v: String(r.orders_covered), icon: "receipt" },
  ]));

  host.append(card({
    title: "Top products by revenue",
    body: barChart(
      list.slice(0, 14).map((p) => ({ label: p.name, value: p.revenue, sub: `${p.units} unit${p.units !== 1 ? "s" : ""}` })),
      { yAxisFmt: moneyCompact, barClass: "is-product" }
    ),
  }));

  host.append(card({
    title: "All products",
    body: dataTable<ProductRow>({
      columns: [
        { head: "Product",  cell: (p) => h("span", { style: { fontWeight: "600" } }, p.name) },
        { head: "Units",    num: true, cell: (p) => String(p.units) },
        { head: "Orders",   num: true, cell: (p) => String(p.orders) },
        { head: "Revenue",  num: true, cell: (p) => money(p.revenue) },
        { head: "Share",    num: true, cell: (p) => `${totalRev ? Math.round((p.revenue / totalRev) * 100) : 0}%` },
      ],
      rows: list,
      empty: emptyState({ icon: "box", title: "No product sales yet", text: "Paid orders with line items will break down by product here." }),
    }),
  }));

  if (r.capped) {
    host.append(h("p", { class: "bv-muted", style: { fontSize: "0.75rem", padding: "4px 2px" } },
      "Showing the most recent line items — older orders in this range may not be fully represented."));
  }
}

/* ================================================================ Peak times */
async function renderPeak(host: HTMLElement) {
  host.append(controls("peak"));
  host.append(skelStats(2));
  host.append(skelChart());
  host.append(skelChart());

  const q = `/api/analytics?range=${range}&tz=${tzMin()}${statusFilter ? `&status=${encodeURIComponent(statusFilter)}` : ""}`;
  const d = await bvApi<Analytics>(q).catch(() => null);
  data = d;

  while (host.children.length > 1) host.lastElementChild!.remove();

  if (!d) { host.append(unavailable()); return; }

  const topHour = [...d.peak_hours].sort((a, b) => b.orders - a.orders)[0];
  const topDow  = [...d.peak_dows].sort((a, b) => b.orders - a.orders)[0];

  host.append(statRow([
    {
      k: "Busiest hour", icon: "clock", tone: "accent",
      v: topHour?.orders ? hourLabel(topHour.hour!) : "—",
      d: topHour?.orders ? `${topHour.orders} order${topHour.orders !== 1 ? "s" : ""}` : "no data yet",
    },
    {
      k: "Busiest day",  icon: "calendar",
      v: topDow?.orders ? DOW[topDow.dow!]! : "—",
      d: topDow?.orders  ? `${topDow.orders} order${topDow.orders !== 1 ? "s" : ""}`  : "no data yet",
    },
  ]));

  host.append(card({
    title: "Orders by hour of day",
    body: barChart(
      d.peak_hours.map((b) => ({
        label: b.hour! % 3 === 0 ? hourLabel(b.hour!) : "",
        value: b.orders,
        sub: moneyCompact(b.revenue),
      }))
    ),
  }));

  host.append(card({
    title: "Orders by day of week",
    body: barChart(
      d.peak_dows.map((b) => ({ label: DOW[b.dow!]!, value: b.orders, sub: moneyCompact(b.revenue) }))
    ),
  }));
}

/* ================================================================ Customers */
async function renderCustomers(host: HTMLElement) {
  host.append(controls("customers"));
  host.append(skelStats(4));
  host.append(skelTable(8, 5));

  const [a, cl] = await Promise.all([
    bvApi<Analytics>(`/api/analytics?range=${range}&tz=${tzMin()}`).catch(() => null),
    bvApi<{ customers: CustomerRow[] }>(`/api/customers?range=${range}`).catch(() => ({ customers: [] })),
  ]);

  while (host.children.length > 1) host.lastElementChild!.remove();

  const c    = a?.customers;
  const list = cl?.customers || [];

  host.append(statRow([
    { k: "Customers",   v: String(c?.total ?? list.length),   icon: "users",    tone: "accent" },
    { k: "New",         v: String(c?.new ?? 0),               icon: "sparkles" },
    { k: "Returning",   v: String(c?.repeat ?? 0),            icon: "heart" },
    { k: "Repeat rate", v: `${c?.repeat_rate ?? 0}%`,         icon: "chart",    tone: (c?.repeat_rate ?? 0) >= 30 ? "ok" : undefined },
  ]));

  host.append(card({
    title: "Customer directory — lifetime value",
    body: dataTable<CustomerRow>({
      columns: [
        {
          head: "Customer",
          cell: (x) => h("div", null,
            h("span", { class: "ea-cust-name" }, x.name),
            x.email ? h("span", { class: "ea-cust-email" }, x.email) : null),
        },
        { head: "Orders", num: true, cell: (x) => String(x.orders) },
        { head: "LTV",    num: true, cell: (x) => money(x.revenue) },
        { head: "AOV",    num: true, cell: (x) => money(x.aov) },
        { head: "Last order", cell: (x) => dateStr(x.last_order) },
      ],
      rows: list,
      rowActions: (x) => h("button", { class: "ea-journey-btn", onClick: () => openJourney(x) }, "Journey"),
      empty: emptyState({ icon: "users", title: "No customers in range", text: "Once you have orders, your customer directory and journeys appear here." }),
    }),
  }));
}

/* ================================================================ Journey modal */
function openJourney(c: CustomerRow) {
  const body = h("div", { class: "bv-muted", style: { padding: "8px 0" } },
    skeleton("100%", 14), h("div", { style: { height: "8px" } }), skeleton("80%", 10));

  openModal({ title: c.name, body });

  bvApi<{ customer: CustomerRow; timeline: JourneyStop[] }>(
    `/api/customer/${encodeURIComponent(c.id)}?range=${range}`
  ).then(({ customer, timeline }) => {
    // Replace the loading body
    const hero = h("div", { class: "ea-journey-hero" },
      h("div", { class: "ea-journey-stat is-accent" },
        h("div", { class: "k" }, "Lifetime value"),
        h("div", { class: "v" }, money(customer.revenue))),
      h("div", { class: "ea-journey-stat" },
        h("div", { class: "k" }, "Orders"),
        h("div", { class: "v" }, String(customer.orders))),
      h("div", { class: "ea-journey-stat" },
        h("div", { class: "k" }, "Avg order"),
        h("div", { class: "v" }, money(customer.aov))));

    const meta = h("div", { class: "ea-journey-meta" },
      customer.email ? h("span", null, customer.email) : null,
      customer.first_order ? h("span", null, "First: ", dateStr(customer.first_order)) : null,
      customer.last_order  ? h("span", null, "Last: ",  dateStr(customer.last_order))  : null);

    const tl = h("div", null,
      h("div", { class: "ea-timeline-title" }, "Order history"),
      dataTable<JourneyStop>({
        columns: [
          { head: "Date",    cell: (s) => new Date(s.at).toLocaleDateString() },
          { head: "Order",   cell: (s) => h("span", { style: { fontWeight: "600" } }, s.title) },
          { head: "Status",  cell: (s) => pill(s.status, STATUS_TONE[s.status] || "") },
          { head: "Total",   num: true, cell: (s) => money(s.total) },
        ],
        rows: timeline,
        empty: emptyState({ icon: "receipt", title: "No orders", text: "No orders for this customer in range." }),
      }));

    body.replaceChildren(hero, meta, tl);
  }).catch((e: any) => {
    body.replaceChildren(
      emptyState({ icon: "alert", title: "Couldn't load journey", text: e?.message || "Please try again." }));
  });
}

/* ================================================================ Bar charts */
interface BarChartOpts {
  yAxisFmt?: (n: number) => string;
  barClass?: string;
}

function barChart(bars: { label: string; value: number; sub?: string }[], opts: BarChartOpts = {}): HTMLElement {
  const max = Math.max(1, ...bars.map((b) => b.value));
  const allZero = bars.every((b) => !b.value);

  if (!bars.length || allZero) {
    return emptyState({ icon: "chart", title: "No data yet", text: "No paid orders in this range." });
  }

  const fmt = opts.yAxisFmt ?? String;
  const steps = 4; // y-axis steps (0, 25%, 50%, 75%, 100%)

  // Y-axis labels (top to bottom: max -> 0)
  const yLabels = Array.from({ length: steps + 1 }, (_, i) => fmt(Math.round((max * (steps - i)) / steps)));

  const gridlines = h("div", { class: "ea-gridlines" },
    ...Array.from({ length: steps + 1 }, () => h("div", { class: "ea-gridline" })));

  const colEls = bars.map((b) => {
    const heightPct = max ? Math.round((b.value / max) * 100) : 0;
    const fill = h("div", { class: "ea-bar-fill" + (opts.barClass ? " " + opts.barClass : "") });
    fill.style.height = `${heightPct}%`;

    const valEl = h("div", { class: "ea-bar-val" }, fmt(b.value));

    const tip = h("div", { class: "ea-bar-tip" },
      fmt(b.value),
      b.sub ? h("span", { class: "ea-tip-sub" }, b.sub) : null);

    const col = h("div", { class: "ea-bar-col", title: `${fmt(b.value)}${b.sub ? " · " + b.sub : ""}` },
      tip, valEl, fill,
      h("div", { class: "ea-bar-label" }, b.label));
    return col;
  });

  const barsEl = h("div", { class: "ea-bars" }, ...colEls);
  const baseline = h("div", { class: "ea-baseline" });

  // Y-axis column
  const yaxisEl = h("div", { class: "ea-yaxis" },
    ...yLabels.map((l) => h("div", { class: "ea-ylabel" }, l)));

  const inner = h("div", { class: "ea-chart-inner" },
    gridlines,
    h("div", { class: "ea-bars-area has-yaxis" }, barsEl));

  return h("div", { class: "ea-chart-wrap" },
    yaxisEl,
    inner,
    baseline);
}

/* ================================================================ Shared helpers */
function openModal(opts: { title: string; body: Node; onClose?: () => void }): { close: () => void } {
  const scrim = h("div", { class: "bv-scrim" });
  const close = () => { scrim.remove(); opts.onClose?.(); };
  scrim.addEventListener("click", (e) => { if (e.target === scrim) close(); });
  const modalEl = h("div", { class: "bv-modal" },
    h("div", { class: "bv-modal-head" },
      h("h2", null, opts.title),
      h("button", { class: "ghost icon", "aria-label": "Close", onClick: close },
        h("span", { html: "×", style: { fontSize: "1.25rem", lineHeight: "1" } }))),
    h("div", { class: "bv-modal-body" }, opts.body));
  scrim.append(modalEl);
  document.body.append(scrim);
  return { close };
}

function unavailable(): HTMLElement {
  return emptyState({
    icon: "alert",
    title: "Analytics unavailable",
    text: "We couldn't load your data right now. Check your connection and try again.",
    action: h("button", { class: "secondary", onClick: () => location.reload() }, "Retry"),
  });
}

function fatal(msg?: string): HTMLElement {
  return h("div", { class: "bv-fatal" },
    h("div", { class: "box" },
      h("div", { class: "ic", html: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="10" cy="10" r="8"/><path d="M10 7v4M10 13h.01"/></svg>` }),
      h("h2", null, "Couldn't start"),
      h("p", { class: "bv-muted" }, msg || "Unable to initialize the app.")));
}
