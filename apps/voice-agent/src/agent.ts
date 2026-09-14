// Агент Гоко: промпт + инструменты; при входе в комнату здоровается через generateReply (раздел 9 спеки).
import { voice } from '@livekit/agents';
import { GREETING_INSTRUCTIONS, INSTRUCTIONS } from './prompt.ts';
import type { GokoTools } from './tools.ts';

export class GokoAgent extends voice.Agent {
  readonly greet: boolean;

  constructor(tools: GokoTools, opts: { greet?: boolean } = {}) {
    super({ instructions: INSTRUCTIONS, tools });
    this.greet = opts.greet ?? true;
  }

  override async onEnter(): Promise<void> {
    if (this.greet) this.session.generateReply({ instructions: GREETING_INSTRUCTIONS });
  }
}
