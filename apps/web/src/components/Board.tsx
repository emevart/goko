// Доска SVG (раздел 10 спеки): сетка, хоси, координаты по краям, камни, метка последнего хода;
// после счёта — территория и мёртвые камни из result.score. Тап -> ближайший пункт -> onTap(coord).
// SVG заполняет гибкий бокс .board-wrap (доска сжимается по доступной высоте) и вписывает квадрат по центру;
// поля бокса при пересчёте тапа вычитает toView.
import { useEffect, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import { BoardDrag } from '../board-drag.ts';
import { COLUMN_LETTERS, parseCoord } from '@goko/go-core';
import type { GameState } from '@goko/protocol';
import { VIEW, coordAt, hoshi, indexOf, layout, pointAt, stones, toView, x, y } from '../geometry.ts';

type Props = { state: GameState | null; size: number; onTap: (coord: string) => void };

const TERRITORY_THRESHOLD = 0.6;

export function Board({ state, size, onTap }: Props) {
  const ref = useRef<SVGSVGElement>(null);
  const drag = useRef(new BoardDrag());
  const [preview, setPreview] = useState<string | null>(null);
  const position = `${state?.id}:${state?.revision}`;
  useEffect(() => { drag.current.cancel(); setPreview(null); }, [position]);
  const l = layout(size);
  const board = state?.board ?? '.'.repeat(size * size);
  const last = state?.moves.at(-1);
  const lastPoint = last && last.coord !== 'pass' ? parseCoord(last.coord, size) : null;
  const score = state?.status === 'finished' ? state.result?.score : undefined;
  const dead = new Set(score?.dead ?? []);
  const lineIdx = Array.from({ length: size }, (_, i) => i);

  const target = (e: PointerEvent<SVGSVGElement>) => {
    const svg = ref.current;
    if (!svg || state?.status !== 'playing' || state.pendingEngineMove) return null;
    const v = toView(svg.getBoundingClientRect(), e.clientX, e.clientY);
    const p = v && pointAt(l, v.x, v.y);
    return p && board[indexOf(p,size)] === '.' ? coordAt(p) : null;
  };
  const point = preview ? parseCoord(preview,size) : null;

  const label = `доска ${size}×${size}${last ? `, последний ход ${last.coord === 'pass' ? 'пас' : last.coord}` : ''}`;

  return (
    <div className="board-wrap">
      {preview && <output className="board-preview-label">{preview} · отпусти, чтобы поставить</output>}
      <svg ref={ref} className="board" viewBox={`0 0 ${VIEW} ${VIEW}`} role="img" aria-label={label}
        onPointerDown={e => { if (!e.isPrimary || e.button !== 0) return; e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); const coord=target(e); drag.current.start(e.pointerId,position,coord); setPreview(coord); }}
        onPointerMove={e => { if (e.isPrimary && e.buttons) setPreview(drag.current.move(e.pointerId,target(e))); }}
        onPointerUp={e => { if (!e.isPrimary) return; const coord=drag.current.end(e.pointerId,position,target(e)); setPreview(null); if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); if (coord) onTap(coord); }}
        onPointerCancel={() => { drag.current.cancel(); setPreview(null); }}
        onLostPointerCapture={() => { drag.current.cancel(); setPreview(null); }}>
        <rect className="board-bg" width={VIEW} height={VIEW} />
        {lineIdx.map((i) => (
          <g key={i} className="grid">
            <line x1={x(l, i)} y1={y(l, 0)} x2={x(l, i)} y2={y(l, size - 1)} />
            <line x1={x(l, 0)} y1={y(l, i)} x2={x(l, size - 1)} y2={y(l, i)} />
            <text className="coord" x={x(l, i)} y={VIEW - l.margin * 0.3}>
              {COLUMN_LETTERS[i]}
            </text>
            <text className="coord" x={l.margin * 0.3} y={y(l, i)}>
              {i + 1}
            </text>
          </g>
        ))}
        {hoshi(size).map((p) => (
          <circle key={`h${p.col}-${p.row}`} className="hoshi" cx={x(l, p.col)} cy={y(l, p.row)} r={l.step * 0.1} />
        ))}
        {score &&
          lineIdx.flatMap((row) =>
            lineIdx.map((col) => {
              const v = score.ownership[indexOf({ col, row }, size)] ?? 0;
              if (Math.abs(v) < TERRITORY_THRESHOLD || board[indexOf({ col, row }, size)] !== '.') return null;
              return <rect key={`t${col}-${row}`} className={v > 0 ? 'territory-b' : 'territory-w'} x={x(l, col) - l.step * 0.18} y={y(l, row) - l.step * 0.18} width={l.step * 0.36} height={l.step * 0.36} />;
            }),
          )}
        {stones(board, size).map((s) => {
          const coord = coordAt({ col: s.col, row: s.row });
          return (
            <g key={coord}>
              <circle className={s.color === 'B' ? 'stone-b' : 'stone-w'} cx={x(l, s.col)} cy={y(l, s.row)} r={l.step * 0.47} />
              {dead.has(coord) && (
                <g className="dead">
                  <line x1={x(l, s.col) - l.step * 0.25} y1={y(l, s.row) - l.step * 0.25} x2={x(l, s.col) + l.step * 0.25} y2={y(l, s.row) + l.step * 0.25} />
                  <line x1={x(l, s.col) - l.step * 0.25} y1={y(l, s.row) + l.step * 0.25} x2={x(l, s.col) + l.step * 0.25} y2={y(l, s.row) - l.step * 0.25} />
                </g>
              )}
            </g>
          );
        })}
        {point && point !== 'pass' && <g className="board-preview"><circle className={state?.toPlay === 'W' ? 'stone-w' : 'stone-b'} cx={x(l,point.col)} cy={y(l,point.row)} r={l.step*.44}/><circle fill="none" stroke="var(--accent)" strokeWidth="5" cx={x(l,point.col)} cy={y(l,point.row)} r={l.step*.55}/></g>}
        {lastPoint && lastPoint !== 'pass' && (
          <circle className={last?.color === 'B' ? 'mark-on-b' : 'mark-on-w'} cx={x(l, lastPoint.col)} cy={y(l, lastPoint.row)} r={l.step * 0.16} />
        )}
      </svg>
    </div>
  );
}
