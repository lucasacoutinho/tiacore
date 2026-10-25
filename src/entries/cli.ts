import { VERSION } from '../core/version.ts'

const argv = process.argv.slice(2)

if (argv.length === 1 && (argv[0] === '--version' || argv[0] === '-V')) {
  process.stdout.write(`${VERSION}\n`)
} else {
  process.stderr.write('tiacore 2.0 CLI is not implemented yet\n')
  process.exitCode = 1
}
