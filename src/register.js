// Loaded with `node --import ./src/register.js` before anything imports the upstream tools.
import { register } from 'node:module'

register('./hooks.js', import.meta.url)
