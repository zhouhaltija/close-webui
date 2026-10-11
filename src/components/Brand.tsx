export function Mark({ large = false }: { large?: boolean }) {
  return <svg className={large ? 'brand-mark large' : 'brand-mark'} viewBox="0 0 40 40" fill="none" aria-hidden="true"><g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><path d="m20 20-8-15m8 15-1-17m1 17 8-15m-8 15L35 9m-15 11 17-4m-17 4 17 4m-17-4 14 12m-14-12 6 17m-6-17-2 18m2-18L9 35m11-15L4 29m16-9L2 20m18 0L4 12" strokeWidth="2.7" /><path d="m20 20-6-9m6 9 11-3m-11 3 8 7m-8-7-8 3" strokeWidth="3.2" /></g></svg>;
}
