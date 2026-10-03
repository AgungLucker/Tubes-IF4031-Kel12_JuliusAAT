import fs from 'node:fs';
import { createPrivateKey, createPublicKey } from 'node:crypto';

export function loadKeys(cfg) {
  return {
    privateKey: createPrivateKey(fs.readFileSync(cfg.privateKeyFile)),
    publicKey: createPublicKey(fs.readFileSync(cfg.publicKeyFile)),
  };
}