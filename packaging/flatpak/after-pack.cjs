// The Flatpak build leaves out the browser engine, the CUA bundle, cloudflared
// and the DuckDB tree, so the release hook that requires them does not apply.
exports.default = async function afterPack() {};
