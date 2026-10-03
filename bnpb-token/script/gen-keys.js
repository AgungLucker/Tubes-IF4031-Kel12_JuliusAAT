import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
fs.mkdirSync('keys', { recursive: true });
fs.writeFileSync('keys/private.pem', privateKey.export({ type: 'pkcs8', format: 'pem' }));
fs.writeFileSync('keys/public.pem', publicKey.export({ type: 'spki', format: 'pem' }));
console.log('KEYS GENERATED');
