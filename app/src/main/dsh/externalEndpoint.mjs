export function parseExternalDshEndpoint(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.hash) {
    throw new Error('External DSH must use http://127.0.0.1:<port>/?token=...');
  }
  const tokens = url.searchParams.getAll('token');
  if (tokens.length !== 1 || !/^[A-Za-z0-9_-]+$/.test(tokens[0]) || [...url.searchParams.keys()].some(key => key !== 'token')) {
    throw new Error('External DSH requires the token printed by the meeting profile');
  }
  return { baseUrl: url.origin, webUrl: url.href, token: tokens[0] };
}
