// Regenerate src/routeTree.gen.ts in a prepared .build/new-api-web (the rsbuild plugin does this during a full build).
/* global process, console */
import { Generator, getConfig } from '@tanstack/router-generator'
const config = getConfig({ target: 'react', autoCodeSplitting: true }, process.cwd())
await new Generator({ config, root: process.cwd() }).run()
console.log('routeTree generated')
