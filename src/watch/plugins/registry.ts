/**
 * Registry for managing Watch plugins.
 */

import type { WatchPlugin } from "../core/types.js"

export class PluginRegistry {
  private plugins: WatchPlugin[] = []

  register(plugin: WatchPlugin): void {
    const existing = this.plugins.find((p) => p.name === plugin.name)
    if (existing) {
      throw new Error(`Plugin already registered: ${plugin.name}`)
    }
    this.plugins.push(plugin)
  }

  getAll(): WatchPlugin[] {
    return [...this.plugins]
  }

  clear(): void {
    this.plugins = []
  }
}

export function createPluginRegistry(): PluginRegistry {
  return new PluginRegistry()
}
