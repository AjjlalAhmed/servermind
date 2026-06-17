-- Sim-only seed for the fleet simulation's MariaDB. Auto-run by the image on
-- first boot (/docker-entrypoint-initdb.d). Creates richer, varied data across
-- two databases plus a least-privilege read-only user the custom tools use —
-- demonstrating the recommended "point db tools at a SELECT-only role" pattern.
-- NOT for production.

-- ── appdb: e-commerce-ish data ───────────────────────────────────────────────
CREATE DATABASE IF NOT EXISTS appdb;

CREATE TABLE IF NOT EXISTS appdb.customers (
  id INT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(80), country VARCHAR(40), tier VARCHAR(20)
);
INSERT INTO appdb.customers (name, country, tier) VALUES
 ('Acme Corp','US','enterprise'), ('Globex','US','pro'), ('Initech','UK','pro'),
 ('Umbrella','DE','enterprise'), ('Stark Ind','US','enterprise'),
 ('Wayne Ent','US','pro'), ('Hooli','US','pro'), ('Pied Piper','CA','free');

CREATE TABLE IF NOT EXISTS appdb.products (
  id INT PRIMARY KEY AUTO_INCREMENT,
  sku VARCHAR(20), name VARCHAR(80), price DECIMAL(10,2), stock INT
);
INSERT INTO appdb.products (sku, name, price, stock) VALUES
 ('WIDGET-1','Standard Widget',29.99,1200), ('WIDGET-PRO','Pro Widget',79.99,340),
 ('GADGET-1','Gadget',149.00,57), ('GIZMO-X','Gizmo X',1299.00,8),
 ('CABLE-2M','2m Cable',9.50,5000);

CREATE TABLE IF NOT EXISTS appdb.orders (
  id INT PRIMARY KEY AUTO_INCREMENT,
  customer VARCHAR(80), status VARCHAR(20), total DECIMAL(10,2),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO appdb.orders (customer, status, total) VALUES
 ('Acme Corp','active',1299.00), ('Globex','active',459.50),
 ('Initech','shipped',89.99), ('Umbrella','shipped',2400.00),
 ('Stark Ind','active',780.25), ('Wayne Ent','cancelled',150.00),
 ('Hooli','shipped',999.99), ('Pied Piper','active',42.00);

-- ── hr: people data (a separate database, for cross-DB testing) ───────────────
CREATE DATABASE IF NOT EXISTS hr;
CREATE TABLE IF NOT EXISTS hr.employees (
  id INT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(80), role VARCHAR(60), department VARCHAR(40), salary INT
);
INSERT INTO hr.employees (name, role, department, salary) VALUES
 ('Alice Tan','Engineering Manager','Engineering',165000),
 ('Bob Reyes','Senior Engineer','Engineering',140000),
 ('Carol Iyer','Sales Lead','Sales',120000),
 ('Dan Whorter','Account Exec','Sales',95000),
 ('Eve Moreno','HR Generalist','People',82000);

-- ── least-privilege read-only user (the safe pattern the docs recommend) ──────
CREATE USER IF NOT EXISTS 'ro'@'%' IDENTIFIED BY 'sim';
GRANT SELECT ON appdb.* TO 'ro'@'%';
GRANT SELECT ON hr.* TO 'ro'@'%';
FLUSH PRIVILEGES;
