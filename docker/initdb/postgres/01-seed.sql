-- Sim-only seed for the fleet simulation's PostgreSQL. Auto-run by the image on
-- first boot (/docker-entrypoint-initdb.d), against POSTGRES_DB (analytics).
-- Adds a second engine so db_console / db_query tools can be exercised on
-- Postgres too — including the engine-enforced read-only protection (a
-- data-modifying CTE is rejected by the read-only transaction). NOT for production.

CREATE TABLE IF NOT EXISTS signups (
  id SERIAL PRIMARY KEY,
  email TEXT, plan TEXT, country TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
INSERT INTO signups (email, plan, country) VALUES
 ('a@acme.com','enterprise','US'), ('b@globex.com','pro','US'),
 ('c@initech.co.uk','pro','UK'), ('d@umbrella.de','enterprise','DE'),
 ('e@stark.com','enterprise','US'), ('f@hooli.com','free','US'),
 ('g@piedpiper.io','free','CA');

CREATE TABLE IF NOT EXISTS events (
  id SERIAL PRIMARY KEY,
  name TEXT, user_email TEXT, value INT,
  occurred_at TIMESTAMPTZ DEFAULT now()
);
INSERT INTO events (name, user_email, value) VALUES
 ('page_view','a@acme.com',1), ('page_view','b@globex.com',1),
 ('purchase','a@acme.com',1299), ('purchase','d@umbrella.de',2400),
 ('signup','f@hooli.com',0), ('purchase','e@stark.com',780),
 ('page_view','c@initech.co.uk',1), ('churn','g@piedpiper.io',0);

-- Least-privilege read-only role the db tools connect as (the safe pattern).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ro') THEN
    CREATE ROLE ro LOGIN PASSWORD 'sim';
  END IF;
END $$;
GRANT CONNECT ON DATABASE analytics TO ro;
GRANT USAGE ON SCHEMA public TO ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ro;
