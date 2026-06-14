// Print a keypair from the REAL module so the keygen-compat scenario validates
// the actual code path. Line 1 = private key, line 2 = public key.
import { generateKeypair } from "../../src/fleet/wireguard.ts";
const { privateKey, publicKey } = generateKeypair();
console.log(privateKey);
console.log(publicKey);
