// TEST HARNESS ONLY. Local HTTP stubs that mimic the external providers' response formats so the
// full pipeline can be exercised without real API keys. They are never used by the production app:
// *_BASE_URL overrides are ignored when NODE_ENV=production.
import http from 'node:http';

export function startStub(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      let body = '';
      for await (const c of req) body += c;
      const out = await handler(req, body ? JSON.parse(body) : null);
      res.writeHead(out.status ?? 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out.json));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}
