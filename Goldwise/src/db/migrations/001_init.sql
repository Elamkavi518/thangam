-- GoldWise production schema. Idempotent only via the migration runner (each file runs once).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE user_role AS ENUM ('customer', 'store', 'admin');
CREATE TYPE verification_status AS ENUM ('unverified', 'pending', 'verified', 'rejected');
CREATE TYPE metal_kind AS ENUM ('gold', 'silver');
CREATE TYPE stock_status AS ENUM ('in_stock', 'low_stock', 'out_of_stock', 'made_to_order');
CREATE TYPE making_charge_kind AS ENUM ('fixed', 'per_gram', 'percent_of_metal');
CREATE TYPE tax_base AS ENUM ('all', 'metal_and_wastage', 'making_only');
CREATE TYPE review_status AS ENUM ('pending', 'approved', 'rejected');
CREATE TYPE order_status AS ENUM ('pending', 'confirmed', 'ready', 'completed', 'cancelled');

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  phone         TEXT,
  role          user_role NOT NULL DEFAULT 'customer',
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Live metal prices (written ONLY by the metals service) ----------
CREATE TABLE metal_prices (
  id                 BIGSERIAL PRIMARY KEY,
  metal              metal_kind NOT NULL,
  purity_code        TEXT NOT NULL,            -- gold: 24K/22K/18K ; silver: 999/925
  price              NUMERIC(14,4) NOT NULL CHECK (price > 0),
  currency           CHAR(3) NOT NULL,
  unit               TEXT NOT NULL DEFAULT 'gram',
  source             TEXT NOT NULL,            -- provider identifier, e.g. goldapi.io
  is_derived         BOOLEAN NOT NULL DEFAULT FALSE, -- true when computed from the provider's pure-metal price
  derived_from       TEXT,                     -- e.g. '24K x 22/24'
  provider_timestamp TIMESTAMPTZ,              -- timestamp reported by the provider
  fetched_at         TIMESTAMPTZ NOT NULL DEFAULT now(), -- when GoldWise stored it
  raw_payload        JSONB,                    -- provider response kept for provenance/audit
  CONSTRAINT purity_valid CHECK (
    (metal = 'gold'   AND purity_code IN ('24K','22K','18K')) OR
    (metal = 'silver' AND purity_code IN ('999','925'))
  )
);
CREATE INDEX metal_prices_latest_idx ON metal_prices (metal, purity_code, currency, fetched_at DESC);

-- Outcome of every external-service call (feeds the admin status monitor + error log)
CREATE TABLE api_events (
  id              BIGSERIAL PRIMARY KEY,
  service         TEXT NOT NULL CHECK (service IN ('gold','silver','places','geocoding','database')),
  ok              BOOLEAN NOT NULL,
  http_status     INT,
  message         TEXT,
  config_required TEXT[],
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX api_events_service_idx ON api_events (service, created_at DESC);

-- ---------- Jewelry taxonomy ----------
CREATE TABLE jewelry_types (
  id         SERIAL PRIMARY KEY,
  slug       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL UNIQUE,
  metals     metal_kind[] NOT NULL,   -- metals this type can be made of
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INT NOT NULL DEFAULT 0
);
INSERT INTO jewelry_types (slug, name, metals, sort_order) VALUES
 ('ring','Ring','{gold,silver}',1),
 ('chain','Chain','{gold,silver}',2),
 ('necklace','Necklace','{gold,silver}',3),
 ('pendant','Pendant','{gold,silver}',4),
 ('bracelet','Bracelet','{gold,silver}',5),
 ('bangle','Bangle','{gold,silver}',6),
 ('earrings','Earrings','{gold,silver}',7),
 ('anklet','Anklet','{gold,silver}',8),
 ('nose-ring','Nose Ring','{gold,silver}',9),
 ('mangalsutra','Mangalsutra','{gold}',10),
 ('brooch','Brooch','{gold,silver}',11),
 ('gold-coin','Gold Coin','{gold}',12),
 ('gold-bar','Gold Bar','{gold}',13),
 ('silver-coin','Silver Coin','{silver}',14),
 ('silver-ornament','Silver Ornament','{silver}',15),
 ('custom-jewelry','Custom Jewelry','{gold,silver}',16);

-- ---------- Stores ----------
CREATE TABLE stores (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id            UUID NOT NULL REFERENCES users(id),
  name                TEXT NOT NULL,
  google_place_id     TEXT UNIQUE,                 -- links a registered store to its Google Places listing
  address             TEXT NOT NULL,
  city                TEXT,
  latitude            DOUBLE PRECISION NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude           DOUBLE PRECISION NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  phone               TEXT,
  website             TEXT,
  opening_hours       JSONB,                        -- store-supplied: {"mon":"10:00-20:00",...}
  business_registration TEXT,                       -- GSTIN / licence no. supplied for verification
  verification_status verification_status NOT NULL DEFAULT 'unverified',
  verification_note   TEXT,
  verified_by         UUID REFERENCES users(id),
  verified_at         TIMESTAMPTZ,
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX stores_owner_idx ON stores (owner_id);
CREATE INDEX stores_geo_idx ON stores (latitude, longitude);

CREATE TABLE store_jewelry_types (
  store_id        UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  jewelry_type_id INT  NOT NULL REFERENCES jewelry_types(id),
  PRIMARY KEY (store_id, jewelry_type_id)
);

-- Store-supplied metal rates; shown publicly only after admin approval. Never touches metal_prices.
CREATE TABLE store_price_submissions (
  id              BIGSERIAL PRIMARY KEY,
  store_id        UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  metal           metal_kind NOT NULL,
  purity_code     TEXT NOT NULL,
  price_per_gram  NUMERIC(14,4) NOT NULL CHECK (price_per_gram > 0),
  currency        CHAR(3) NOT NULL,
  status          review_status NOT NULL DEFAULT 'pending',
  submitted_by    UUID NOT NULL REFERENCES users(id),
  submitted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_by     UUID REFERENCES users(id),
  reviewed_at     TIMESTAMPTZ,
  review_note     TEXT,
  CONSTRAINT sub_purity_valid CHECK (
    (metal = 'gold'   AND purity_code IN ('24K','22K','18K')) OR
    (metal = 'silver' AND purity_code IN ('999','925'))
  )
);
CREATE INDEX store_price_sub_idx ON store_price_submissions (store_id, metal, purity_code, status, reviewed_at DESC);

-- Paid placements. Always returned in a separate, labelled list; never mixed into organic ranking.
CREATE TABLE sponsored_listings (
  id         BIGSERIAL PRIMARY KEY,
  store_id   UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  starts_at  TIMESTAMPTZ NOT NULL,
  ends_at    TIMESTAMPTZ NOT NULL,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);

-- ---------- Wastage: Store + Jewelry Type + Design ----------
CREATE TABLE designs (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id             UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  jewelry_type_id      INT  NOT NULL REFERENCES jewelry_types(id),
  name                 TEXT NOT NULL,
  wastage_percent      NUMERIC(6,3) CHECK (wastage_percent IS NULL OR (wastage_percent >= 0 AND wastage_percent <= 100)),
  wastage_updated_at   TIMESTAMPTZ,
  wastage_updated_by   UUID REFERENCES users(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (store_id, jewelry_type_id, name)
);
-- wastage_percent stays NULL until the store supplies it. There is no global default.

CREATE TABLE wastage_history (
  id          BIGSERIAL PRIMARY KEY,
  scope       TEXT NOT NULL CHECK (scope IN ('design','product')),
  scope_id    UUID NOT NULL,
  old_percent NUMERIC(6,3),
  new_percent NUMERIC(6,3),
  changed_by  UUID NOT NULL REFERENCES users(id),
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Taxes / fees (admin-managed; nothing hard-coded) ----------
CREATE TABLE tax_rules (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  rate_percent NUMERIC(6,3) NOT NULL CHECK (rate_percent >= 0 AND rate_percent <= 100),
  applies_to   tax_base NOT NULL DEFAULT 'all',
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by   UUID REFERENCES users(id),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Products (one normalized table; jewelry_type_id selects Ring/Chain/... ) ----------
CREATE TABLE products (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id                    UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  jewelry_type_id             INT  NOT NULL REFERENCES jewelry_types(id),
  design_id                   UUID REFERENCES designs(id),
  name                        TEXT NOT NULL,
  description                 TEXT,
  metal                       metal_kind NOT NULL,
  purity_code                 TEXT NOT NULL,
  gross_weight_g              NUMERIC(10,3) NOT NULL CHECK (gross_weight_g > 0),
  net_weight_g                NUMERIC(10,3) NOT NULL CHECK (net_weight_g > 0),
  wastage_override_percent    NUMERIC(6,3) CHECK (wastage_override_percent IS NULL OR (wastage_override_percent BETWEEN 0 AND 100)),
  wastage_override_updated_at TIMESTAMPTZ,
  making_charge_type          making_charge_kind NOT NULL,
  making_charge_value         NUMERIC(14,4) NOT NULL CHECK (making_charge_value >= 0),
  hallmark_standard           TEXT,           -- e.g. BIS 916
  hallmark_huid               TEXT,           -- Hallmark Unique ID
  certification               TEXT,
  stock_status                stock_status NOT NULL DEFAULT 'in_stock',
  stock_quantity              INT NOT NULL DEFAULT 1 CHECK (stock_quantity >= 0),
  images                      JSONB NOT NULL DEFAULT '[]'::jsonb,   -- array of image URLs
  type_attributes             JSONB NOT NULL DEFAULT '{}'::jsonb,   -- size, length, stone details, etc.
  is_active                   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT net_le_gross CHECK (net_weight_g <= gross_weight_g),
  CONSTRAINT product_purity_valid CHECK (
    (metal = 'gold'   AND purity_code IN ('24K','22K','18K')) OR
    (metal = 'silver' AND purity_code IN ('999','925'))
  )
);
CREATE INDEX products_store_idx ON products (store_id, jewelry_type_id) WHERE is_active;
CREATE INDEX products_type_idx ON products (jewelry_type_id, metal, purity_code) WHERE is_active;

CREATE TABLE product_taxes (
  product_id  UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  tax_rule_id INT  NOT NULL REFERENCES tax_rules(id),
  PRIMARY KEY (product_id, tax_rule_id)
);

-- ---------- Orders ----------
CREATE TABLE orders (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id),
  store_id    UUID NOT NULL REFERENCES stores(id),
  status      order_status NOT NULL DEFAULT 'pending',
  currency    CHAR(3) NOT NULL,
  total       NUMERIC(14,2) NOT NULL,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX orders_user_idx ON orders (user_id, created_at DESC);
CREATE INDEX orders_store_idx ON orders (store_id, created_at DESC);

CREATE TABLE order_items (
  id              BIGSERIAL PRIMARY KEY,
  order_id        UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id      UUID NOT NULL REFERENCES products(id),
  product_name    TEXT NOT NULL,
  quantity        INT NOT NULL CHECK (quantity > 0),
  unit_total      NUMERIC(14,2) NOT NULL,
  price_breakdown JSONB NOT NULL,           -- full calculation snapshot
  metal_price_id  BIGINT REFERENCES metal_prices(id)  -- exact stored provider price used
);

CREATE TABLE audit_log (
  id         BIGSERIAL PRIMARY KEY,
  actor_id   UUID REFERENCES users(id),
  action     TEXT NOT NULL,
  entity     TEXT NOT NULL,
  entity_id  TEXT,
  details    JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
