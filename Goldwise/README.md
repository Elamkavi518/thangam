# GoldWise

One Vercel project: the website is in `public/`, the API in `api/` + `src/`, PostgreSQL on Neon.

- Live gold/silver rates (GoldAPI.io), stored with source + timestamp; "Live update unavailable" when the provider fails
- Jewellery with weight, purity, store-supplied wastage, making charges, taxes and a full price breakdown
- Typo-tolerant search in 6 languages; nearby stores (Google Places) with fair, labelled sponsored listings
- Gold-loan comparison from admin-entered lenders (each with source link and check date)
- Talk to Thangam Team (two-way messaging), feedback, orders with Razorpay payment
- English, Hindi, Tamil, Telugu, Kannada, Malayalam. Login is mandatory.

Nothing is hard-coded. If a key is missing the site names the setting. See `.env.example`.
Tests: `npm test` (needs a local PostgreSQL; it wipes that database).
