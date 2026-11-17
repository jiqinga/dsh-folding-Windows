import { startPreview } from './tools/preview.mjs'
const preview = await startPreview({ port: 8791 })
console.log('PREVIEW_READY ' + preview.url)
process.on('SIGTERM', () => preview.close().then(() => process.exit(0)))
setInterval(() => {}, 1 << 30)
