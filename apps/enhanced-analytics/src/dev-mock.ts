/** DEV-ONLY preview harness — tree-shaken from prod. */
import type { BvSession } from "./bv-init";

export function installMockFetch() {
  window.fetch = async (input: any, init: any = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const u = new URL(url, location.origin);
    const json = (d: any) => new Response(JSON.stringify(d), { status: 200, headers: { "Content-Type": "application/json" } });
    await new Promise((r) => setTimeout(r, 90));

    if (u.pathname === "/api/analytics") {
      const days = u.searchParams.get("range") === "7d" ? 7 : u.searchParams.get("range") === "90d" ? 90 : 30;
      const trend = Array.from({ length: Math.min(days, 30) }, (_, i) => {
        const d = new Date(Date.now() - (Math.min(days, 30) - 1 - i) * 86400000);
        return { date: d.toISOString().slice(0, 10), revenue: Math.round(4000 + Math.random() * 9000), orders: Math.round(6 + Math.random() * 22) };
      });
      const peak_hours = Array.from({ length: 24 }, (_, h) => {
        const w = (h >= 11 && h <= 14) || (h >= 17 && h <= 20) ? 3 : h < 7 ? 0.1 : 1;
        const o = Math.round(Math.random() * 12 * w);
        return { hour: h, orders: o, revenue: o * Math.round(800 + Math.random() * 400) };
      });
      const peak_dows = Array.from({ length: 7 }, (_, d) => {
        const w = d === 5 || d === 6 ? 2.4 : 1;
        const o = Math.round(20 + Math.random() * 40 * w);
        return { dow: d, orders: o, revenue: o * Math.round(900 + Math.random() * 300) };
      });
      return json({
        range: u.searchParams.get("range") || "30d",
        totals: { revenue: 184500, paid: 412, orders: 448, refunds: 9, aov: 448, refund_rate: 2, revenue_delta: 14, orders_delta: 9, aov_delta: 4 },
        trend, peak_hours, peak_dows,
        customers: {
          total: 268, new: 91, repeat: 177, repeat_rate: 66,
          top: [
            { id: "1", name: "Maya Brown", orders: 14, revenue: 38200, isNew: false },
            { id: "2", name: "Devon Clarke", orders: 9, revenue: 21750, isNew: false },
            { id: "3", name: "Tanya Reid", orders: 6, revenue: 14900, isNew: true },
            { id: "4", name: "Omar Smith", orders: 5, revenue: 11200, isNew: false },
            { id: "5", name: "Kris Allen", orders: 4, revenue: 8800, isNew: true },
          ],
        },
        coverage: { fetched: 600, in_range: 448 },
      });
    }
    return new Response("{}", { status: 404 });
  };
}

export function mockSession(): BvSession {
  return {
    inkress: { notify: ({ message }: any) => console.log("[toast]", message) } as any,
    merchant: { id: 183, username: "bookerva-jackjack", name: "Jack Jack Barbershop", currency_code: "USD", email: "jack@example.com", logo: null },
    user: { id: 90, name: "Front Desk", email: "desk@jackjack.com" },
    scopes: ["orders:read"],
  };
}
