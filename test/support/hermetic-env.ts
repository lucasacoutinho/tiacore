// Tiacore's own settings in the caller's environment, such as TIA_FRESH=1 or
// TIACORE_DEVTOOLS, would change what the runs under test do. Tests that need
// one set it themselves.
for (const name of Object.keys(process.env)) {
  if (name.startsWith('TIA_') || name.startsWith('TIACORE_')) {
    delete process.env[name]
  }
}

// git may start detached maintenance after a commit; in a test project that
// is about to be modified or deleted, that background process races the test.
// Every git the tests start, directly or through tiacore, runs without it.
process.env['GIT_CONFIG_COUNT'] = '2'
process.env['GIT_CONFIG_KEY_0'] = 'maintenance.auto'
process.env['GIT_CONFIG_VALUE_0'] = 'false'
process.env['GIT_CONFIG_KEY_1'] = 'gc.auto'
process.env['GIT_CONFIG_VALUE_1'] = '0'
