const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || "";

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "3mb" }));

app.get("/", (req, res, next) => {
  try {
    const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
    const logo = fs.readFileSync(path.join(__dirname, "hero-logo.txt"), "utf8").trim();
    const imageBlock = `<img class="hero-image" src="${logo}" alt="ScaldaseBeta 3D">`;
    const watermark = `<style>.hero-image{width:78%;height:78%;object-fit:contain;border-radius:14px;position:relative;z-index:1;filter:drop-shadow(0 18px 35px rgba(0,0,0,.45))}.hero-art .badge{z-index:2}body:after{content:"";position:fixed;inset:0;z-index:-1;opacity:.045;background:url("${logo}") center 58%/520px auto no-repeat;pointer-events:none}</style>`;
    const output = html.replace("</head>", watermark + "</head>").replace('<div class="hero-art"><div class="badge">', `<div class="hero-art">${imageBlock}<div class="badge">`);
    res.type("html").send(output);
  } catch (error) { next(error); }
});
app.get("/admin", (req, res, next) => { try { res.sendFile(path.join(__dirname, "admin.html")); } catch (error) { next(error); } });
app.use(express.static(__dirname));

const sessions = new Map();
const SESSION_MS = 1000 * 60 * 60 * 8;
const ADMIN_USER = process.env.ADMIN_USER || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const MBWAY_PAYMENT_URL = process.env.MBWAY_PAYMENT_URL || "";
const PAYPAL_PAYMENT_URL = process.env.PAYPAL_PAYMENT_URL || "";

function getCookie(req, name) {
  const header = req.headers.cookie || "";
  const match = header.split(";").map(v => v.trim()).find(v => v.startsWith(name + "="));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}
function createSession(username) { const token = crypto.randomBytes(32).toString("hex"); sessions.set(token, { username, expires: Date.now() + SESSION_MS }); return token; }
function requireAdmin(req, res, next) { const token = getCookie(req, "scaldase_session"); const session = token && sessions.get(token); if (!session || session.expires < Date.now()) { if (token) sessions.delete(token); return res.status(401).json({ error: "Não autenticado" }); } req.admin = session; next(); }
function id() { return crypto.randomUUID(); }

async function supabase(table, { method = "GET", query = "", body, prefer = "return=representation" } = {}) {
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) throw new Error("Supabase não configurado no servidor.");
  const headers = { apikey: SUPABASE_SECRET_KEY, Authorization: `Bearer ${SUPABASE_SECRET_KEY}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (prefer) headers.Prefer = prefer;
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  if (!response.ok) throw new Error(typeof data === "object" && data?.message ? data.message : `Supabase: erro ${response.status}`);
  return data;
}
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.get("/api/config", (req, res) => res.json({ mbway_payment_url: MBWAY_PAYMENT_URL, paypal_payment_url: PAYPAL_PAYMENT_URL, mbway_ready: Boolean(MBWAY_PAYMENT_URL), paypal_ready: Boolean(PAYPAL_PAYMENT_URL) }));
app.post("/api/auth/login", (req, res) => { if (!ADMIN_USER || !ADMIN_PASSWORD) return res.status(503).json({ error: "O administrador ainda não foi configurado no servidor." }); const { username, password } = req.body || {}; if (username !== ADMIN_USER || password !== ADMIN_PASSWORD) return res.status(401).json({ error: "Utilizador ou palavra-passe incorretos." }); const token = createSession(username); res.setHeader("Set-Cookie", `scaldase_session=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=${SESSION_MS / 1000}`); res.json({ ok: true, username }); });
app.post("/api/auth/logout", (req, res) => { const token = getCookie(req, "scaldase_session"); if (token) sessions.delete(token); res.setHeader("Set-Cookie", "scaldase_session=; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=0"); res.json({ ok: true }); });
app.get("/api/auth/me", requireAdmin, (req, res) => res.json({ ok: true, username: req.admin.username }));

app.get("/api/products", asyncRoute(async (req, res) => res.json(await supabase("products", { query: "?select=*&order=created_at.desc" }))));
app.post("/api/products", requireAdmin, asyncRoute(async (req, res) => {
  const product = { id: id(), name: String(req.body.name || "").trim(), description: String(req.body.description || "").trim(), price: Number(req.body.price || 0), stock: Number.isFinite(Number(req.body.stock)) ? Number(req.body.stock) : 0, status: ["available", "maintenance", "unavailable"].includes(req.body.status) ? req.body.status : "available", image: String(req.body.image || "").trim() };
  if (!product.name) return res.status(400).json({ error: "Nome do produto é obrigatório." });
  if (product.image) {
    let images = [product.image];
    try { const parsed = JSON.parse(product.image); if (Array.isArray(parsed)) images = parsed; } catch {}
    if (images.length > 4 || images.some(img => typeof img !== "string" || (!/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(img) && !/^https?:\/\//i.test(img)))) return res.status(400).json({ error: "As fotografias devem ser imagens válidas (máximo 4)." });
  }
  const rows = await supabase("products", { method: "POST", body: product }); res.status(201).json(rows[0]);
}));
app.put("/api/products/:id", requireAdmin, asyncRoute(async (req, res) => {
  const allowed = ["name","description","price","stock","status","image"]; const patch = {};
  for (const k of allowed) if (Object.prototype.hasOwnProperty.call(req.body || {}, k)) patch[k] = req.body[k];
  if ("price" in patch) patch.price = Number(patch.price || 0); if ("stock" in patch) patch.stock = Number(patch.stock || 0);
  const rows = await supabase("products", { method: "PATCH", query: `?id=eq.${encodeURIComponent(req.params.id)}`, body: patch });
  if (!rows.length) return res.sendStatus(404); res.json(rows[0]);
}));
app.delete("/api/products/:id", requireAdmin, asyncRoute(async (req, res) => { await supabase("products", { method: "DELETE", query: `?id=eq.${encodeURIComponent(req.params.id)}`, prefer: "" }); res.sendStatus(204); }));

app.get("/api/orders", requireAdmin, asyncRoute(async (req, res) => res.json(await supabase("orders", { query: "?select=*&order=created_at.desc" }))));
app.post("/api/orders", asyncRoute(async (req, res) => {
  const order = { id: id(), customer_name: String(req.body.customer_name || "").trim(), phone: String(req.body.phone || "").trim(), email: String(req.body.email || "").trim(), items: Array.isArray(req.body.items) ? req.body.items : [], shipping: Number(req.body.shipping || 0), total: Number(req.body.total || 0), payment_method: String(req.body.payment_method || "pending"), payment_status: ["pending","paid","cancelled"].includes(req.body.payment_status) ? req.body.payment_status : "pending", order_status: ["new","preparing","shipped","completed","cancelled"].includes(req.body.order_status) ? req.body.order_status : "new", created_at: new Date().toISOString() };
  if (!order.customer_name) return res.status(400).json({ error: "Nome do cliente é obrigatório." });
  const rows = await supabase("orders", { method: "POST", body: order });
  if (order.email) {
    const found = await supabase("customers", { query: `?select=id&email=eq.${encodeURIComponent(order.email)}&limit=1` });
    if (!found.length) await supabase("customers", { method: "POST", body: { id: id(), name: order.customer_name, phone: order.phone, email: order.email, created_at: new Date().toISOString() } });
  }
  res.status(201).json(rows[0]);
}));
app.put("/api/orders/:id", requireAdmin, asyncRoute(async (req, res) => {
  const allowed = ["customer_name","phone","email","items","shipping","total","payment_method","payment_status","order_status"]; const patch = {};
  for (const k of allowed) if (Object.prototype.hasOwnProperty.call(req.body || {}, k)) patch[k] = req.body[k];
  const rows = await supabase("orders", { method: "PATCH", query: `?id=eq.${encodeURIComponent(req.params.id)}`, body: patch });
  if (!rows.length) return res.sendStatus(404); res.json(rows[0]);
}));
app.get("/api/customers", requireAdmin, asyncRoute(async (req, res) => res.json(await supabase("customers", { query: "?select=*&order=created_at.desc" }))));

app.get("/api/dashboard", requireAdmin, asyncRoute(async (req, res) => {
  const [products, orders, customers] = await Promise.all([supabase("products", { query: "?select=*" }), supabase("orders", { query: "?select=*" }), supabase("customers", { query: "?select=*" })]);
  res.json({ products: products.length, low_stock: products.filter(p => Number(p.stock) <= 2 && p.status === "available").length, orders: orders.length, pending_orders: orders.filter(o => o.order_status === "new" || o.order_status === "preparing").length, pending_payments: orders.filter(o => o.payment_status === "pending").length, customers: customers.length, revenue_paid: orders.filter(o => o.payment_status === "paid").reduce((sum, o) => sum + Number(o.total || 0), 0) });
}));
app.get("/api/health", asyncRoute(async (req, res) => { await supabase("products", { query: "?select=id&limit=1" }); res.json({ ok: true, service: "ScaldaseBeta 3D API", database: "supabase" }); }));

app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: err.message || "Erro interno do servidor." }); });
app.listen(PORT, () => console.log(`ScaldaseBeta API pronta na porta ${PORT}`));
