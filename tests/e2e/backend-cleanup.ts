export default async function cleanupBackend() {
  try { await fetch('http://127.0.0.1:4175/__test/shutdown', { method: 'POST', signal: AbortSignal.timeout(20000) }); } catch { /* No backend server was started, or it already exited. */ }
}
