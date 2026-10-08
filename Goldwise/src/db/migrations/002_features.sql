CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE users ADD COLUMN language TEXT NOT NULL DEFAULT 'en' CHECK (language IN ('en','hi','ta','te','kn','ml'));

-- Category names in the six supported languages (used for display and for searching in any language)
ALTER TABLE jewelry_types ADD COLUMN name_i18n JSONB NOT NULL DEFAULT '{}'::jsonb;
UPDATE jewelry_types t SET name_i18n = v.j::jsonb FROM (VALUES
 ('ring','{"hi":"अंगूठी","ta":"மோதிரம்","te":"ఉంగరం","kn":"ಉಂಗುರ","ml":"മോതിരം"}'),
 ('chain','{"hi":"चेन","ta":"சங்கிலி","te":"గొలుసు","kn":"ಸರ","ml":"ചെയിൻ"}'),
 ('necklace','{"hi":"हार","ta":"நெக்லஸ்","te":"నెక్లెస్","kn":"ನೆಕ್ಲೆಸ್","ml":"മാല"}'),
 ('pendant','{"hi":"पेंडेंट","ta":"பதக்கம்","te":"లాకెట్","kn":"ಪೆಂಡೆಂಟ್","ml":"പെൻഡന്റ്"}'),
 ('bracelet','{"hi":"ब्रेसलेट","ta":"பிரேஸ்லெட்","te":"బ్రాస్లెట్","kn":"ಬ್ರೇಸ್ಲೆಟ್","ml":"ബ്രേസ്ലെറ്റ്"}'),
 ('bangle','{"hi":"चूड़ी","ta":"வளையல்","te":"గాజులు","kn":"ಬಳೆ","ml":"വള"}'),
 ('earrings','{"hi":"कान की बालियाँ","ta":"காதணி","te":"చెవిపోగులు","kn":"ಕಿವಿಯೋಲೆ","ml":"കമ്മൽ"}'),
 ('anklet','{"hi":"पायल","ta":"கொலுசு","te":"పట్టీలు","kn":"ಕಾಲ್ಗೆಜ್ಜೆ","ml":"പാദസരം"}'),
 ('nose-ring','{"hi":"नथ","ta":"மூக்குத்தி","te":"ముక్కుపుడక","kn":"ಮೂಗುತಿ","ml":"മൂക്കുത്തി"}'),
 ('mangalsutra','{"hi":"मंगलसूत्र","ta":"தாலி","te":"మంగళసూత్రం","kn":"ಮಂಗಳಸೂತ್ರ","ml":"മംഗല്യസൂത്രം"}'),
 ('brooch','{"hi":"ब्रोच","ta":"ப்ரூச்","te":"బ్రోచ్","kn":"ಬ್ರೂಚ್","ml":"ബ്രൂച്ച്"}'),
 ('gold-coin','{"hi":"सोने का सिक्का","ta":"தங்க நாணயம்","te":"బంగారు నాణెం","kn":"ಚಿನ್ನದ ನಾಣ್ಯ","ml":"സ്വർണ്ണ നാണയം"}'),
 ('gold-bar','{"hi":"सोने की छड़","ta":"தங்கக் கட்டி","te":"బంగారు కడ్డీ","kn":"ಚಿನ್ನದ ಬಾರ್","ml":"സ്വർണ്ണ ബാർ"}'),
 ('silver-coin','{"hi":"चाँदी का सिक्का","ta":"வெள்ளி நாணயம்","te":"వెండి నాణెం","kn":"ಬೆಳ್ಳಿ ನಾಣ್ಯ","ml":"വെള്ളി നാണയം"}'),
 ('silver-ornament','{"hi":"चाँदी के गहने","ta":"வெள்ளி நகை","te":"వెండి ఆభరణాలు","kn":"ಬೆಳ್ಳಿ ಆಭರಣ","ml":"വെള്ളി ആഭരണം"}'),
 ('custom-jewelry','{"hi":"कस्टम गहने","ta":"தனிப்பயன் நகை","te":"కస్టమ్ ఆభరణాలు","kn":"ಕಸ್ಟಮ್ ಆಭರಣ","ml":"ഇഷ്ടാനുസൃത ആഭരണം"}')
) AS v(slug, j) WHERE t.slug = v.slug;

CREATE INDEX products_name_trgm ON products USING gin (name gin_trgm_ops);

-- Gold-loan providers: entered and maintained by an admin, always with a source and a check date.
CREATE TABLE loan_providers (
  id                      SERIAL PRIMARY KEY,
  name                    TEXT NOT NULL UNIQUE,
  provider_type           TEXT NOT NULL CHECK (provider_type IN ('bank','nbfc','cooperative','other')),
  interest_rate_percent   NUMERIC(5,2) NOT NULL CHECK (interest_rate_percent >= 0 AND interest_rate_percent <= 60), -- per annum
  ltv_percent             NUMERIC(5,2) NOT NULL CHECK (ltv_percent > 0 AND ltv_percent <= 100),                      -- loan-to-value on gold value
  processing_fee_percent  NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (processing_fee_percent >= 0 AND processing_fee_percent <= 20),
  min_loan_amount         NUMERIC(14,2),
  max_loan_amount         NUMERIC(14,2),
  min_tenure_months       INT,
  max_tenure_months       INT,
  accepted_purities       TEXT[] NOT NULL DEFAULT '{22K,24K,18K}',
  source_url              TEXT NOT NULL,          -- where the admin read these terms
  source_checked_at       TIMESTAMPTZ NOT NULL,   -- when they were last checked
  is_active               BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by              UUID REFERENCES users(id),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- "Talk to Thangam Team": real two-way messaging between a customer and the admins
CREATE TABLE support_threads (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id),
  subject         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX support_threads_user_idx ON support_threads (user_id, last_message_at DESC);
CREATE INDEX support_threads_open_idx ON support_threads (status, last_message_at DESC);
CREATE TABLE support_messages (
  id           BIGSERIAL PRIMARY KEY,
  thread_id    UUID NOT NULL REFERENCES support_threads(id) ON DELETE CASCADE,
  sender_id    UUID NOT NULL REFERENCES users(id),
  sender_role  user_role NOT NULL,
  body         TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX support_messages_thread_idx ON support_messages (thread_id, id);

CREATE TABLE feedback (
  id         BIGSERIAL PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES users(id),
  rating     INT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  topic      TEXT NOT NULL DEFAULT 'general' CHECK (topic IN ('general','prices','stores','jewellery','loans','app')),
  message    TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Online payment (Razorpay)
CREATE TYPE payment_status AS ENUM ('unpaid','paid','failed');
ALTER TABLE orders
  ADD COLUMN payment_status payment_status NOT NULL DEFAULT 'unpaid',
  ADD COLUMN razorpay_order_id TEXT,
  ADD COLUMN razorpay_payment_id TEXT,
  ADD COLUMN paid_at TIMESTAMPTZ;

ALTER TABLE api_events DROP CONSTRAINT api_events_service_check;
ALTER TABLE api_events ADD CONSTRAINT api_events_service_check CHECK (service IN ('gold','silver','places','geocoding','database','payments'));
