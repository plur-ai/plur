import { Plur } from '../src/index.js'
import * as fs from 'fs'
import * as os from 'os'
import { join } from 'path'

const root = fs.mkdtempSync(join(os.tmpdir(), 'plur-probe-'))
process.env.PLUR_PATH = root
const plur = new Plur({ storagePath: root, autoDiscover: false })
await plur.learn('probe one', { scope: 'local' })
await plur.learn('probe two', { scope: 'local' })
console.log('root', root)
console.log(fs.readFileSync(join(root, 'engrams.yaml'), 'utf8').slice(0, 300))
console.log('count', (await plur.list()).length)
