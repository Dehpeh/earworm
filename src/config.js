// Deployment-specific values. Nothing here is a secret.
//
// SPOTIFY_CLIENT_ID is the public identifier of the Spotify app that "Your
// Music" connects through. It is not a secret — the whole point of the PKCE
// flow is that a client-side app has no secret — but it is per-deployment:
// the app it names must list this site's URL as a redirect URI.
//
// To set one up: developer.spotify.com/dashboard → Create app → Web API →
// add redirect URIs (Spotify requires https, or the loopback address for
// local work: `http://127.0.0.1:5173/`, not `localhost`) → copy the Client ID
// here. While the app is in Development Mode, each Spotify account that
// connects must also be added under User Management (limit 25).
export const SPOTIFY_CLIENT_ID = '';
