const base = (level) => (o) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, service: 'bnpb-token', ...o }));

export const log = { info: base('info'), error: base('error') };
