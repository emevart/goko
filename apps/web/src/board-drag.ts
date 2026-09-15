// Один жест относится к одной версии доски. Отмена/новая позиция не ставят ход.
export class BoardDrag {
  private active: { pointer: number; position: string; coord: string | null } | null = null;
  start(pointer: number, position: string, coord: string | null) {
    if (!this.active) this.active = {pointer,position,coord};
  }
  move(pointer: number, coord: string | null) {
    if (this.active?.pointer === pointer) this.active.coord = coord;
    return this.active?.coord ?? null;
  }
  end(pointer: number, position: string, coord: string | null) {
    if (this.active?.pointer !== pointer) return null;
    const valid = this.active.position === position;
    this.active = null;
    return valid ? coord : null;
  }
  cancel() { this.active = null; }
}
