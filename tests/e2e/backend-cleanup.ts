export default async function cleanupBackend() {
  let response: Response;
  try { response = await fetch('http://127.0.0.1:4175/__test/shutdown', { method: 'POST', signal: AbortSignal.timeout(20000) }); }
  catch (error) {
    // A project may finish before a backend test server was started.
    if ((error as { cause?: { code?: string } }).cause?.code === 'ECONNREFUSED') return;
    throw error;
  }
  if (!response.ok) throw new Error('Backend test schema cleanup failed.');
}
