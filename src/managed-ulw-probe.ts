// Finite, offline extension import + factory-registration check. This does not
// claim model turns or ULW workflow behavior; native proofs cover those separately.
import { listPackageExtensionModules, loadExtensions } from "../.upstream/omp/packages/coding-agent/src/extensibility/extensions/loader";
const packagePath = process.argv[2];
if (!packagePath) throw new Error("Managed ULW probe requires a package path");
const modules = await listPackageExtensionModules([packagePath], process.cwd(), { plugins: false });
if (!modules.length) throw new Error("Managed ULW has no discoverable extension");
const loaded = await loadExtensions(modules.map(module => module.path), process.cwd());
if (loaded.errors.length || loaded.extensions.length !== modules.length)
  throw new Error(`Native OMP rejected managed ULW: ${JSON.stringify(loaded.errors)}`);
console.log(JSON.stringify({ extensions: loaded.extensions.length, compatibility: "native-import-and-factory-registration" }));
process.exit(0);
