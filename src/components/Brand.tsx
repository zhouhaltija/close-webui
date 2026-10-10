export function Mark({ large = false }: { large?: boolean }) {
  return <svg className={large ? 'brand-mark large' : 'brand-mark'} viewBox="0 0 40 40" fill="none" aria-hidden="true"><path d="M28 11H17a9 9 0 0 0 0 18h11M23 16h-6a4 4 0 0 0 0 8h6" stroke="currentColor" strokeWidth="3" strokeLinecap="round" /><path d="M31 17v6" stroke="currentColor" strokeWidth="3" strokeLinecap="round" /></svg>;
}
