// Kingsfall TURN credentials: a tiny Cloudflare Worker.
//
// Players' browsers connect to each other directly (WebRTC). On strict networks (university Wi-Fi,
// some offices) that fails, and the game traffic has to go through a TURN relay instead. Cloudflare
// runs that relay; this Worker hands out short-lived login details for it, so the secret API token
// never appears in the game's page.
//
// Secrets to set on the Worker (Settings → Variables and Secrets, type "Secret"):
//   TURN_KEY_ID     the Turn Token ID of your TURN app (Realtime → TURN Server)
//   TURN_API_TOKEN  the API token shown when the TURN app was created

// Pages allowed to ask for credentials.
const ALLOWED_ORIGINS = [
  'https://gabrielschwarz.com',
  'https://www.gabrielschwarz.com',
  'https://gjoerk.github.io',
  'http://localhost:5173',
];

// How long the login details stay valid (seconds): long enough for a game.
const TTL = 6 * 60 * 60;

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') ?? '';
    const allowed = ALLOWED_ORIGINS.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': allowed ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Vary': 'Origin',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (!allowed) return new Response('Forbidden', { status: 403, headers: cors });

    const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.TURN_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: TTL }),
    });
    if (!res.ok) return new Response(`TURN service error ${res.status}`, { status: 502, headers: cors });
    const data = await res.json();
    // { iceServers: [ { urls: [...] }, { urls: [...], username, credential } ] }
    return new Response(JSON.stringify({ iceServers: data.iceServers }), {
      headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  },
};
