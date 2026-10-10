// Dev server for the Motion Lab (src/renderer/motion-lab.html) on :5199.
const P = new URL('../..', import.meta.url).pathname.replace(/\/$/, '')
const { createServer } = await import(P + '/node_modules/vite/dist/node/index.js')
const react = (await import(P + '/node_modules/@vitejs/plugin-react/dist/index.js')).default
const server = await createServer({
  configFile: false,
  root: P + '/src/renderer',
  plugins: [react()],
  resolve: { alias: { '@': P + '/src/renderer/src' } },
  server: { port: 5199, strictPort: true, host: '127.0.0.1' },
  logLevel: 'info'
})
await server.listen()
server.printUrls()
