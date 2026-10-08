import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { placesLimiter } from '../middleware/rateLimit.js';
import { asyncHandler } from '../utils/errors.js';
import { geocodeAddress, reverseGeocode } from '../services/places/googlePlaces.js';

const r = Router();
r.use(placesLimiter);

// Manual location change: free-text address -> coordinates
r.get('/geocode', validate({ query: z.object({ address: z.string().trim().min(2).max(200) }) }), asyncHandler(async (req, res) => {
  res.json({ results: await geocodeAddress(req.query.address) });
}));

// GPS coordinates -> readable place name
r.get('/reverse', validate({ query: z.object({ lat: z.coerce.number().min(-90).max(90), lng: z.coerce.number().min(-180).max(180) }) }), asyncHandler(async (req, res) => {
  res.json({ location: await reverseGeocode(req.query.lat, req.query.lng) });
}));

export default r;
