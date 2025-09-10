const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');


const DB_PATH = path.join(process.cwd(), 'data.sqlite');
const SCHEMA_PATH = path.join(process.cwd(), 'db', 'schema.sql');
const BACKUP_DIR = path.join(process.cwd(), 'backups');


let db;

function nowISO() { return new Date().toISOString(); }

async function init() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
  db = new Database(DB_PATH);
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(schema);
}

async function seed() {
  const uCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  if (uCount === 0) {
    const hashAdmin = bcrypt.hashSync('admin123', 10);
    const hashEmp = bcrypt.hashSync('empleado123', 10);
    db.prepare('INSERT INTO users(usuario, hash_password, rol) VALUES (?,?,?)').run('admin', hashAdmin, 'admin');
    db.prepare('INSERT INTO users(usuario, hash_password, rol) VALUES (?,?,?)').run('empleado', hashEmp, 'empleado');
  }
}

function authLogin(usuario, password) {
  const u = db.prepare('SELECT * FROM users WHERE usuario=? AND activo=1').get(usuario);
  if (!u) return { ok: false, error: 'Usuario no encontrado' };
  const ok = bcrypt.compareSync(password, u.hash_password);
  if (!ok) return { ok: false, error: 'Contraseña incorrecta' };
  return { ok: true, user: { id: u.id, usuario: u.usuario, rol: u.rol } };
}

// -------- Productos y Variantes --------
function productsList() {
  return db.prepare('SELECT * FROM products WHERE activo=1 ORDER BY id DESC').all();
}
function productCreate(p) {
  const stmt = db.prepare(`INSERT INTO products(nombre,modelo,costo,precio_lista,precio_contado,precio_transferencia,activo) VALUES (?,?,?,?,?,?,1)`);
  const info = stmt.run(p.nombre, p.modelo || null, p.costo||0, p.precio_lista||0, p.precio_contado||0, p.precio_transferencia||0);
  audit('products', info.lastInsertRowid, 'create', null, JSON.stringify(p), p.user_id);
  return { id: info.lastInsertRowid };
}
function variantsListByProduct(productId) {
  return db.prepare('SELECT * FROM variants WHERE product_id=? ORDER BY id DESC').all(productId);
}
function variantCreate(v) {
  const stmt = db.prepare(`INSERT INTO variants(product_id,color,talle,sku,stock_actual) VALUES (?,?,?,?,?)`);
  const info = stmt.run(v.product_id, v.color||null, v.talle||null, v.sku||null, v.stock_actual||0);
  audit('variants', info.lastInsertRowid, 'create', null, JSON.stringify(v), v.user_id);
  return { id: info.lastInsertRowid };
}

// -------- Proveedores y Compras --------
function providersList() { return db.prepare('SELECT * FROM providers ORDER BY id DESC').all(); }
function providerCreate(p) {
  const info = db.prepare('INSERT INTO providers(nombre,cuit,contacto,notas) VALUES (?,?,?,?)').run(p.nombre, p.cuit||null, p.contacto||null, p.notas||null);
  audit('providers', info.lastInsertRowid, 'create', null, JSON.stringify(p), p.user_id);
  return { id: info.lastInsertRowid };
}
function purchaseCreate(payload) {
  // payload: { provider_id, fecha, observaciones, items: [{variant_id,cantidad,costo_unitario}], user_id }
  const { provider_id, fecha, observaciones, items, user_id } = payload;
  const tx = db.transaction(() => {
    const pInfo = db.prepare('INSERT INTO purchases(provider_id,fecha,observaciones) VALUES (?,?,?)')
      .run(provider_id, fecha||nowISO(), observaciones||null);
    const pid = pInfo.lastInsertRowid;
    const addItem = db.prepare(`INSERT INTO purchase_items(purchase_id,variant_id,cantidad,costo_unitario) VALUES (?,?,?,?)`);
    const incStock = db.prepare('UPDATE variants SET stock_actual = stock_actual + ? WHERE id=?');
    for (const it of items) {
      addItem.run(pid, it.variant_id, it.cantidad, it.costo_unitario);
      incStock.run(it.cantidad, it.variant_id);
    }
    audit('purchases', pid, 'create', null, JSON.stringify(payload), user_id);
    return { id: pid };
  });
  return tx();
}

// -------- Clientes y Cuenta Corriente --------
function customersList() { return db.prepare('SELECT * FROM customers ORDER BY id DESC').all(); }
function customerCreate(c) {
  const tx = db.transaction(() => {
    const info = db.prepare('INSERT INTO customers(nombre,apellido,telefono,dni,puntos) VALUES (?,?,?,?,?)')
      .run(c.nombre, c.apellido||null, c.telefono||null, c.dni||null, c.puntos||0);
    const cid = info.lastInsertRowid;
    db.prepare('INSERT INTO customer_accounts(customer_id, saldo_actual) VALUES (?,0)').run(cid);
    audit('customers', cid, 'create', null, JSON.stringify(c), c.user_id);
    return { id: cid };
  });
  return tx();
}
function accountListMovs(customerId) {
  const acc = db.prepare('SELECT * FROM customer_accounts WHERE customer_id=?').get(customerId);
  if (!acc) return { error: 'Cuenta no encontrada' };
  const movs = db.prepare('SELECT * FROM account_movements WHERE account_id=? ORDER BY id DESC').all(acc.id);
  return { account: acc, movements: movs };
}
function accountRegisterPayment(payload) {
  // { customer_id, monto, medio, descripcion, user_id }
  const { customer_id, monto, medio, descripcion, user_id } = payload;
  const tx = db.transaction(() => {
    const acc = db.prepare('SELECT * FROM customer_accounts WHERE customer_id=?').get(customer_id);
    if (!acc) throw new Error('Cuenta no encontrada');
    db.prepare('INSERT INTO account_movements(account_id,fecha,concepto,debe,haber,ref_tipo,ref_id) VALUES (?,?,?,?,?,?,?)')
      .run(acc.id, nowISO(), descripcion||('Pago cuenta corriente '+medio), 0, monto, 'pago_cuenta', null);
    db.prepare('UPDATE customer_accounts SET saldo_actual = saldo_actual - ? WHERE id=?').run(monto, acc.id);
    // registrar ingreso a caja por el medio seleccionado
    ensureCashIsOpen();
    db.prepare('INSERT INTO cash_movements(cash_register_id,fecha,tipo,medio,monto,descripcion) VALUES (?,?,?,?,?,?)')
      .run(currentCashId(), nowISO(), 'pago_cuenta', medio, monto, descripcion||'Pago CC');
    if (medio === 'efectivo') addCashTotals({ efectivo: monto });
    if (medio === 'tarjeta') addCashTotals({ tarjeta: monto });
    if (medio === 'transferencia') addCashTotals({ transferencia: monto });
    audit('customer_accounts', acc.id, 'pago', null, JSON.stringify(payload), user_id);
  });
  tx();
  return { ok: true };
}

// -------- Ventas y Caja --------
function saleCreate(s) {
  // s: { customer_id|null, user_id, forma_pago, items:[{variant_id,cantidad,precio_unitario}], observaciones }
  const tx = db.transaction(() => {
    const total = s.items.reduce((acc, it) => acc + it.cantidad * it.precio_unitario, 0);
    const info = db.prepare('INSERT INTO sales(fecha,customer_id,user_id,forma_pago,total,estado,observaciones) VALUES (?,?,?,?,?,"confirmada",?)')
      .run(nowISO(), s.customer_id||null, s.user_id, s.forma_pago, total, s.observaciones||null);
    const saleId = info.lastInsertRowid;
    const addItem = db.prepare('INSERT INTO sale_items(sale_id,variant_id,cantidad,precio_unitario,subtotal) VALUES (?,?,?,?,?)');
    const decStock = db.prepare('UPDATE variants SET stock_actual = stock_actual - ? WHERE id=?');
    for (const it of s.items) {
      addItem.run(saleId, it.variant_id, it.cantidad, it.precio_unitario, it.cantidad*it.precio_unitario);
      decStock.run(it.cantidad, it.variant_id);
    }
    // Caja y/o cuenta corriente
    ensureCashIsOpen();
    if (s.forma_pago === 'cuenta_corriente') {
      const acc = db.prepare('SELECT * FROM customer_accounts WHERE customer_id=?').get(s.customer_id);
      if (!acc) throw new Error('Cliente sin cuenta corriente');
      db.prepare('INSERT INTO account_movements(account_id,fecha,concepto,debe,haber,ref_tipo,ref_id) VALUES (?,?,?,?,?,?,?)')
        .run(acc.id, nowISO(), 'Venta a cuenta corriente', total, 0, 'venta', saleId);
      db.prepare('UPDATE customer_accounts SET saldo_actual = saldo_actual + ? WHERE id=?').run(total, acc.id);
    } else {
      const medio = s.forma_pago;
      db.prepare('INSERT INTO cash_movements(cash_register_id,fecha,tipo,medio,monto,ref_tipo,ref_id,descripcion) VALUES (?,?,?,?,?,?,?,?)')
        .run(currentCashId(), nowISO(), 'venta', medio, total, 'venta', saleId, 'Venta de mercadería');
      if (medio === 'efectivo') addCashTotals({ efectivo: total });
      if (medio === 'tarjeta') addCashTotals({ tarjeta: total });
      if (medio === 'transferencia') addCashTotals({ transferencia: total });
    }
    audit('sales', saleId, 'create', null, JSON.stringify(s), s.user_id);
    return { id: saleId, total };
  });
  return tx();
}

function saleCancel(saleId) {
  const tx = db.transaction(() => {
    const sale = db.prepare('SELECT * FROM sales WHERE id=?').get(saleId);
    if (!sale) throw new Error('Venta no existe');
    if (sale.estado === 'cancelada') return { ok: true };
    // Restituir stock
    const items = db.prepare('SELECT * FROM sale_items WHERE sale_id=?').all(saleId);
    const incStock = db.prepare('UPDATE variants SET stock_actual = stock_actual + ? WHERE id=?');
    for (const it of items) incStock.run(it.cantidad, it.variant_id);
    // Reversa caja / cuenta corriente
    ensureCashIsOpen();
    if (sale.forma_pago === 'cuenta_corriente') {
      const acc = db.prepare('SELECT * FROM customer_accounts WHERE customer_id=?').get(sale.customer_id);
      db.prepare('INSERT INTO account_movements(account_id,fecha,concepto,debe,haber,ref_tipo,ref_id) VALUES (?,?,?,?,?,?,?)')
        .run(acc.id, nowISO(), 'Cancelación de venta', 0, sale.total, 'venta_cancel', saleId);
      db.prepare('UPDATE customer_accounts SET saldo_actual = saldo_actual - ? WHERE id=?').run(sale.total, acc.id);
    } else {
      // movimiento negativo en caja
      db.prepare('INSERT INTO cash_movements(cash_register_id,fecha,tipo,medio,monto,ref_tipo,ref_id,descripcion) VALUES (?,?,?,?,?,?,?,?)')
        .run(currentCashId(), nowISO(), 'cancelacion', sale.forma_pago, -sale.total, 'venta', saleId, 'Cancelación de venta');
      if (sale.forma_pago === 'efectivo') addCashTotals({ efectivo: -sale.total });
      if (sale.forma_pago === 'tarjeta') addCashTotals({ tarjeta: -sale.total });
      if (sale.forma_pago === 'transferencia') addCashTotals({ transferencia: -sale.total });
    }
    db.prepare('UPDATE sales SET estado="cancelada" WHERE id=?').run(saleId);
    audit('sales', saleId, 'cancel', JSON.stringify(sale), null, sale.user_id);
    return { ok: true };
  });
  return tx();
}

// Caja
function cashOpen(montoInicial, userId) {
  const open = db.prepare("SELECT * FROM cash_register WHERE estado='abierta'").get();
  if (open) return { error: 'Ya hay caja abierta' };
  const info = db.prepare('INSERT INTO cash_register(fecha_apertura,user_id,monto_inicial,estado) VALUES (?,?,?,"abierta")')
    .run(nowISO(), userId, montoInicial||0);
  return { id: info.lastInsertRowid };
}
function cashClose() {
  const open = db.prepare("SELECT * FROM cash_register WHERE estado='abierta'").get();
  if (!open) return { error: 'No hay caja abierta' };
  db.prepare("UPDATE cash_register SET estado='cerrada' WHERE id=?").run(open.id);
  return { ok: true };
}
function cashStatus() {
  const open = db.prepare("SELECT * FROM cash_register WHERE estado='abierta' ORDER BY id DESC LIMIT 1").get();
  if (!open) return { abierta: false };
  return { abierta: true, caja: open, movimientos: db.prepare('SELECT * FROM cash_movements WHERE cash_register_id=? ORDER BY id DESC').all(open.id) };
}
function currentCashId() {
  const open = db.prepare("SELECT id FROM cash_register WHERE estado='abierta' ORDER BY id DESC LIMIT 1").get();
  if (!open) throw new Error('No hay caja abierta');
  return open.id;
}
function ensureCashIsOpen() {
  const open = db.prepare("SELECT 1 FROM cash_register WHERE estado='abierta'").get();
  if (!open) throw new Error('Caja cerrada');
}
function addCashTotals({ efectivo=0, tarjeta=0, transferencia=0 }) {
  const open = db.prepare("SELECT * FROM cash_register WHERE estado='abierta' ORDER BY id DESC LIMIT 1").get();
  db.prepare('UPDATE cash_register SET efectivo_total=efectivo_total+?, tarjeta_total=tarjeta_total+?, transferencia_total=transferencia_total+? WHERE id=?')
    .run(efectivo, tarjeta, transferencia, open.id);
}

// Reportes
function reportStock() {
  const rows = db.prepare(`SELECT p.id as product_id, p.nombre, v.id as variant_id, v.color, v.talle, v.stock_actual
                           FROM products p JOIN variants v ON v.product_id=p.id
                           ORDER BY p.id DESC, v.id DESC`).all();
  return rows;
}
function reportSalesByPeriod(fromISO, toISO) {
  return db.prepare('SELECT * FROM sales WHERE fecha BETWEEN ? AND ? ORDER BY id DESC').all(fromISO, toISO);
}

// Auditoría
function audit(entidad, entidad_id, accion, antes, despues, user_id) {
  db.prepare('INSERT INTO audit_log(fecha,user_id,entidad,entidad_id,accion,datos_antes,datos_despues) VALUES (?,?,?,?,?,?,?)')
    .run(nowISO(), user_id||null, entidad, entidad_id||null, accion, antes||null, despues||null);
}

// Backups
function backupNow() {
  const stamp = new Date().toISOString().replace(/[:.]/g,'-');
  const dest = path.join(BACKUP_DIR, `data-${stamp}.sqlite`);
  fs.copyFileSync(DB_PATH, dest);
  return dest;
}

module.exports = {
  init, seed,
  authLogin,
  productsList, productCreate,
  variantsListByProduct, variantCreate,
  providersList, providerCreate, purchaseCreate,
  customersList, customerCreate,
  accountListMovs, accountRegisterPayment,
  saleCreate, saleCancel,
  cashOpen, cashClose, cashStatus,
  reportStock, reportSalesByPeriod,
  backupNow,
};