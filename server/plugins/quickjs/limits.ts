/**
 * Resource limits for plugin QuickJS VMs — defense against runaway or
 * malicious plugins.
 *
 * Plugin VMs get:
 *   • A hard memory ceiling enforced by the QuickJS runtime
 *     (`setMemoryLimit`). Allocations beyond the limit throw an
 *     `OutOfMemory` error inside the VM.
 *   • A bounded stack size (`setMaxStackSize`) so a recursive plugin can't
 *     exhaust the host's WASM stack.
 *   • A wall-clock interrupt per eval call (`shouldInterruptAfterDeadline`).
 *     The VM cooperatively checks the interrupt flag during execution; a
 *     plugin stuck in an infinite loop is aborted within the deadline.
 *
 * Defaults are picked to be invisible for normal plugin work and harsh
 * for runaways. Plugins that legitimately need higher caps will surface
 * memory errors and we can add a per-plugin override field later.
 */

/** 64 MB max heap per plugin VM. */
export const DEFAULT_MEMORY_LIMIT_BYTES = 64 * 1024 * 1024

/** 1 MB max stack — plenty for normal use, fatal for runaway recursion. */
export const DEFAULT_STACK_SIZE_BYTES = 1 * 1024 * 1024

/**
 * 5 second wall-clock deadline per eval call. Lifecycle hooks, route
 * handlers, hook listeners, and loop fetches all use this same budget.
 * If a plugin needs more, it should yield back to the host (e.g. emit
 * progress events) rather than block in a tight loop.
 */
export const DEFAULT_EVAL_TIMEOUT_MS = 5_000
