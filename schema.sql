PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario TEXT UNIQUE NOT NULL,
  hash_password TEXT NOT NULL,
  rol TEXT NOT NULL CHECK (rol IN ('admin','empleado')),
  activo INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL,
  modelo TEXT,
  costo REAL NOT NULL DEFAULT 0,
  precio_lista REAL NOT NULL DEFAULT 0,
  precio_contado REAL NOT NULL DEFAULT 0,
  precio_transferencia REAL NOT NULL DEFAULT 0,
  activo INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS variants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  color TEXT,
  talle TEXT,
  sku TEXT,
  stock_actual INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL,
  cuit TEXT,
  contacto TEXT,
  notas TEXT
);

CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id INTEGER NOT NULL,
  fecha TEXT NOT NULL,
  observaciones TEXT,
  FOREIGN KEY(provider_id) REFERENCES providers(id)
);

CREATE TABLE IF NOT EXISTS purchase_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id INTEGER NOT NULL,
  variant_id INTEGER NOT NULL,
  cantidad INTEGER NOT NULL,
  costo_unitario REAL NOT NULL,
  FOREIGN KEY(purchase_id) REFERENCES purchases(id) ON DELETE CASCADE,
  FOREIGN KEY(variant_id) REFERENCES variants(id)
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL,
  apellido TEXT,
  telefono TEXT,
  dni TEXT,
  puntos INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS customer_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL UNIQUE,
  saldo_actual REAL NOT NULL DEFAULT 0,
  FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS account_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  fecha TEXT NOT NULL,
  concepto TEXT,
  debe REAL NOT NULL DEFAULT 0,
  haber REAL NOT NULL DEFAULT 0,
  ref_tipo TEXT,
  ref_id INTEGER,
  FOREIGN KEY(account_id) REFERENCES customer_accounts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fecha TEXT NOT NULL,
  customer_id INTEGER,
  user_id INTEGER NOT NULL,
  forma_pago TEXT NOT NULL CHECK (forma_pago IN ('efectivo','tarjeta','transferencia','cuenta_corriente')),
  total REAL NOT NULL,
  estado TEXT NOT NULL DEFAULT 'confirmada' CHECK (estado IN ('confirmada','cancelada')),
  observaciones TEXT,
  FOREIGN KEY(customer_id) REFERENCES customers(id),
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS sale_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id INTEGER NOT NULL,
  variant_id INTEGER NOT NULL,
  cantidad INTEGER NOT NULL,
  precio_unitario REAL NOT NULL,
  subtotal REAL NOT NULL,
  FOREIGN KEY(sale_id) REFERENCES sales(id) ON DELETE CASCADE,
  FOREIGN KEY(variant_id) REFERENCES variants(id)
);

CREATE TABLE IF NOT EXISTS cash_register (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fecha_apertura TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  monto_inicial REAL NOT NULL DEFAULT 0,
  estado TEXT NOT NULL CHECK (estado IN ('abierta','cerrada')),
  efectivo_total REAL NOT NULL DEFAULT 0,
  tarjeta_total REAL NOT NULL DEFAULT 0,
  transferencia_total REAL NOT NULL DEFAULT 0,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS cash_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cash_register_id INTEGER NOT NULL,
  fecha TEXT NOT NULL,
  tipo TEXT NOT NULL,
  medio TEXT,
  monto REAL NOT NULL,
  ref_tipo TEXT,
  ref_id INTEGER,
  descripcion TEXT,
  FOREIGN KEY(cash_register_id) REFERENCES cash_register(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fecha TEXT NOT NULL,
  user_id INTEGER,
  entidad TEXT NOT NULL,
  entidad_id INTEGER,
  accion TEXT NOT NULL,
  datos_antes TEXT,
  datos_despues TEXT,
  FOREIGN KEY(user_id) REFERENCES users(id)
);