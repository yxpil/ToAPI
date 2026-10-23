export class CancelRegistry {
  private readonly controllers = new Map<string, AbortController>()

  create(id: string): AbortController {
    this.abort(id)
    const controller = new AbortController()
    this.controllers.set(id, controller)
    return controller
  }

  get(id: string): AbortController | undefined {
    return this.controllers.get(id)
  }

  abort(id: string): boolean {
    const existing = this.controllers.get(id)
    if (!existing) return false
    existing.abort()
    this.controllers.delete(id)
    return true
  }

  release(id: string): void {
    this.controllers.delete(id)
  }

  active(): number {
    return this.controllers.size
  }
}
