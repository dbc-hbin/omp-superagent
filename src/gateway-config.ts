// One-shot parser shared with the operator CLI. Return normalized config and
// its source digest; never load credential files, native OMP, or messenger SDKs.
import { loadConfigSnapshot } from "./config";

const [file, ...extra] = process.argv.slice(2);
if (!file || extra.length) throw new Error("Expected one Gateway config file");
process.stdout.write(JSON.stringify(await loadConfigSnapshot(file)));
