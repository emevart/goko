import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

export function UtilityPanel({ title, label, children, recording = false }: { title: string; label: string; children: ReactNode; recording?: boolean }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);
  return <div className="utility-menu" ref={root}>
    <button ref={trigger} type="button" className="btn utility-trigger" aria-label={title} aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
      {recording && <span className="recording-dot" aria-hidden="true" />}{label}
    </button>
    {open && <section id={id} className="utility-panel" aria-label={title}>
      <div className="utility-panel-heading"><span>{title}</span><button type="button" className="btn btn-square" aria-label={`Закрыть: ${title}`} onClick={close}>×</button></div>
      {children}
    </section>}
  </div>;
}
