// Tiacore's own settings in the caller's environment, such as TIA_FRESH=1 or
// TIACORE_DEVTOOLS, would change what the runs under test do. Tests that need
// one set it themselves.
for (const name of Object.keys(process.env)) {
  if (name.startsWith('TIA_') || name.startsWith('TIACORE_')) {
    delete process.env[name]
  }
}
