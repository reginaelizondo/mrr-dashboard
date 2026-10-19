// Esqueleto mientras carga el Operativo por primera vez (los cambios de filtro muestran "actualizando…" sin esqueleto).
export default function Loading() {
  const block = 'animate-pulse rounded-xl border border-slate-200/80 bg-white';
  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <div className="h-7 w-40 animate-pulse rounded bg-slate-200" />
        <div className="h-4 w-[28rem] max-w-full animate-pulse rounded bg-slate-200/70" />
      </div>
      <div className={`${block} h-32`} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {Array.from({ length: 8 }, (_, i) => <div key={i} className={`${block} h-32`} />)}
      </div>
      <div className={`${block} h-96`} />
    </div>
  );
}
