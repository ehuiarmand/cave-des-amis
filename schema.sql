-- ============================================================
-- Schéma PostgreSQL — Maquis Manager
-- Exécuter une seule fois sur la base cible :
--   psql -U maquis_user -d maquis_db -f schema.sql
-- ============================================================

-- Paramètres globaux (activeSiteId, nextId, pdjWorkDateBySite, …)
CREATE TABLE IF NOT EXISTS app_settings (
    key   TEXT PRIMARY KEY,
    value JSONB NOT NULL
);

-- Maquis (sites)
CREATE TABLE IF NOT EXISTS sites (
    id   TEXT PRIMARY KEY,
    data JSONB NOT NULL
);

-- Comptes utilisateurs
CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,
    data     JSONB NOT NULL
);

-- Ventes (lignes de facturation)
CREATE TABLE IF NOT EXISTS ventes (
    row_id  BIGSERIAL PRIMARY KEY,
    item_id BIGINT,
    site_id TEXT,
    data    JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ventes_site_id ON ventes (site_id);
CREATE INDEX IF NOT EXISTS idx_ventes_date    ON ventes ((data->>'date'));
CREATE INDEX IF NOT EXISTS idx_ventes_facture ON ventes ((data->>'factureNumber'));

-- Stock (articles)
CREATE TABLE IF NOT EXISTS stock (
    row_id  BIGSERIAL PRIMARY KEY,
    item_id BIGINT,
    site_id TEXT,
    data    JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stock_site_id ON stock (site_id);
CREATE INDEX IF NOT EXISTS idx_stock_article ON stock ((data->>'article'));

-- Commandes en cours
CREATE TABLE IF NOT EXISTS commandes (
    row_id  BIGSERIAL PRIMARY KEY,
    item_id BIGINT,
    site_id TEXT,
    data    JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_commandes_site_id ON commandes (site_id);

-- Clôtures de journée (stockChecks)
CREATE TABLE IF NOT EXISTS stock_checks (
    row_id   BIGSERIAL PRIMARY KEY,
    site_id  TEXT,
    date_col TEXT,
    data     JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stock_checks_site_date ON stock_checks (site_id, date_col);

-- Entrées de stock
CREATE TABLE IF NOT EXISTS stock_entrees (
    row_id  BIGSERIAL PRIMARY KEY,
    item_id BIGINT,
    site_id TEXT,
    data    JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stock_entrees_site_id ON stock_entrees (site_id);

-- Pertes de stock
CREATE TABLE IF NOT EXISTS stock_losses (
    row_id  BIGSERIAL PRIMARY KEY,
    item_id BIGINT,
    site_id TEXT,
    data    JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stock_losses_site_id ON stock_losses (site_id);

-- Journaux quotidiens (dayBooks)
CREATE TABLE IF NOT EXISTS day_books (
    row_id   BIGSERIAL PRIMARY KEY,
    site_id  TEXT,
    date_col TEXT,
    data     JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_day_books_site_date ON day_books (site_id, date_col);

-- Commandes fournisseur (purchaseOrders)
CREATE TABLE IF NOT EXISTS purchase_orders (
    row_id  BIGSERIAL PRIMARY KEY,
    item_id BIGINT,
    site_id TEXT,
    data    JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_site_id ON purchase_orders (site_id);

-- Prix fournisseurs (supplierPrices)
CREATE TABLE IF NOT EXISTS supplier_prices (
    row_id  BIGSERIAL PRIMARY KEY,
    item_id TEXT,
    site_id TEXT,
    data    JSONB NOT NULL
);

-- Casiers bouteilles
CREATE TABLE IF NOT EXISTS casiers (
    row_id  BIGSERIAL PRIMARY KEY,
    item_id BIGINT,
    site_id TEXT,
    data    JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_casiers_site_id ON casiers (site_id);

-- Mouvements de casiers
CREATE TABLE IF NOT EXISTS casier_mouvements (
    row_id  BIGSERIAL PRIMARY KEY,
    item_id BIGINT,
    site_id TEXT,
    data    JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_casier_mouvements_site_id ON casier_mouvements (site_id);

-- Recouvrements de crédit
CREATE TABLE IF NOT EXISTS credit_recoveries (
    row_id  BIGSERIAL PRIMARY KEY,
    item_id BIGINT,
    site_id TEXT,
    data    JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_credit_recoveries_site_id ON credit_recoveries (site_id);

-- Consignes
CREATE TABLE IF NOT EXISTS consignes (
    row_id  BIGSERIAL PRIMARY KEY,
    item_id BIGINT,
    site_id TEXT,
    data    JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_consignes_site_id ON consignes (site_id);

-- Fidélité clients (profils / remises)
CREATE TABLE IF NOT EXISTS loyalty_clients (
    row_id  BIGSERIAL PRIMARY KEY,
    item_id BIGINT,
    site_id TEXT,
    data    JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_loyalty_clients_site_id ON loyalty_clients (site_id);

-- Charges (dépenses)
CREATE TABLE IF NOT EXISTS charges (
    row_id  BIGSERIAL PRIMARY KEY,
    item_id BIGINT,
    site_id TEXT,
    data    JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_charges_site_id ON charges (site_id);
CREATE INDEX IF NOT EXISTS idx_charges_date    ON charges ((data->>'date'));

-- Journal d'audit du personnel
CREATE TABLE IF NOT EXISTS staff_audit_log (
    row_id  BIGSERIAL PRIMARY KEY,
    item_id TEXT,
    site_id TEXT,
    data    JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_staff_audit_log_site_id ON staff_audit_log (site_id);

-- Créneaux de planning
CREATE TABLE IF NOT EXISTS work_shifts (
    row_id  BIGSERIAL PRIMARY KEY,
    item_id TEXT,
    site_id TEXT,
    data    JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_work_shifts_site_id ON work_shifts (site_id);
CREATE INDEX IF NOT EXISTS idx_work_shifts_date    ON work_shifts ((data->>'date'));
CREATE INDEX IF NOT EXISTS idx_work_shifts_user    ON work_shifts ((data->>'username'));
