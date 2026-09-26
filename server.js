const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "data.json");

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "1mb" }));
app.use(express.static(__dirname));

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch (error) {
    console.error("Erro a ler data.json:", error.message);
  }
  return { products: [], orders: [], customers: [] };
}

let db = loadData();
function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), "utf8");
}

const sessions = new Map();
const SESSION_MS = 1000 * 60 * 60 * 8;

const ADMIN_USER = process.env.ADMIN_USER || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";

function getCookie(req, name) {
  const header = req.headers.cookie || "";
  const match = header.split(";").map(v => v.trim()).find(v => v.startsWith(name + "="));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

function createSession(username) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { username, expires: Date.now() + SESSION_MS });
  return token;
}

function requireAdmin(req, res, next) {
  const token = getCookie(req, "scaldase_session");
  const session = token && sessions.get(token);
  if (!session || session.expires < Date.now()) {
    if (token) sessions.delete(token);
    return res.status(401).json({ error: "Não autenticado" });
  }
  req.admin = session;
  next();
}

function id() {
  return crypto.randomUUID();
}

app.post("/api/auth/login", (req, res) => {
  if (!ADMIN_USER || !ADMIN_PASSWORD) {
    return res.status(503).json({ error: "O administrador ainda não foi configurado no servidor." });
  }
  const { username, password } = req.body || {};
  if (username !== ADMIN_USER || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Utilizador ou palavra-passe incorretos." });
  }
  const token = createSession(username);
  res.setHeader("Set-Cookie", `scaldase_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MS / 1000}`);
  res.json({ ok: true, username });
});

app.post("/api/auth/logout", (req, res) => {
  const token = getCookie(req, "scaldase_session");
  if (token) sessions.delete(token);
  res.setHeader("Set-Cookie", "scaldase_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
  res.json({ ok: true });
});

app.get("/api/auth/me", requireAdmin, (req, res) => res.json({ ok: true, username: req.admin.username }));

app.get("/api/products", (req, res) => res.json(db.products));
app.post("/api/products", requireAdmin, (req, res) => {
  const product = {
    id: id(),
    name: String(req.body.name || "").trim(),
    description: String(req.body.description || "").trim(),
    price: Number(req.body.price || 0),
    stock: Number.isFinite(Number(req.body.stock)) ? Number(req.body.stock) : 0,
    status: ["available", "maintenance", "unavailable"].includes(req.body.status) ? req.body.status : "available",
    image: String(req.body.image || "").trim()
  };
  if (!product.name) return res.status(400).json({ error: "Nome do produto é obrigatório." });
  db.products.push(product); saveData(); res.status(201).json(product);
});
app.put("/api/products/:id", requireAdmin, (req, res) => {
  const index = db.products.findIndex(p => p.id === req.params.id);
  if (index < 0) return res.sendStatus(404);
  db.products[index] = { ...db.products[index], ...req.body, id: db.products[index].id };
  saveData(); res.json(db.products[index]);
});
app.delete("/api/products/:id", requireAdmin, (req, res) => {
  const before = db.products.length;
  db.products = db.products.filter(p => p.id !== req.params.id);
  if (db.products.length === before) return res.sendStatus(404);
  saveData(); res.sendStatus(204);
});

app.get("/api/orders", requireAdmin, (req, res) => res.json(db.orders));
app.post("/api/orders", (req, res) => {
  const order = {
    id: id(),
    customer_name: String(req.body.customer_name || "").trim(),
    phone: String(req.body.phone || "").trim(),
    email: String(req.body.email || "").trim(),
    items: Array.isArray(req.body.items) ? req.body.items : [],
    shipping: Number(req.body.shipping || 0),
    total: Number(req.body.total || 0),
    payment_method: String(req.body.payment_method || "pending"),
    payment_status: ["pending", "paid", "cancelled"].includes(req.body.payment_status) ? req.body.payment_status : "pending",
    order_status: ["new", "preparing", "shipped", "completed", "cancelled"].includes(req.body.order_status) ? req.body.order_status : "new",
    created_at: new Date().toISOString()
  };
  if (!order.customer_name) return res.status(400).json({ error: "Nome do cliente é obrigatório." });
  db.orders.push(order);
  const existing = db.customers.find(c => c.email && c.email === order.email && order.email);
  if (!existing) db.customers.push({ id: id(), name: order.customer_name, phone: order.phone, email: order.email, created_at: new Date().toISOString() });
  saveData();
  res.status(201).json(order);
});
app.put("/api/orders/:id", requireAdmin, (req, res) => {
  const index = db.orders.findIndex(o => o.id === req.params.id);
  if (index < 0) return res.sendStatus(404);
  db.orders[index] = { ...db.orders[index], ...req.body, id: db.orders[index].id };
  saveData(); res.json(db.orders[index]);
});

app.get("/api/customers", requireAdmin, (req, res) => res.json(db.customers));

app.get("/api/dashboard", requireAdmin, (req, res) => {
  res.json({
    products: db.products.length,
    low_stock: db.products.filter(p => Number(p.stock) <= 2 && p.status === "available").length,
    orders: db.orders.length,
    pending_orders: db.orders.filter(o => o.order_status === "new" || o.order_status === "preparing").length,
    pending_payments: db.orders.filter(o => o.payment_status === "pending").length,
    customers: db.customers.length,
    revenue_paid: db.orders.filter(o => o.payment_status === "paid").reduce((sum, o) => sum + Number(o.total || 0), 0)
  });
});

app.get("/api/health", (req, res) => res.json({ ok: true, service: "ScaldaseBeta 3D API" }));

app.listen(PORT, () => console.log(`ScaldaseBeta API pronta na porta ${PORT}`));
