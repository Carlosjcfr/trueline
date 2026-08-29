/**
 * Dependency-aware rescheduling.
 *
 * When a blocking task moves, its dependents move with it. The rules, mirroring
 * Project Manager's behaviour (MIT, see NOTICE.md) but expressed over the spec's
 * `blockedBy` records so the relationship type and the gap are honoured:
 *
 *  - a dependent never starts before its blocker's constraint date plus the gap;
 *  - a dependent that already had slack keeps it;
 *  - a task's duration is preserved — moving a start moves the due date with it;
 *  - a cycle is refused outright rather than partially applied, because a half-applied
 *    propagation leaves the plan in a state no one asked for and cannot undo in one step.
 */

import type { Dependency, Task } from '../types'
import { durationToDays, toDay, fromDay, type DayNumber } from '../dates'

export interface ScheduleChange {
  path: string
  scheduled?: string
  due?: string
}

export interface ScheduleResult {
  changes: ScheduleChange[]
  /** Paths involved in a dependency cycle. Non-empty means nothing was scheduled. */
  cycle: string[]
}

interface Node {
  task: Task
  start: DayNumber | null
  end: DayNumber | null
  dependsOn: { task: Task; dep: Dependency }[]
}

export function reschedule(
  tasks: Task[],
  resolve: (uid: string, sourcePath: string) => Task | undefined,
  movedPath: string
): ScheduleResult {
  const nodes = new Map<string, Node>()
  for (const task of tasks) {
    nodes.set(task.path, {
      task,
      start: toDay(task.scheduled),
      end: toDay(task.due),
      dependsOn: []
    })
  }

  for (const node of nodes.values()) {
    for (const dep of node.task.blockedBy) {
      const blocker = resolve(dep.uid, node.task.path)
      if (blocker && nodes.has(blocker.path)) node.dependsOn.push({ task: blocker, dep })
    }
  }

  const order = topologicalOrder(nodes)
  if (order.cycle.length) return { changes: [], cycle: order.cycle }

  const changes: ScheduleChange[] = []

  for (const path of order.sorted) {
    const node = nodes.get(path)
    if (!node || path === movedPath) continue

    let earliest: DayNumber | null = null
    for (const { task: blocker, dep } of node.dependsOn) {
      const blockerNode = nodes.get(blocker.path)
      if (!blockerNode) continue
      const anchor = constraintDay(blockerNode, dep)
      if (anchor === null) continue
      const candidate = anchor + durationToDays(dep.gap) + 1
      if (earliest === null || candidate > earliest) earliest = candidate
    }

    if (earliest === null || node.start === null) continue
    // Only push forward. Pulling a task earlier because its blocker finished early is a
    // separate, opt-in behaviour — doing it here would silently compress every plan.
    if (node.start >= earliest) continue

    const duration = node.end !== null ? node.end - node.start : 0
    node.start = earliest
    node.end = node.end !== null ? earliest + duration : null

    changes.push({
      path,
      scheduled: fromDay(node.start),
      ...(node.end !== null ? { due: fromDay(node.end) } : {})
    })
  }

  return { changes, cycle: [] }
}

/** The blocker date a relationship type keys off. */
function constraintDay(blocker: Node, dep: Dependency): DayNumber | null {
  switch (dep.reltype) {
    case 'STARTTOSTART':
    case 'STARTTOFINISH':
      return blocker.start
    default:
      return blocker.end ?? blocker.start
  }
}

function topologicalOrder(nodes: Map<string, Node>): { sorted: string[]; cycle: string[] } {
  const state = new Map<string, 'visiting' | 'done'>()
  const sorted: string[] = []
  const stack: string[] = []

  const visit = (path: string): string[] => {
    const status = state.get(path)
    if (status === 'done') return []
    if (status === 'visiting') {
      // The stack from the first sighting of this node is the cycle itself.
      const from = stack.indexOf(path)
      return stack.slice(from >= 0 ? from : 0).concat(path)
    }

    state.set(path, 'visiting')
    stack.push(path)
    const node = nodes.get(path)
    for (const { task } of node?.dependsOn ?? []) {
      const cycle = visit(task.path)
      if (cycle.length) return cycle
    }
    stack.pop()
    state.set(path, 'done')
    sorted.push(path)
    return []
  }

  for (const path of nodes.keys()) {
    const cycle = visit(path)
    if (cycle.length) return { sorted: [], cycle }
  }
  return { sorted, cycle: [] }
}
