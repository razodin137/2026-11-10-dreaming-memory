#!/usr/bin/env node
import { run } from "../src/cli.js"

try {
  run(process.argv.slice(2))
} catch (error) {
  process.stderr.write(`mem: ${error.message}\n`)
  process.exit(1)
}
