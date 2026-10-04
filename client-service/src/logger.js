const base = (level) => (o) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, service: 'client-service', ...o }));

export const log = { info: base('info'), error: base('error') };