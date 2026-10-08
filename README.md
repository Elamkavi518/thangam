# GoldWise

A gold and jewellery platform with live gold and silver rates, transparent jewellery pricing, nearby verified stores, gold-loan comparison, online ordering and a team chat. It runs as **one Vercel project** (website + API) with a **PostgreSQL** database on Neon.

**Principle: nothing is faked.** Prices come from a real data provider, stores come from Google Places, loan terms come from lenders your admin enters with a source link, and ratings are only ever Google's own. If a key is missing or a provider fails, the site says so and names the exact setting that is needed.

---

## Features

| Area | What it does |
|---|---|
| **Login** | Mandatory Customer / Admin login (plus Store-owner accounts). JWT sessions, hashed passwords, role-based access. |
| **Live rates** | Gold 24K / 22K / 18K and Silver 999 / 925 from GoldAPI.io. Shown per gram, per 8 g, per 10 g (gold) and per gram, 10 g, 100 g, kg (silver). Every update is stored with metal, purity, price, currency, unit, source, provider timestamp and the raw provider response. |
| **Provider failure** | Shows the last verified price with **"Live update unavailable"**. Orders pause if the price is older than 60 minutes (configurable). |
| **Jewellery** | 16 types (ring, chain, necklace, pendant, bracelet, bangle, earrings, anklet, nose ring, mangalsutra, brooch, gold coin, gold bar, silver coin, silver ornament, custom jewellery) with gross/net weight, purity, wastage, making charge, hallmark/HUID, taxes, images, stock status and the time of the last price update. |
| **Wastage** | Set per **Store → Jewellery type → Design** by the store, with history. There is no global default: if a store has not supplied wastage, the product shows no final price. |
| **Price calculation** | `metal value + wastage + making charge + taxes = estimated final price`, every component shown. Wastage is applied to net metal weight. Taxes are defined by the admin; none are pre-filled. |
| **Search** | Typo-tolerant, works in all six languages, filters by category, metal, price, weight and stock, and sorts by relevance, price or weight. Prices used for filtering are the live calculated prices. |
| **Nearby stores** | Browser GPS (with permission) or a typed location. Real stores from Google Places (major chains and local independents) merged with GoldWise-verified stores. Shows address, distance, phone, hours, website, directions, rating (only if Google provides one), verification status, categories and admin-approved store prices. |
| **Fair ranking** | Sort by best match, distance, rating, verified-first or relevance. Sponsored listings are returned in a **separate, labelled list** and never change the organic order. |
| **Gold-loan comparison** | Compares lenders for the customer's gold weight and purity using the live gold price: loan amount, EMI, processing fee and total cost. Only lenders entered by the admin appear, each with a source link and the date the terms were checked. |
| **Talk to Thangam Team** | Real two-way messaging between a customer and the admins (inbox in the admin panel). Private per customer. |
| **Feedback** | Customers send a rating and message; only admins can read it. |
| **Ordering** | Cart and orders from one store at a time, with the price breakdown and the exact stored metal price locked into each order. Online payment through **Razorpay** with server-side signature verification. |
| **Languages** | English, Hindi, Tamil, Telugu, Kannada, Malayalam (interface and category names). |
| **Look and feel** | Gold-shop door entrance, page-turn transitions and scroll reveals (all disabled for visitors who prefer reduced motion). Installable on a phone as an app (PWA). |
| **Admin** | Verify stores, manage categories, review store-submitted prices, manage wastage, products, taxes, users, sponsored listings, loan lenders, the team inbox and feedback. A **status monitor** shows Gold API, Silver API, Database and Store API (🟢 Connected / 🔴 Error) with the last gold and silver update times, and an API error log. |

**Market price protection:** there is no endpoint that lets anyone type in a gold or silver market price. Store users can only *submit* their own rates, which appear publicly after admin approval and never change the market price.

---

## Tech stack

- **Backend:** Node.js 22, Express, PostgreSQL (`pg`), JWT, bcrypt, zod validation, pino logging, helmet, CORS, rate limiting, response caching
- **Frontend:** plain HTML, CSS and JavaScript modules (no build step), service worker + manifest for install
- **Data providers:** GoldAPI.io (metals), Google Places API (New) + Geocoding API (stores and location), Razorpay (payments)
- **Hosting:** Vercel (serverless functions + static files), Neon (PostgreSQL)

---

## Project structure

```
api/index.js          Vercel entry point (runs migrations once, then the Express app)
public/               Website: index.html, app.js, core.js, i18n.js, staff.js, styles.css, sw.js, icons
src/
  app.js              Express app: security, CORS, rate limits, routes
  config/env.js       Environment validation
  db/                 Connection pool + SQL migrations (001_init, 002_features)
  middleware/         auth, roles, validation, errors, rate limits, caching
  routes/             auth, metals, jewelry, products, stores, location, search,
                      orders, admin, loans, support, feedback, payments
  services/           metals poller/provider, pricing engine, Google Places, store search
test/                 Unit tests + end-to-end tests against a real PostgreSQL
vercel.json           Routing + security headers
.env.example          Every setting, with notes
```

### API modules

`/api/auth` · `/api/metals` · `/api/gold` · `/api/silver` · `/api/jewelry` · `/api/products` · `/api/stores` · `/api/location` · `/api/search` · `/api/orders` · `/api/admin` · `/api/loans` · `/api/support` · `/api/feedback` · `/api/payments` · `GET /health`

---

## Settings (environment variables)

Set these in **Vercel → Settings → Environment Variables**. Never commit a `.env` file.

| Name | Needed for | Notes |
|---|---|---|
| `DATABASE_URL` | Everything | Neon connection string, ending in `?sslmode=require` (remove `&channel_binding=require` if present) |
| `DATABASE_SSL` | Everything | `true` |
| `NODE_ENV` | Everything | `production` |
| `JWT_SECRET` | Login | 40+ random letters and numbers. Do not use the words "secret", "password" or "change-me". |
| `METALS_POLLER_ENABLED` | Vercel | `false` (Vercel cannot run background timers, so prices refresh on page load when older than the interval) |
| `DB_POOL_MAX` | Vercel | `3` |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | First admin | Creates an admin only if none exists. Password 12+ characters. **Delete `ADMIN_PASSWORD` after your first login.** |
| `GOLDAPI_KEY` | Live prices | Token from goldapi.io. Without it the site shows "Live update unavailable" and names this setting. |
| `GOOGLE_MAPS_API_KEY` | Store finder | Enable **Places API (New)** and **Geocoding API**; restrict the key to those two. Without it the store finder names this setting. |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | Online payment | Without them orders are reservations and the app says payment is not set up. |
| `METALS_CURRENCY` | Optional | Default `INR` |
| `METALS_POLL_INTERVAL_SECONDS` | Optional | 60–300, default 300. Check your GoldAPI plan's request quota. |
| `METALS_MAX_STALE_MINUTES` | Optional | Default 60. Older prices pause orders. |
| `REQUIRE_LOGIN` | Optional | Default `true` |
| `CORS_ORIGINS` | Optional | Leave empty when the website and API share one address (the default) |

---

## Deploy to Vercel

1. **Database:** create a free project at [neon.tech](https://neon.tech). Open **Connect**, turn on **Connection pooling**, copy the `postgresql://…` string.
2. **GitHub:** create a repository and upload **the contents** of this project (so `api`, `public`, `src` and `package.json` are at the top level).
3. **Vercel:** *Add New → Project* → choose the repository. Leave **Root Directory** empty and set **Framework Preset** to **Other**.
4. Add the settings above, then **Deploy**.
5. Open `https://YOUR-ADDRESS/health`. You should see `{"ok":true}`. Tables are created automatically on the first request.
6. Open the website, sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`, then remove `ADMIN_PASSWORD` from Vercel and redeploy.

### First-time setup in the Admin panel

1. **Status** — Gold API, Silver API, Database and Store API should all be 🟢. A red light names the missing setting.
2. **Taxes** — add the tax rules that apply to your jewellery (confirm rates with your accountant).
3. **Gold loans** — add lenders. Each needs a source page and the date you checked its terms.
4. **Store verification** — verify store owners' businesses after checking their registration details.

---

## Run locally

Requires Node.js 20+ and a PostgreSQL database.

```bash
npm install
cp .env.example .env        # fill in DATABASE_URL, JWT_SECRET and any provider keys
node src/scripts/migrate.js # creates the tables
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='at-least-12-chars' node src/scripts/createAdmin.js
node src/server.js          # API on http://localhost:4000
```

Serve the `public/` folder with any static server and set `window.GOLDWISE_API_URL = 'http://localhost:4000'` in `public/config.js` while testing locally (leave it empty on Vercel).

## Tests

```bash
TEST_DATABASE_URL=postgres://USER:PASS@localhost:5432/goldwise_test npm test
```

The suite drops and recreates the `public` schema of the database it is pointed at, so use a throwaway database. It covers rate storage and provenance, provider outages, role permissions, wastage and price maths, store search and ranking, sponsored-listing separation, the login gate, multilingual search, loan calculations, messaging privacy, feedback and payment signature checks. The tests use small local stand-ins that mimic the provider response formats; they are never used by the running site.

---

## Known limits

- **Spot price is not a shop board rate.** Provider prices converted to rupees will differ from a local jeweller's rate, which includes duty, GST and local premium. Stores can publish their own admin-approved rates beside the market price.
- **Price refresh on Vercel** happens when someone opens the site and the stored price is older than the interval. A very quiet site can show an older price until the next visit. For true every-5-minutes updates, run the API on an always-on host.
- **GoldAPI field names** were written from its public documentation. Confirm them against a real response once your key is active (Admin → Status).
- **Google Places data** is cached for minutes only (Google's terms restrict storing it). Only the place ID of a registered store is saved.
- **Translations** were written by an AI assistant. Have a native speaker review each language before launch. Store and admin panels are English only.
- **Payments** need your own Razorpay account and KYC. Payment status is confirmed only by verifying Razorpay's signature on the server.
- **Images** are links to hosted images; there is no upload service yet.
- **Not yet included:** a native Android APK (the installable web app is included; an APK can be generated from it next), SMS/OTP login, email notifications.

## Security notes

- Keep every key in Vercel's settings only. The repository must never contain `.env` or secrets.
- If a database password or API key is ever shared in a chat, a screenshot or a commit, reset it immediately.
- Passwords are hashed with bcrypt; roles are read from the database on every request; rate limits protect login and search; all browser-facing text is inserted as plain text, never as HTML.
