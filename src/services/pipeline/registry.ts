import type { StepType, StepHandler } from './types.js';

export class StepHandlerRegistry {
  private handlers = new Map<StepType, StepHandler>();

  register(type: StepType, handler: StepHandler): void {
    if (this.handlers.has(type)) {
      throw new Error(`Handler already registered for type: ${type}`);
    }
    this.handlers.set(type, handler);
  }

  get(type: StepType): StepHandler {
    const handler = this.handlers.get(type);
    if (!handler) {
      throw new Error(`No handler registered for type: ${type}`);
    }
    return handler;
  }

  has(type: StepType): boolean {
    return this.handlers.has(type);
  }

  registeredTypes(): StepType[] {
    return [...this.handlers.keys()];
  }
}
