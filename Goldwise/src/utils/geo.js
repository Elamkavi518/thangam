const R = 6371.0088;
const rad = (d) => (d * Math.PI) / 180;
export function haversineKm(lat1, lon1, lat2, lon2) {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
export const directionsUrl = (lat, lng, placeId) =>
  `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}` + (placeId ? `&destination_place_id=${encodeURIComponent(placeId)}` : '');
